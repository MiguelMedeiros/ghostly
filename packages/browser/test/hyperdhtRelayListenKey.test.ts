import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { createIdentity, fromBase64Url } from "@ghostly/core";
import { createRelayedHyperEndpoint, hyperKeyPair } from "../src/platform/hyperdhtRelay";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";
// covers: transport.hyperdht-relay

/**
 * A listen through the relay counts only once the relay has checked the client's own signature for the key: a client
 * that knows a chat's public key (its descriptor carries it) but not its secret key gets no listen on it, and the
 * chat's own endpoint still listens there and is reached.
 */

type Server = { listen(keyPair: unknown): Promise<void>; address(): { port: number } | null; once(event: "close", f: () => void): void };
type Relay = Awaited<ReturnType<typeof startRelay>>;

async function client(relay: Relay, sockets: WebSocket[]) {
  const socket = new WebSocket(relay.url);
  sockets.push(socket);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  return new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): Server };
}

/** A native HyperDHT peer on the relay's network dials `publicKey`: "open" (a Noise handshake only the key's holder completes), or why not. */
async function dial(relay: Relay, publicKey: Uint8Array) {
  const node = new DHT({ bootstrap: relay.bootstrap, host: "127.0.0.1", firewalled: false });
  try {
    await node.ready();
    const socket = node.connect(Buffer.from(publicKey));
    const result = await Promise.race([
      new Promise(resolve => socket.once("open", () => resolve("open"))),
      new Promise(resolve => socket.once("error", (error: Error) => resolve(`error: ${error.message}`))),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 20_000)),
    ]);
    socket.destroy();
    return result;
  } finally {
    await node.destroy();
  }
}

it("lets a chat's endpoint listen on its own key, and a native peer reaches it", async () => {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 3, log: (...words: string[]) => { lines.push(words.join(" ")); } });
  const seedB64 = createIdentity().seedB64;
  const endpoint = await createRelayedHyperEndpoint(seedB64, relay.url);
  try {
    expect(await dial(relay, hyperKeyPair(fromBase64Url(seedB64)).publicKey)).toBe("open");
    expect(lines.filter(line => line.startsWith("refused listen"))).toEqual([]);
  } finally {
    await endpoint.close();
    await relay.close();
  }
}, 60_000);

it("refuses a listen on a key whose secret the client does not hold, and the key's owner then listens and is reached", async () => {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 3, log: (...words: string[]) => { lines.push(words.join(" ")); } });
  const sockets: WebSocket[] = [];
  const seedB64 = createIdentity().seedB64;
  const { publicKey } = hyperKeyPair(fromBase64Url(seedB64));
  let endpoint: Awaited<ReturnType<typeof createRelayedHyperEndpoint>> | null = null;
  try {
    // The chat's public key, as its descriptor gives it, with a made-up secret key: every signature it makes is wrong.
    const other = (await client(relay, sockets)).createServer();
    const closed = new Promise<string>(resolve => other.once("close", () => resolve("closed")));
    await other.listen({ publicKey: Buffer.from(publicKey), secretKey: randomBytes(64) });
    // Refused as a key another client holds is: listening at no address, then closed.
    expect(other.address()?.port).toBe(0);
    await expect(Promise.race([closed, new Promise(resolve => setTimeout(() => resolve("open"), 5000))])).resolves.toBe("closed");
    expect(lines).toContain("refused listen unsigned");

    endpoint = await createRelayedHyperEndpoint(seedB64, relay.url);
    expect(await dial(relay, publicKey)).toBe("open");
    expect(relay.stats()).toMatchObject({ dropped: 0 });
  } finally {
    await endpoint?.close().catch(() => {});
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}, 60_000);

it("checks the key without another node, so a relay whose node reaches none still refuses it, custodial or not, and lets the owner listen", async () => {
  const lines: string[] = [];
  // A closed port: what a host with no outgoing UDP sees of every node. Its node never asks anyone to sign.
  const relay = await startRelay({ bootstrap: ["127.0.0.1:1"], log: (...words: string[]) => { lines.push(words.join(" ")); } });
  const sockets: WebSocket[] = [];
  try {
    const owner = DHT.keyPair();
    for (const custodial of [false, true]) {
      const socket = new WebSocket(relay.url);
      sockets.push(socket);
      await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
      const other = (new RelayedDHT(new WebSocketStream(true, socket), { custodial }) as { createServer(): Server }).createServer();
      const closed = new Promise<string>(resolve => other.once("close", () => resolve("closed")));
      await other.listen({ publicKey: owner.publicKey, secretKey: randomBytes(64) });
      await expect(Promise.race([closed, new Promise(resolve => setTimeout(() => resolve("open"), 5000))]), custodial ? "custodial" : "non-custodial").resolves.toBe("closed");
    }
    expect(lines.filter(line => line.startsWith("refused listen"))).toEqual(["refused listen unsigned", "refused listen unsigned"]);
    const server = (await client(relay, sockets)).createServer();
    const closed = new Promise<string>(resolve => server.once("close", () => resolve("closed")));
    await server.listen(owner);
    await expect(Promise.race([closed, new Promise(resolve => setTimeout(() => resolve("open"), 2000))])).resolves.toBe("open");
    expect(lines.filter(line => line.startsWith("refused listen"))).toHaveLength(2);
  } finally {
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}, 60_000);
