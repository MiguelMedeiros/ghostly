import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createIdentity, type BoundChannel, type NativeEndpoint } from "@ghostly/core";
import { createRelayedHyperEndpoint } from "../src/platform/hyperdhtRelay";
// covers: transport.hyperdht-relay

/**
 * dht-relay 0.4.3's client node keeps each dial's Noise handshake (about 1.9 KB) in its `_handshakes` until the dial opens,
 * and never removes it when the dial fails after its noise step: a contact's Desktop that has just quit, a peer that
 * refuses. A page that dials an offline contact again and again kept one per dial until the relay connection went. A real
 * dht-relay (infra/services/hyperdht-relay) on a HyperDHT network of its own, against the Desktop's endpoint and a bare
 * HyperDHT peer.
 */

type Relay = { url: string; bootstrap: string[]; close(): Promise<void> };
type Handshakes = Map<unknown, unknown>;
type Socket = { once(event: string, listener: () => void): unknown; rawStream?: { _node?: { _handshakes?: Handshakes } } };
type FarSocket = { write(data: Uint8Array): boolean; on(event: string, listener: (...args: never[]) => void): unknown; destroy(): void };
type FarServer = { listen(keyPair: unknown): Promise<void>; close(): Promise<void> };
type FarNode = {
  createServer(options: { firewall(remotePublicKey: Uint8Array, payload: { udx?: { id?: number } | null }): boolean | Promise<boolean> }, onConnection: (socket: FarSocket) => void): FarServer;
  destroy(): Promise<void>;
};
type DHTModule = { new (options: object): FarNode & { ready(): Promise<void> }; keyPair(): { publicKey: Uint8Array } };

const PREFACE = "ghostly/paired-chat/1";
let relay: Relay;
let browser: NativeEndpoint;
let native: NativeEndpoint;
let DHT: DHTModule;
let far: FarNode;
let bootstrap: { host: string; port: number }[];
/** The browser's relay node's handshakes, found under its first dialled stream. */
let handshakes: Handshakes;
const seed = () => createIdentity().seedB64;
const socketOf = (bound: BoundChannel) => (bound.channel as unknown as { socket: Socket }).socket;
const incoming = (endpoint: NativeEndpoint) => new Promise<BoundChannel>(resolve => { endpoint.onConnection = resolve; });
const next = (bound: BoundChannel) => new Promise<string>(resolve => { bound.channel.onMessage = text => resolve(String(text)); });
const keyHex = (key: Uint8Array) => Buffer.from(key).toString("hex");
const frame = (text: string) => {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, 4);
  return out;
};

beforeAll(async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  // Dials past the relay's 60 a minute drop the connection: this file dials more than that.
  relay = await startRelay({ testnet: 3, limits: { connectsPerMinute: 1000 } });
  browser = await createRelayedHyperEndpoint(seed(), relay.url);
  bootstrap = relay.bootstrap.map(node => { const [host, port] = node.split(":"); return { host, port: Number(port) }; });
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  native = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: "127.0.0.1" }) as NativeEndpoint;
  DHT = (await import("hyperdht")).default as unknown as DHTModule;
  const node = new DHT({ bootstrap, host: "127.0.0.1", firewalled: false });
  await node.ready();
  far = node;
  // A first stream, so both ends are up before anything is counted.
  const socket = await roundTrip(browser, native);
  expect(socket.rawStream?._node?._handshakes, "dht-relay's node keeps its handshakes at _handshakes").toBeInstanceOf(Map);
  handshakes = socket.rawStream!._node!._handshakes!;
}, 60_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), native?.close(), far?.destroy()]);
  await relay?.close();
});

/** One stream from `from` to `to`: it opens, carries a message each way, and the dialler closes it. */
async function roundTrip(from: NativeEndpoint, to: NativeEndpoint): Promise<Socket> {
  const accepted = incoming(to);
  // The Desktop stops announcing its key while it has a live chat, and announces it again once that closes.
  const dialled = await vi.waitFor(() => from.connect(to.descriptor), { timeout: 20_000, interval: 100 });
  const answered = await accepted;
  to.onConnection = null;
  expect(dialled.binding).toEqual(answered.binding);
  const heard = next(answered);
  dialled.channel.send("ping");
  expect(await heard).toBe("ping");
  const back = next(dialled);
  answered.channel.send("pong");
  expect(await back).toBe("pong");
  const socket = socketOf(from === browser ? dialled : answered);
  const closed = new Promise<void>(resolve => socket.once("close", resolve));
  dialled.channel.close();
  await closed;
  return socket;
}

/**
 * A bare HyperDHT peer that speaks the chat preface and answers "ping" with "pong". `deny` says, per dial (the relay's
 * raw stream id, the same on every attempt of one dial), whether its firewall refuses it.
 */
async function farPeer(deny: (dial: number | undefined) => boolean | Promise<boolean>): Promise<{ key: string; close(): Promise<void> }> {
  const keyPair = DHT.keyPair();
  const server = far.createServer({ firewall: (_key, payload) => deny(payload?.udx?.id) }, socket => {
    socket.on("error", () => {});
    socket.write(frame(PREFACE));
    let heard = "";
    socket.on("data", (chunk: Uint8Array) => {
      heard += Buffer.from(chunk).toString("latin1");
      if (heard.includes("ping")) { heard = ""; socket.write(frame("pong")); }
    });
  });
  await server.listen(keyPair);
  return { key: keyHex(keyPair.publicKey), close: () => server.close() };
}

it("a dial to a Desktop that has just quit leaves no handshake behind", async () => {
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const desktop = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: "127.0.0.1" }) as NativeEndpoint;
  await roundTrip(browser, desktop);
  const before = handshakes.size;
  const descriptor = desktop.descriptor;
  await desktop.close();
  // The relay still knows the route: each dial sends its noise step, then hears PEER_NOT_FOUND.
  for (let i = 0; i < 5; i++) await expect(browser.connect(descriptor)).rejects.toThrow(/PEER_NOT_FOUND|closed/);
  await vi.waitFor(() => expect(handshakes.size).toBe(before), { timeout: 5000 });
  // The endpoint still dials and is dialled as before.
  await roundTrip(browser, native);
  await roundTrip(native, browser);
  expect(handshakes.size).toBe(before);
}, 90_000);

it("a dial the far peer refuses leaves no handshake behind", async () => {
  const peer = await farPeer(() => true);
  const before = handshakes.size;
  try {
    for (let i = 0; i < 3; i++) await expect(browser.connect({ publicKey: peer.key })).rejects.toThrow(/PEER_CONNECTION_FAILED|closed/);
    await vi.waitFor(() => expect(handshakes.size).toBe(before), { timeout: 5000 });
  } finally { await peer.close(); }
  await roundTrip(browser, native);
  expect(handshakes.size).toBe(before);
}, 90_000);

it("of two dials to one key at once, the one that fails takes only its own handshake: the other opens and carries frames", async () => {
  // The first dial the peer sees is refused on every attempt; the second, which starts while the first still runs, opens.
  let refused: number | undefined;
  let firstSeen = () => {};
  const peer = await farPeer(dial => {
    if (refused === undefined) { refused = dial; firstSeen(); }
    return dial === refused;
  });
  const before = handshakes.size;
  try {
    for (let round = 0; round < 2; round++) {
      refused = undefined;
      const seen = new Promise<void>(resolve => { firstSeen = resolve; });
      const failing = browser.connect({ publicKey: peer.key });
      failing.catch(() => {});
      await seen;
      const opened = await browser.connect({ publicKey: peer.key });
      const back = next(opened);
      opened.channel.send("ping");
      expect(await back).toBe("pong");
      await expect(failing).rejects.toThrow(/PEER_CONNECTION_FAILED|closed/);
      // Still open after the other dial failed beside it.
      const again = next(opened);
      opened.channel.send("ping");
      expect(await again).toBe("pong");
      const socket = socketOf(opened);
      const closed = new Promise<void>(resolve => socket.once("close", resolve));
      opened.channel.close();
      await closed;
    }
    await vi.waitFor(() => expect(handshakes.size).toBe(before), { timeout: 5000 });
  } finally { await peer.close(); }
}, 90_000);
