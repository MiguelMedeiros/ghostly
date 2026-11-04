import { expect, it, vi } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { refusalLines, startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

type Server = { listen(keyPair: unknown): Promise<void>; close(): Promise<void> };

/**
 * A client that repeats what the relay refuses or drops it for writes a few lines of each kind a minute, then one line
 * with the count: the container keeps 15 MB of log, and a line per attempt would rotate the rest of it away in seconds.
 */
const open = (url: string) => new Promise<WebSocket>((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => resolve(socket), { once: true });
  socket.addEventListener("error", () => reject(new Error("refused")), { once: true });
});

it("writes a few lines a minute for upgrades refused from one address, however many come", async () => {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 2, limits: { clientsPerAddress: 1 }, log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
  const sockets: WebSocket[] = [];
  try {
    sockets.push(await open(relay.url));
    const refused = await Promise.allSettled(Array.from({ length: 200 }, () => open(relay.url)));
    expect(refused.every(result => result.status === "rejected")).toBe(true);
    expect(relay.stats().refused).toBe(200);
    expect(lines.filter(line => line === "refused address")).toHaveLength(5);
    expect(lines.filter(line => line.startsWith("refused"))).toHaveLength(5);
  } finally {
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}, 30_000);

it("writes a few lines a minute for listens refused on a key another client holds, however many come", async () => {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 2, log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
  const sockets: WebSocket[] = [];
  const client = async () => {
    const socket = await open(relay.url);
    sockets.push(socket);
    return new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): Server };
  };
  try {
    const key = DHT.keyPair();
    await (await client()).createServer().listen(key);
    const asking = await client();
    for (let i = 0; i < 30; i++) {
      const server = asking.createServer();
      await server.listen(key);
      await server.close().catch(() => {});
    }
    await vi.waitFor(() => expect(lines.filter(line => line === "refused listen KEYPAIR_ALREADY_USED").length).toBeGreaterThanOrEqual(5));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(lines.filter(line => line === "refused listen KEYPAIR_ALREADY_USED")).toHaveLength(5);
    expect(relay.stats()).toMatchObject({ clients: 2, dropped: 0 });
  } finally {
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}, 60_000);

it("writes a few lines a minute for clients dropped for one reason, however many", async () => {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 2, limits: { clientsPerAddress: 64 }, log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
  try {
    // A topic lookup drops the client that asks.
    for (let i = 0; i < 20; i++) {
      const socket = await open(relay.url);
      const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
      const dht = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { lookup(topic: Buffer): { on(event: string, f: () => void): void } };
      dht.lookup(Buffer.alloc(32, i)).on("error", () => {});
      await closed;
    }
    await vi.waitFor(() => expect(relay.stats().dropped).toBe(20));
    expect(lines.filter(line => line === "dropped topic query")).toHaveLength(5);
  } finally {
    await relay.close();
  }
}, 60_000);

it("after the first lines of a kind, says once a minute how many it left out, and keeps every other kind apart", () => {
  const lines: string[] = [];
  const log = refusalLines((...words: unknown[]) => { lines.push(words.join(" ")); }, { most: 2 });
  for (let i = 0; i < 10; i++) log.line("refused", "address");
  log.line("dropped", "idle");
  expect(lines).toEqual(["refused address", "refused address", "dropped idle"]);
  log.flush();
  expect(lines.slice(3)).toEqual(["refused address (8 more this minute, not logged)"]);
  // A kind still flooding past its minute writes only its count: one line a minute.
  for (let i = 0; i < 50; i++) log.line("refused", "address");
  log.flush();
  expect(lines.slice(4)).toEqual(["refused address (50 more this minute, not logged)"]);
  // A kind that went quiet writes its first lines again.
  log.flush();
  log.line("refused", "address");
  log.line("dropped", "idle");
  expect(lines.slice(5)).toEqual(["refused address", "dropped idle"]);
});
