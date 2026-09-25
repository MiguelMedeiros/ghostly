import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, toBase64, type BoundChannel, type NativeEndpoint, type PairingState } from "@ghostly/core";
import { createRelayedHyperEndpoint, hyperKeyPair, relayUrlProblem } from "../src/platform/hyperdhtRelay";
// covers: transport.hyperdht-relay, transport.hyperdht, transport.relayed

/**
 * A browser's HyperDHT through a real dht-relay (native-transports/hyperdht-relay) on a HyperDHT network of
 * its own, against the Desktop's own endpoint (native-transports/hyperdht/endpoint.mjs) and against another
 * browser. Node's WebSocket stands in for the browser's; the real browser build runs in e2e/web.
 */

type Relay = { url: string; bootstrap: string[]; close(): Promise<void>; stats(): { clients: number; dropped: number; refused: number } };
let relay: Relay;
const opened: NativeEndpoint[] = [];
const seed = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
/** What the browser side wrote to the relay, to look for anything it must never see. */
const sent: Uint8Array[] = [];
function recordingSocket(url: string): WebSocket {
  const socket = new WebSocket(url);
  const send = socket.send.bind(socket);
  socket.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    if (ArrayBuffer.isView(data)) sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    else if (data instanceof ArrayBuffer) sent.push(new Uint8Array(data.slice(0)));
    send(data);
  };
  return socket;
}
async function web(url = relay.url, seedB64 = seed()) {
  const endpoint = await createRelayedHyperEndpoint(seedB64, url, { createSocket: recordingSocket });
  opened.push(endpoint);
  return endpoint;
}
async function desktop() {
  const { createHyperEndpoint } = await import("../../../native-transports/hyperdht/endpoint.mjs");
  const bootstrap = relay.bootstrap.map(node => { const [host, port] = node.split(":"); return { host, port: Number(port) }; });
  const endpoint = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: "127.0.0.1" }) as NativeEndpoint;
  opened.push(endpoint);
  return endpoint;
}
const incoming = (endpoint: NativeEndpoint) => new Promise<BoundChannel>(resolve => { endpoint.onConnection = resolve; });
const next = (bound: BoundChannel) => new Promise<string>(resolve => { bound.channel.onMessage = text => resolve(String(text)); });
const contains = (haystack: Uint8Array[], needle: Uint8Array) => {
  const all = Buffer.concat(haystack.map(chunk => Buffer.from(chunk)));
  return all.includes(Buffer.from(needle));
};

beforeAll(async () => {
  const { startRelay } = await import("../../../native-transports/hyperdht-relay/relay.mjs");
  relay = await startRelay({ testnet: 3 });
}, 60_000);
afterAll(async () => {
  await Promise.allSettled(opened.map(endpoint => endpoint.close()));
  await relay?.close();
});

it("accepts only wss:// relays, and ws:// to this machine", () => {
  expect(relayUrlProblem("wss://relay.example")).toBeNull();
  expect(relayUrlProblem("ws://127.0.0.1:49443")).toBeNull();
  expect(relayUrlProblem("ws://localhost:1")).toBeNull();
  expect(relayUrlProblem("ws://relay.example")).toMatch(/wss/);
  expect(relayUrlProblem("https://relay.example")).toMatch(/wss/);
  expect(relayUrlProblem("not a url")).toMatch(/relay address/);
});

it("gives the Desktop's key for the same seed, and says it is relayed", async () => {
  const seedB64 = seed();
  const endpoint = await web(relay.url, seedB64);
  const { default: DHT } = await import("hyperdht");
  const expected = DHT.keyPair(Buffer.from(seedB64, "base64"));
  expect(endpoint.descriptor).toEqual({ publicKey: expected.publicKey.toString("hex"), relayed: true });
  expect(Buffer.from(hyperKeyPair(Buffer.from(seedB64, "base64")).secretKey)).toEqual(expected.secretKey);
}, 30_000);

it("talks to a Desktop both ways, with the same binding at both ends, and the relay sees no secret", async () => {
  const [browser, native] = [await web(), await desktop()];
  const secret = "only-the-desktop-may-read-this-" + seed();
  // Browser dials the Desktop.
  const accepted = incoming(native);
  const dialled = await browser.connect(native.descriptor);
  const other = await accepted;
  expect(dialled.binding).toEqual(other.binding);
  expect(dialled.binding.transport).toBe("hyperdht/1");
  expect(dialled.binding.context).toMatch(/^[0-9a-f]{128}$/);
  const heard = next(other);
  dialled.channel.send(secret);
  expect(await heard).toBe(secret);
  const back = next(dialled);
  other.channel.send("and back");
  expect(await back).toBe("and back");
  // Desktop dials the browser.
  const reached = incoming(browser);
  const outgoing = await native.connect(browser.descriptor);
  const answered = await reached;
  expect(answered.binding).toEqual(outgoing.binding);
  // What went to the relay: never the text, a secret key, or the handshake hash the binding is made of.
  expect(contains(sent, new TextEncoder().encode(secret))).toBe(false);
  expect(contains(sent, Buffer.from(dialled.binding.context, "hex").subarray(0, 32))).toBe(false);
  for (const endpoint of opened.filter(e => (e.descriptor as { relayed?: boolean }).relayed)) {
    const key = Buffer.from((endpoint.descriptor as { publicKey: string }).publicKey, "hex");
    expect(contains(sent, key)).toBe(true); // Public keys do go to the relay.
  }
  dialled.channel.close(); outgoing.channel.close();
}, 60_000);

it("connects two browsers through relays, on one relay connection each or shared", async () => {
  const a = await web(), b = await web(relay.url.replace("127.0.0.1", "localhost"));
  const accepted = incoming(b);
  const dialled = await a.connect(b.descriptor);
  const other = await accepted;
  expect(dialled.binding).toEqual(other.binding);
  const heard = next(other);
  dialled.channel.send("x".repeat(60 * 1024 - 8));
  expect((await heard).length).toBe(60 * 1024 - 8);
  // Two chats of the same app share its one relay connection.
  const c = await web();
  const reached = incoming(c);
  const second = await a.connect(c.descriptor);
  expect((await reached).binding).toEqual(second.binding);
  dialled.channel.close(); second.channel.close();
}, 60_000);

it("refuses a malformed descriptor and oversized frames", async () => {
  const [a, b] = [await web(), await web()];
  await expect(a.connect({ publicKey: "zz" })).rejects.toThrow(/Invalid HyperDHT endpoint/);
  await expect(a.connect(null)).rejects.toThrow(/Invalid HyperDHT endpoint/);
  const accepted = incoming(b);
  const dialled = await a.connect(b.descriptor);
  await accepted;
  expect(() => dialled.channel.send("x".repeat(60 * 1024 + 1))).toThrow(/frame budget/);
  dialled.channel.close();
}, 60_000);

it("fails to start, and so is not offered, when the relay cannot be reached", async () => {
  await expect(createRelayedHyperEndpoint(seed(), "ws://127.0.0.1:1")).rejects.toThrow(/relay/i);
  await expect(createRelayedHyperEndpoint(seed(), "ws://relay.example")).rejects.toThrow(/wss/);
});

it("says it is unavailable when the relay goes away", async () => {
  const { startRelay } = await import("../../../native-transports/hyperdht-relay/relay.mjs");
  const own = await startRelay({ testnet: 2 });
  const endpoint = await createRelayedHyperEndpoint(seed(), own.url);
  const gone = vi.fn();
  endpoint.onUnavailable = gone;
  await own.close();
  await vi.waitFor(() => expect(gone).toHaveBeenCalledTimes(1));
  await endpoint.close();
}, 60_000);

it("drops a client past its listen budget and refuses topic queries, and keeps serving the others", async () => {
  const { startRelay } = await import("../../../native-transports/hyperdht-relay/relay.mjs");
  const own = await startRelay({ testnet: 2, limits: { listens: 2 } });
  const endpoints = [await createRelayedHyperEndpoint(seed(), own.url), await createRelayedHyperEndpoint(seed(), own.url)];
  const gone = vi.fn();
  endpoints[0].onUnavailable = gone;
  await expect(createRelayedHyperEndpoint(seed(), own.url)).rejects.toThrow();
  await vi.waitFor(() => expect(gone).toHaveBeenCalled());
  expect(own.stats().dropped).toBe(1);
  // A topic lookup (a crawler's move; Ghostly never makes one) drops that client too.
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  const socket = new WebSocket(own.url);
  const closed = new Promise(resolve => socket.addEventListener("close", resolve));
  const crawler = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { lookup(topic: Uint8Array): { on(event: string, f: () => void): void } };
  crawler.lookup(new Uint8Array(32)).on("error", () => {});
  await closed;
  expect(own.stats().dropped).toBe(2);
  // A fresh connection is served again.
  const again = await createRelayedHyperEndpoint(seed(), own.url);
  await again.close();
  await Promise.allSettled(endpoints.map(e => e.close()));
  await own.close();
}, 60_000);

it("carries a whole paired chat between two browsers with WebRTC off, pinned as on any transport", async () => {
  const invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const states: PairingState[] = [{ status: "connecting" }, { status: "connecting" }];
  const received: string[][] = [[], []];
  const endpoints = [await web(), await web(relay.url.replace("127.0.0.1", "localhost"))];
  const links = params.map((p, i) => new GhostLink({
    params: { ...p, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: async () => {} },
    native: { preferred: "hyperdht/1", fallback: true, peerDescriptors: { "hyperdht/1": endpoints[1 - i].descriptor }, peerTransports: ["hyperdht/1"], peerFallback: true },
    transport: { publish: vi.fn(), resolve: async () => null, describe: () => ({ protocol: "relay test", relays: [] }) },
    createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: {
      onPairingState: state => { states[i] = state; },
      onMessage: async message => { received[i].push(message.text); },
    },
  }));
  links.forEach((link, i) => link.registerEndpoint(endpoints[i]));
  try {
    await links[0].connect(15_000);
    await vi.waitFor(() => expect(states.map(s => [s.status, s.transport])).toEqual([["ready", "hyperdht/1"], ["ready", "hyperdht/1"]]), { timeout: 15_000 });
    expect(states[0].peerKey).toBeTruthy();
    expect(await links[0].sendMessage("hello over a relayed HyperDHT")).toBeNull();
    await vi.waitFor(() => expect(received[1]).toEqual(["hello over a relayed HyperDHT"]));
  } finally {
    await Promise.allSettled(links.map(link => link.stop()));
  }
}, 60_000);
