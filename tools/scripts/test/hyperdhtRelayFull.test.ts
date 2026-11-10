import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { DEFAULT_LIMITS, startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * A full relay still lets a new address in: a few addresses that filled it, each client holding one listen and answering
 * every ping (never idle, never silent), give way one client at a time to the addresses that come after them.
 */

type Server = { listen(keyPair: unknown): Promise<void> };
type Relay = Awaited<ReturnType<typeof startRelay>>;

/**
 * A client from `address` (behind one proxy) that listens once on a key of its own and otherwise only answers the relay's
 * pings, as a WebSocket does by itself. Resolves once its listen has.
 */
async function holder(relay: Relay, address: string) {
  const socket = new WebSocket(relay.url, { headers: { "x-forwarded-for": address } } as never);
  let closed = false;
  socket.addEventListener("close", () => { closed = true; });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`${address} was refused`)), { once: true });
  });
  const node = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): Server };
  // A client the relay drops before its listen resolves fails here rather than at the test's timeout.
  const dropped = new Promise((_, reject) => socket.addEventListener("close", () => reject(new Error(`${address} was dropped`)), { once: true }));
  dropped.catch(() => {});
  await Promise.race([node.createServer().listen(DHT.keyPair()), dropped]);
  return { socket, open: () => !closed };
}

/** The code the relay answers an upgrade from `address` with (101: a WebSocket, closed again at once). */
const upgrade = (relay: Relay, address: string, key = randomBytes(16).toString("base64")) => new Promise<number>((resolve, reject) => {
  const socket = connect(relay.port, "127.0.0.1");
  socket.on("error", reject);
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: ${address}\r\n\r\n`);
  socket.once("data", chunk => { socket.destroy(); resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(chunk.toString("latin1"))?.[1])); });
});

it("lets a new address in on a relay its first few addresses filled, each client holding one listen and answering pings", async () => {
  const { clients, clientsPerAddress } = DEFAULT_LIMITS;
  const reasons: string[] = [];
  const relay = await startRelay({ testnet: 3, port: 6040, proxies: 1, limits: { idleMs: 4_000, pingMs: 2_000 }, log: (...words: unknown[]) => { reasons.push(words.join(" ")); } });
  const held: Awaited<ReturnType<typeof holder>>[] = [];
  const gone = () => held.filter(client => !client.open());
  try {
    // 32 addresses with 16 clients each: the whole relay.
    for (let a = 0; a < clients / clientsPerAddress; a++) {
      held.push(...await Promise.all(Array.from({ length: clientsPerAddress }, () => holder(relay, `10.0.0.${a + 1}`))));
    }
    expect(relay.stats()).toMatchObject({ clients, dropped: 0 });
    // Past the idle timeout and a few pings, none has gone: each holds a listen and answers.
    await new Promise(resolve => setTimeout(resolve, 6_000));
    expect(relay.stats()).toMatchObject({ clients, dropped: 0 });

    // An upgrade the relay cannot complete (no key) from a new address drops nobody.
    expect(await upgrade(relay, "10.0.3.1", "")).toBeGreaterThanOrEqual(400);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(relay.stats()).toMatchObject({ clients, dropped: 0 });

    // A 33rd address gets in, in place of the oldest client of an address holding the most.
    expect(await upgrade(relay, "10.0.1.1")).toBe(101);
    await vi.waitFor(() => expect(gone()).toHaveLength(1));
    expect(held.indexOf(gone()[0])).toBeLessThan(clientsPerAddress);
    expect(reasons).toContain("dropped room");
    await vi.waitFor(() => expect(relay.stats().clients).toBe(clients - 1));

    // A household behind one address gets in too: the slot that came free, then one in place of another address's
    // client, and one more each time `ROOM_MS` (10 s) has passed.
    const household = [await holder(relay, "10.0.2.1"), await holder(relay, "10.0.2.1")];
    expect(relay.stats().clients).toBe(clients);
    await vi.waitFor(() => expect(gone()).toHaveLength(2));
    expect(await upgrade(relay, "10.0.2.1")).toBe(503);
    // An address that lost a client cannot take it back from one holding no more than it would.
    expect(await upgrade(relay, "10.0.0.1")).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    household.push(await holder(relay, "10.0.2.1"));
    await vi.waitFor(() => expect(gone()).toHaveLength(3));
    expect(new Set(gone().map(client => Math.floor(held.indexOf(client) / clientsPerAddress))).size).toBe(3);
    expect(household.every(client => client.open())).toBe(true);
    expect(relay.stats().clients).toBe(clients);
    for (const client of household) client.socket.close();
  } finally {
    for (const client of held) client.socket.close();
    await relay.close();
  }
}, 180_000);
