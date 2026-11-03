import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array | null };
type Server = { listen(keyPair: KeyPair): Promise<void>; close(): Promise<void>; once(event: "close", f: () => void): void };
type Relay = Awaited<ReturnType<typeof startRelay>>;

async function client(relay: Relay) {
  const socket = new WebSocket(relay.url);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
  return { socket, closed, node: new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): Server } };
}

const within = (closed: Promise<unknown>) => Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5_000))]);

/** One listen and its close, as a page that opens and closes a chat's listener; a refused one closes by itself. */
async function cycle(node: { createServer(): Server }, keyPair: KeyPair, refused = false) {
  const server = node.createServer();
  const closed = new Promise(resolve => server.once("close", resolve));
  await server.listen(keyPair);
  if (!refused) await server.close();
  await closed;
}

it("drops a client that starts more listens a minute than `listensPerMinute`, closed or refused, and serves the next", async () => {
  const reasons: string[] = [];
  const relay = await startRelay({ testnet: 2, limits: { listensPerMinute: 5 }, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  try {
    const churner = await client(relay);
    // Never more than one open at once: only the rate stops it.
    for (let i = 0; i < 5; i++) await cycle(churner.node, DHT.keyPair());
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
    void churner.node.createServer().listen(DHT.keyPair()).catch(() => {});
    await within(churner.closed);
    expect(reasons).toContain("dropped listen rate");
    expect(relay.stats()).toMatchObject({ clients: 0, dropped: 1 });
    // Refused listens (a key another client holds) count too: they cost the relay as much.
    const holder = await client(relay);
    const held = DHT.keyPair();
    await holder.node.createServer().listen(held);
    const asking = await client(relay);
    for (let i = 0; i < 5; i++) await cycle(asking.node, { publicKey: held.publicKey, secretKey: null }, true);
    void asking.node.createServer().listen({ publicKey: held.publicKey, secretKey: null }).catch(() => {});
    await within(asking.closed);
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 2 });
    holder.socket.close();
  } finally {
    await relay.close();
  }
}, 60_000);

it("keeps nothing of a listen once it has closed, while its client stays", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const relay = await startRelay({ testnet: 2, limits: { listensPerMinute: 10_000 } });
  // Every HyperDHT server the relay runs for its clients, weakly: one still there after a collection is held.
  const servers: WeakRef<object>[] = [];
  const create = relay.dht.createServer.bind(relay.dht);
  relay.dht.createServer = (...args: Parameters<typeof create>) => { const server = create(...args); servers.push(new WeakRef(server)); return server; };
  try {
    const holder = await client(relay);
    const held = DHT.keyPair();
    await holder.node.createServer().listen(held);
    const churner = await client(relay);
    for (let i = 0; i < 100; i++) await cycle(churner.node, DHT.keyPair());
    for (let i = 0; i < 300; i++) await cycle(churner.node, { publicKey: held.publicKey, secretKey: null }, true);
    for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 50)); gc(); }
    expect(relay.stats()).toMatchObject({ clients: 2, dropped: 0 });
    // The holder's server is the one still open.
    expect(servers.filter(server => server.deref()).length).toBe(1);
    holder.socket.close();
    churner.socket.close();
  } finally {
    await relay.close();
  }
}, 60_000);
