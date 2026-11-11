import { expect, it } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * A custodial client (it hands the relay its secret key) answers each connection its servers get through its firewall,
 * and HyperDHT holds the handshake, its Noise state and the far peer's request until that answer comes. A client that
 * never answers has the relay deny within `handshakeMs`, and only its share of `handshakes` waits at once.
 */

type Relay = Awaited<ReturnType<typeof startRelay>>;
type Server = { listen(keyPair: unknown): Promise<void>; on(event: "connection", f: (stream: { on(event: string, f: () => void): void; destroy(): void }) => void): void };
type Stream = { once(event: string, f: (...args: unknown[]) => void): Stream; on(event: string, f: (...args: unknown[]) => void): Stream; destroy(): void };
type Held = { _keyPair?: { publicKey: Buffer }; _holepunches: unknown[] };

const until = async (done: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50));
};

/** A custodial client of `relay` listening on a key of its own with `firewall`, and the relay's server for that key. */
async function listener(relay: Relay, firewall: () => Promise<boolean>, sockets: WebSocket[]) {
  const socket = new WebSocket(relay.url);
  sockets.push(socket);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const keyPair = DHT.keyPair();
  const server = (new RelayedDHT(new WebSocketStream(true, socket), { custodial: true }) as { createServer(options: unknown): Server }).createServer({ firewall });
  await server.listen(keyPair);
  const held = ([...relay.dht.listening] as Held[]).find(other => other._keyPair?.publicKey.equals(keyPair.publicKey))!;
  return { keyPair, server, held: () => held._holepunches.filter(Boolean).length };
}

/**
 * A custodial client of a relay with `limits` that never answers its firewall, and `count` dials to it from a native peer
 * on the relay's testnet, each with a key of its own (as a peer that makes up a new one for each dial). `run` gets how
 * many the client was asked about and how many handshakes the relay's server holds.
 */
async function unanswered(limits: Record<string, number>, count: number, run: (on: { asked: () => number; held: () => number; lines: string[]; relay: Relay }) => Promise<void>) {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 3, limits, log: (...words: string[]) => { lines.push(words.join(" ")); } });
  const sockets: WebSocket[] = [];
  const node = new DHT({ bootstrap: relay.bootstrap, host: "127.0.0.1", firewalled: false });
  const dials: Stream[] = [];
  try {
    let asked = 0;
    const { keyPair, held } = await listener(relay, () => { asked++; return new Promise<boolean>(() => {}); }, sockets);
    await node.ready();
    for (let i = 0; i < count; i++) dials.push(node.connect(keyPair.publicKey, { keyPair: DHT.keyPair() }).on("error", () => {}));
    await until(() => held() >= count, 8000);
    expect(held()).toBe(count);
    await run({ asked: () => asked, held, lines, relay });
  } finally {
    for (const dial of dials) dial.destroy();
    await node.destroy();
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}

it("denies a handshake the client never answers within handshakeMs", async () => {
  await unanswered({ handshakeMs: 2000 }, 6, async ({ asked, held, relay }) => {
    expect(asked()).toBe(6);
    // Denied after 2 s, then gone with HyperDHT's own 10 s clear of a denied handshake. Before, every one stayed, with its
    // Noise state and the far peer's request, until the client's listen closed.
    await until(() => held() === 0, 20_000);
    expect(held()).toBe(0);
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
  });
}, 60_000);

it("asks the client about at most a server's share of handshakes at once and denies the rest at once", async () => {
  await unanswered({ handshakes: 8 }, 12, async ({ asked, lines }) => {
    // A server's share is a quarter of `handshakes`, as for a client that runs its own handshakes (see crowded).
    expect(asked()).toBe(2);
    expect(lines).toContain("refused handshake listen share");
  });
}, 60_000);

it("asks the client about at most handshakes less a quarter at once over all its servers", async () => {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 3, limits: { handshakes: 8 }, log: (...words: string[]) => { lines.push(words.join(" ")); } });
  const sockets: WebSocket[] = [];
  const node = new DHT({ bootstrap: relay.bootstrap, host: "127.0.0.1", firewalled: false });
  const dials: Stream[] = [];
  try {
    let asked = 0;
    const socket = new WebSocket(relay.url);
    sockets.push(socket);
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    const client = new RelayedDHT(new WebSocketStream(true, socket), { custodial: true }) as { createServer(options: unknown): Server };
    const keys = [];
    for (let i = 0; i < 4; i++) {
      const keyPair = DHT.keyPair();
      await client.createServer({ firewall: () => { asked++; return new Promise<boolean>(() => {}); } }).listen(keyPair);
      keys.push(keyPair.publicKey);
    }
    await node.ready();
    for (const key of keys) for (let i = 0; i < 2; i++) dials.push(node.connect(key, { keyPair: DHT.keyPair() }).on("error", () => {}));
    const held = () => ([...relay.dht.listening] as Held[]).reduce((sum, server) => sum + server._holepunches.filter(Boolean).length, 0);
    await until(() => held() >= 8, 8000);
    expect(held()).toBe(8);
    // Eight dials, two to each server: six wait on the client, the last two are denied without asking it.
    expect(asked).toBe(6);
    expect(lines).toContain("refused handshake incoming");
  } finally {
    for (const dial of dials) dial.destroy();
    await node.destroy();
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}, 60_000);

it("connects a custodial client that answers its firewall in time", async () => {
  const relay = await startRelay({ testnet: 3, limits: { handshakeMs: 2000 } });
  const sockets: WebSocket[] = [];
  const node = new DHT({ bootstrap: relay.bootstrap, host: "127.0.0.1", firewalled: false });
  try {
    const { keyPair, server } = await listener(relay, () => new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)), sockets);
    const reached = new Promise(resolve => server.on("connection", stream => { stream.on("error", () => {}); resolve("connection"); }));
    await node.ready();
    const dial = node.connect(keyPair.publicKey).on("error", () => {});
    const result = await Promise.race([
      new Promise(resolve => dial.once("open", () => resolve("open"))),
      new Promise(resolve => dial.once("error", (error: Error) => resolve(`error: ${error.message}`))),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 20_000)),
    ]);
    expect(result).toBe("open");
    await expect(reached).resolves.toBe("connection");
    dial.destroy();
  } finally {
    await node.destroy();
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}, 60_000);
