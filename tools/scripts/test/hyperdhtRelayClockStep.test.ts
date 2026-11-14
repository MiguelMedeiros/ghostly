import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * The relay's per-client budgets read a monotonic clock: the host's wall clock set back (an NTP step, an operator fixing
 * a clock that ran ahead) neither stops reading a client for the length of the step, so that it misses its pongs and is
 * dropped, nor keeps the listens it started before the step in its minute.
 */

const HOUR = 3_600_000;

/** The wall clock, from now on, `ms` off where it is (negative: set back). */
const stepClock = (ms: number) => {
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + ms);
};
/** `ms` more of real time gone by, as a monotonic clock sees it. */
const elapse = (ms: number) => {
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + ms);
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => { vi.restoreAllMocks(); await close?.(); close = undefined; });

it("keeps reading a client and answering its pings after the clock is set back an hour", async () => {
  const relay = await startRelay({ testnet: 2, limits: { pingMs: 500 } });
  close = relay.close;
  const ws = new WebSocket(relay.url);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  try {
    let pongs = 0;
    ws.on("pong", () => { pongs++; });
    ws.ping();
    await vi.waitFor(() => expect(pongs).toBe(1));
    stepClock(-HOUR);
    ws.ping();
    // Before: the refill read an hour back as -1.8 GiB of budget, the relay stopped reading the client for that hour,
    // and its pongs went unread, so it was dropped at the next ping ("no pong").
    await vi.waitFor(() => expect(pongs).toBe(2), { timeout: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
  } finally {
    ws.terminate();
  }
}, 30_000);

it("lets a client listen again a minute after its listens per minute, though the clock was set back an hour meanwhile", async () => {
  const relay = await startRelay({ testnet: 2, limits: { listensPerMinute: 3 } });
  close = relay.close;
  // The browser's WebSocket, as the app's client uses it.
  const socket = new globalThis.WebSocket(relay.url);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
  try {
    const node = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as {
      createServer(): { listen(keyPair: unknown): Promise<void>; close(): Promise<void> };
    };
    for (let i = 0; i < 3; i++) {
      const server = node.createServer();
      await server.listen(DHT.keyPair());
      await server.close();
    }
    // A minute and a second go by while the wall clock is set back an hour.
    elapse(61_000);
    stepClock(-(HOUR - 61_000));
    // Before: the three listens before the step stayed in the minute for the hour, and this one dropped the client.
    let listening = false;
    void node.createServer().listen(DHT.keyPair()).then(() => { listening = true; }, () => {});
    await Promise.race([closed, vi.waitFor(() => expect(listening).toBe(true), { timeout: 5_000 })]);
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
  } finally {
    socket.close();
  }
}, 30_000);
