import { expect, it } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { DEFAULT_LIMITS, relayWindow, startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
type Server = { listen(keyPair: KeyPair): Promise<void>; close(): Promise<void> };
type Relay = Awaited<ReturnType<typeof startRelay>>;

async function client(relay: Relay) {
  const socket = new WebSocket(relay.url);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  return { socket, node: new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): Server } };
}

/** `apps` browsers on one relay, each with `listens` chats listening (non-custodial: each signs for its keys). */
async function listening(relay: Relay, apps: number, listens: number) {
  const clients = await Promise.all(Array.from({ length: apps }, () => client(relay)));
  const started = performance.now();
  await Promise.all(clients.flatMap(({ node }) => Array.from({ length: listens }, () => node.createServer().listen(DHT.keyPair()))));
  return { clients, ms: performance.now() - started };
}

it("sizes the node's congestion window from the relay's limits: one app's 80 at least, a ceiling at most", () => {
  expect(relayWindow(DEFAULT_LIMITS)).toBe(2048);
  expect(relayWindow({ clients: 64, listens: 16 })).toBe(512);
  expect(relayWindow({ clients: 4, listens: 8 })).toBe(80);
  expect(relayWindow({ clients: 1_000_000, listens: 16 })).toBe(2048);
});

/**
 * A relay full to its own limits, every announcer started at once as after a restart: on a window of listens / 12 (86
 * here) 1,024 listens' keep-alives never left the queue (400 to 900 waiting at every look), and at the defaults' 8,192
 * listens the queue grew past 40,000. The window from the relay's own limits empties it after the start's burst, and a
 * later burst waits a tick or two at most.
 */
it("keeps the keep-alives of a relay full to its own limits moving", async () => {
  const limits = { clients: 64, listens: 16, clientsPerAddress: 64 };
  const relay = await startRelay({ testnet: 8, limits });
  try {
    const { clients } = await listening(relay, limits.clients, limits.listens);
    expect(relay.dht.listening.size).toBe(1024);
    expect(relay.dht.io.congestion._maxWindow).toBe(relayWindow(limits));
    // The start's own burst drains first, the queue empty for a second; on a busy runner that takes longer than 5 s, and it
    // may be empty for a moment between two of its ticks. On a window too small it never is.
    await new Promise(resolve => setTimeout(resolve, 5_000));
    let empty = 0;
    await expect.poll(() => (empty = relay.dht.io._pending.length === 0 ? empty + 1 : 0), { timeout: 30_000, interval: 100 })
      .toBeGreaterThanOrEqual(10);
    const samples: number[] = [];
    const sampling = setInterval(() => { samples.push(relay.dht.io._pending.length); }, 100);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    clearInterval(sampling);
    // A burst of keep-alives may wait a tick (750 ms) or two on a busy runner (12 looks in 99 found one waiting there),
    // then the queue is empty again. So the longest run of looks that found it waiting, at most the window's 4 ticks.
    let run = 0;
    let longest = 0;
    for (const waiting of samples) {
      run = waiting === 0 ? 0 : run + 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(30);
    expect(samples.filter(waiting => waiting === 0).length).toBeGreaterThanOrEqual(samples.length / 2);
    for (const { socket } of clients) socket.close();
  } finally {
    await relay.close();
  }
}, 120_000);

/**
 * Every client shares the relay's one node and its window: on dht-rpc's default (80 requests per 750 ms tick) 256 listens
 * asked for at once, as 16 apps re-listening after a restart, came up 80 per tick, the last after about 10 s.
 */
it("brings 256 listens asked for at once up within about 2 s", async () => {
  const relay = await startRelay({ testnet: 8 });
  try {
    const { clients, ms } = await listening(relay, 16, 16);
    expect(relay.dht.listening.size).toBe(256);
    expect(ms).toBeLessThan(2_000);
    expect(relay.dht.io.congestion._maxWindow).toBe(relayWindow(DEFAULT_LIMITS));
    for (const { socket } of clients) socket.close();
  } finally {
    await relay.close();
  }
}, 60_000);

/**
 * Each listen's announcer pings its three nodes every 3 s, about one request a second per listen: a window too small for
 * them leaves the pings waiting in the node's queue, longer and longer, until announcements lapse.
 */
it("keeps no keep-alive waiting while 512 listens idle", async () => {
  // All of them on loopback, one address: only the per-address limit is lifted, the window comes from the defaults.
  const relay = await startRelay({ testnet: 8, limits: { clientsPerAddress: 32 } });
  try {
    const { clients } = await listening(relay, 32, 16);
    let most = 0;
    const sampling = setInterval(() => { most = Math.max(most, relay.dht.io._pending.length); }, 100);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    clearInterval(sampling);
    expect(relay.dht.listening.size).toBe(512);
    expect(most).toBe(0);
    for (const { socket } of clients) socket.close();
  } finally {
    await relay.close();
  }
}, 90_000);
