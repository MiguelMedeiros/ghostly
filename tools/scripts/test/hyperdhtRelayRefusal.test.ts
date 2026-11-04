import { expect, it } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

type Server = { listen(keyPair: unknown): Promise<void>; address(): { port: number } | null; once(event: "close", f: () => void): void };

it("answers a listen on a key another client listens on: listening at no address, then closed, and the holder stays", async () => {
  const reasons: string[] = [];
  const relay = await startRelay({ testnet: 2, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  const sockets: WebSocket[] = [];
  const client = async () => {
    const socket = new WebSocket(relay.url);
    sockets.push(socket);
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    return new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): Server };
  };
  try {
    const key = DHT.keyPair();
    const holder = (await client()).createServer();
    await holder.listen(key);
    expect(holder.address()?.port).toBeGreaterThan(0);
    const asking = (await client()).createServer();
    const closed = new Promise<string>(resolve => asking.once("close", () => resolve("closed")));
    const started = Date.now();
    // dht-relay's client hears a `closed` only for a server that has had `listening`: both come, the first at no address.
    await expect(Promise.race([asking.listen(key).then(() => "listening"), new Promise(resolve => setTimeout(() => resolve("pending"), 5000))])).resolves.toBe("listening");
    expect(asking.address()?.port).toBe(0);
    await expect(Promise.race([closed, new Promise(resolve => setTimeout(() => resolve("open"), 5000))])).resolves.toBe("closed");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(reasons).toContain("refused listen KEYPAIR_ALREADY_USED");
    expect(relay.stats()).toMatchObject({ clients: 2, dropped: 0 });
  } finally {
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}, 30_000);
