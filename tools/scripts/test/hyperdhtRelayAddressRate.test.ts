import { expect, it } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * `listensPerMinute` and `connectsPerMinute` are each client's, and an address holds at most `clientsPerAddress` clients:
 * an address starts at most their product a minute, however often its clients close and come back.
 */

type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array | null };
type Server = { listen(keyPair: KeyPair): Promise<void>; close(): Promise<void>; once(event: "close", f: () => void): void };
type Node = { createServer(): Server; connect(publicKey: Uint8Array): { on(event: "error", f: () => void): unknown } };
type Relay = Awaited<ReturnType<typeof startRelay>>;

/** A client from `address` (behind one proxy); `closed` resolves once the relay has dropped it or it has closed. */
async function client(relay: Relay, address: string) {
  const socket = new WebSocket(relay.url, { headers: { "x-forwarded-for": address } } as never);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  let open = true;
  const closed = new Promise(resolve => socket.addEventListener("close", () => { open = false; resolve(null); }, { once: true }));
  return { socket, closed, open: () => open, node: new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as Node };
}

const within = (closed: Promise<unknown>, ms = 2_000) => Promise.race([closed, new Promise(resolve => setTimeout(resolve, ms))]);

/** One listen and its close; a client dropped meanwhile ends it. */
async function cycle(churner: Awaited<ReturnType<typeof client>>) {
  const server = churner.node.createServer();
  const closed = new Promise(resolve => server.once("close", resolve));
  await Promise.race([server.listen(DHT.keyPair()).then(() => server.close()).then(() => closed), churner.closed]);
}

it("counts an address's listens and dials over all its clients, the ones it has closed too, and serves another address", async () => {
  const reasons: string[] = [];
  const relay = await startRelay({
    testnet: 2, proxies: 1, limits: { listensPerMinute: 5, connectsPerMinute: 3, clientsPerAddress: 2 },
    log: (what: string, why: string) => { reasons.push(`${what} ${why}`); },
  });
  // Every listen and dial the relay's node starts for its clients.
  let listens = 0;
  let dials = 0;
  const createServer = relay.dht.createServer.bind(relay.dht);
  relay.dht.createServer = (...args: Parameters<typeof createServer>) => { listens++; return createServer(...args); };
  const connect = relay.dht.connect.bind(relay.dht);
  relay.dht.connect = (...args: Parameters<typeof connect>) => { dials++; return connect(...args); };
  try {
    // One listen open at a time, each client within its own 5 a minute, each closed after its 5: 30 rounds.
    let dropped = 0;
    for (let round = 0; round < 30; round++) {
      const churner = await client(relay, "203.0.113.7");
      for (let i = 0; i < 5 && churner.open(); i++) await cycle(churner);
      if (!churner.open()) dropped++;
      churner.socket.close();
      await within(churner.closed);
    }
    // 2 clients × 5 listens: the 11th is refused, and every round after it.
    expect(listens).toBe(10);
    expect(dropped).toBe(28);
    expect(reasons).toContain("dropped address listen rate: 10 listens a minute from one address (GHOSTLY_RELAY_LISTENS_PER_MINUTE × GHOSTLY_RELAY_CLIENTS_PER_ADDRESS)");

    // Dials the same way: 2 clients × 3 a minute.
    for (let round = 0; round < 4; round++) {
      const dialler = await client(relay, "198.51.100.9");
      for (let i = 0; i < 3 && dialler.open(); i++) {
        dialler.node.connect(DHT.keyPair().publicKey).on("error", () => {});
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      dialler.socket.close();
      await within(dialler.closed);
    }
    expect(dials).toBe(6);
    expect(reasons).toContain("dropped address dial limit: 6 dials a minute from one address (GHOSTLY_RELAY_CONNECTS_PER_MINUTE × GHOSTLY_RELAY_CLIENTS_PER_ADDRESS)");

    // Another address still listens.
    const other = await client(relay, "192.0.2.44");
    await cycle(other);
    expect(other.open()).toBe(true);
    expect(listens).toBe(11);
    other.socket.close();
  } finally {
    await relay.close();
  }
}, 120_000);
