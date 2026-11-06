import "fake-indexeddb/auto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, encodeFileData, fromBase64Url, type BoundChannel, type NativeEndpoint, type PairingState } from "@ghostly/core";
import { createRelayedHyperEndpoint, hyperKeyPair, relayUrlProblem } from "../src/platform/hyperdhtRelay";
// covers: transport.hyperdht-relay, transport.hyperdht, transport.relayed

/**
 * A browser's HyperDHT through a real dht-relay (infra/services/hyperdht-relay) on a HyperDHT network of
 * its own, against the Desktop's own endpoint (native/transports/hyperdht/endpoint.mjs) and against another
 * browser. Node's WebSocket stands in for the browser's; the real browser build runs in e2e/web.
 */

type Relay = { url: string; bootstrap: string[]; close(): Promise<void>; stats(): { clients: number; dropped: number; refused: number } };
let relay: Relay;
const opened: NativeEndpoint[] = [];
/** A chat's transport seed, as the engine makes it (url-safe base64). */
const seed = () => createIdentity().seedB64;
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
/** Every secret key a browser endpoint here holds: none of them may ever be on the relay's wire. */
const secrets: Uint8Array[] = [];
async function web(url = relay.url, seedB64 = seed()) {
  secrets.push(hyperKeyPair(fromBase64Url(seedB64)).secretKey);
  const endpoint = await createRelayedHyperEndpoint(seedB64, url, { createSocket: recordingSocket });
  opened.push(endpoint);
  return endpoint;
}
async function desktop() {
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
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
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
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
  // Only the server's address: the endpoint tells it to every contact as its relay.
  for (const bad of ["wss://alice:hunter2@relay.example", "wss://alice@relay.example", "wss://relay.example/?token=s3cr3t", "wss://relay.example/?",
    "wss://relay.example/#s3cr3t", "ws://alice:hunter2@127.0.0.1:49443/", `wss://relay.example/${"a".repeat(256)}`])
    expect(relayUrlProblem(bad)).toBe(`Not a relay address: ${bad}`);
});

it("never names a relay with a login or a token in its descriptor, saved before that was refused", async () => {
  const url = relay.url.replace("ws://", "ws://alice:hunter2@") + "/?token=s3cr3t";
  await expect(createRelayedHyperEndpoint(seed(), url)).rejects.toThrow("Not a relay address");
});

it("gives the Desktop's key for the same seed, and says it is relayed", async () => {
  const seedB64 = seed();
  const endpoint = await web(relay.url, seedB64);
  const { default: DHT } = await import("hyperdht");
  const expected = DHT.keyPair(Buffer.from(fromBase64Url(seedB64)));
  expect(endpoint.descriptor).toEqual({ publicKey: expected.publicKey.toString("hex"), relayed: true, relay: relay.url });
  expect(Buffer.from(hyperKeyPair(fromBase64Url(seedB64)).secretKey)).toEqual(expected.secretKey);
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

it("carries binary messages both ways with a Desktop, in order with text, and refuses one too large", async () => {
  const [browser, native] = [await web(), await desktop()];
  const accepted = incoming(native);
  const dialled = await browser.connect(native.descriptor);
  const other = await accepted;
  expect(dialled.channel.binary && other.channel.binary).toBe(true);
  const heard = (bound: BoundChannel, count: number) => new Promise<(string | Uint8Array)[]>(resolve => {
    const got: (string | Uint8Array)[] = [];
    bound.channel.onMessage = data => { got.push(data); if (got.length === count) resolve(got); };
  });
  const big = Uint8Array.from({ length: 60 * 1024 }, (_, i) => (i * 7) & 0xff);
  // A message that reads as UTF-8 text stays bytes, and one that does not is not refused for it.
  const looksLikeText = new TextEncoder().encode('{"t":"paired-ping"}'), notText = Uint8Array.of(0xff, 0xfe, 0x00);
  const there = heard(other, 4);
  dialled.channel.send(looksLikeText); dialled.channel.send("between"); dialled.channel.send(notText); dialled.channel.send(big);
  expect(await there).toEqual([looksLikeText, "between", notText, big]);
  const back = heard(dialled, 2);
  other.channel.send(Uint8Array.of(4, 2)); other.channel.send("after");
  expect(await back).toEqual([Uint8Array.of(4, 2), "after"]);
  expect(() => dialled.channel.send(new Uint8Array(60 * 1024 + 1))).toThrow(/frame budget/);
  expect(() => other.channel.send(new Uint8Array(60 * 1024 + 1))).toThrow(/frame budget/);
  dialled.channel.close();
}, 60_000);

it("agrees files/4 on a chat over HyperDHT with a Desktop, and a file's bytes arrive as bytes", async () => {
  const invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const frames: Record<string, unknown>[][] = [[], []];
  const endpoints = [await web(), await desktop()];
  // The browser dials: its end of the session, to put a file's data on it as the sender's app would.
  let session: BoundChannel | undefined;
  const connect = endpoints[0].connect.bind(endpoints[0]);
  endpoints[0].connect = async (address) => (session = await connect(address));
  const links = params.map((p, i) => new GhostLink({
    params: { ...p, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: async () => {} },
    native: { preferred: "hyperdht/1", fallback: true, peerDescriptors: { "hyperdht/1": endpoints[1 - i].descriptor }, peerTransports: ["hyperdht/1"], peerFallback: true },
    transport: { publish: vi.fn(), resolve: async () => null, describe: () => ({ protocol: "relay test", relays: [] }) },
    createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    largeFilesSupport: true, binaryFilesSupport: true,
    events: { onFilesFrame: frame => { frames[i].push(frame); } },
  }));
  links.forEach((link, i) => link.registerEndpoint(endpoints[i]));
  try {
    await links[0].connect(15_000);
    await vi.waitFor(() => expect(links.every(link => link.supportsBinaryFiles)).toBe(true), { timeout: 15_000 });
    const chunk = Uint8Array.from({ length: 16 * 1024 }, (_, i) => (i * 13) & 0xff);
    session!.channel.send(encodeFileData("AbCdEfGh_-0123456789xy", 2 ** 33, chunk));
    await vi.waitFor(() => expect(frames[1]).toEqual([{ t: "pf-data", id: "AbCdEfGh_-0123456789xy", offset: 2 ** 33, data: chunk }]));
  } finally {
    await Promise.allSettled(links.map(link => link.stop()));
  }
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

it("reaches the same contact again through one relay, and again after both pages reload", async () => {
  // The relay's HyperDHT remembers the nodes that carried the first connection to a key, so every later dial sends
  // its handshake through several at once and gets several replies: dht-relay 0.4.3 hung the dial on the second.
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const own = await startRelay({ testnet: 3 });
  // On its own loopback network the relay's node is reachable from the start, not after dht-rpc's 20 minute check.
  expect(own.dht.firewalled).toBe(false);
  const seeds = [seed(), seed()];
  const open = () => Promise.all([createRelayedHyperEndpoint(seeds[0], own.url), createRelayedHyperEndpoint(seeds[1], own.url.replace("127.0.0.1", "localhost"))]);
  const dial = async (from: NativeEndpoint, to: NativeEndpoint) => {
    const accepted = incoming(to);
    const dialled = await from.connect(to.descriptor);
    expect((await accepted).binding).toEqual(dialled.binding);
    dialled.channel.close();
  };
  let [a, b] = await open();
  try {
    for (let round = 0; round < 3; round++) await dial(b, a);
    await dial(a, b);
    // A reload: both pages' relay connections close, and the same chats listen again on new ones.
    await Promise.all([a.close(), b.close()]);
    [a, b] = await open();
    await dial(b, a);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await own.close();
  }
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

it("reads a burst of tiny frames in time linear in its bytes, as the Desktop does", async () => {
  const endpoint = await web();
  const { default: DHT } = await import("hyperdht");
  const bootstrap = relay.bootstrap.map(node => { const [host, port] = node.split(":"); return { host, port: Number(port) }; });
  const dht = new DHT({ bootstrap, host: "127.0.0.1" });
  try {
    const frame = (text: string) => { const bytes = Buffer.from(text); const out = Buffer.alloc(4 + bytes.length); out.writeUInt32BE(bytes.length); bytes.copy(out, 4); return out; };
    const accepted = incoming(endpoint);
    const socket = dht.connect(Buffer.from((endpoint.descriptor as { publicKey: string }).publicKey, "hex"));
    socket.on("error", () => {});
    socket.write(frame("ghostly/paired-chat/1"));
    const bound = await accepted;
    const count = 80_000;
    let heard = 0;
    const all = new Promise<void>(resolve => { bound.channel.onMessage = () => { if (++heard === count) resolve(); }; });
    const started = performance.now();
    socket.write(Buffer.concat(Array.from({ length: count }, () => frame("x"))));
    await all;
    // 400 KB of 1-byte frames: copying the rest of the buffer per frame took seconds; the Desktop takes ~60 ms.
    expect(performance.now() - started).toBeLessThan(1000);
    socket.destroy();
  } finally {
    await dht.destroy();
  }
}, 60_000);

it("fails to start, and so is not offered, when the relay cannot be reached", async () => {
  await expect(createRelayedHyperEndpoint(seed(), "ws://127.0.0.1:1")).rejects.toThrow(/relay/i);
  await expect(createRelayedHyperEndpoint(seed(), "ws://relay.example")).rejects.toThrow(/wss/);
});

it("says it is unavailable when the relay goes away", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const own = await startRelay({ testnet: 2 });
  const endpoint = await createRelayedHyperEndpoint(seed(), own.url);
  const gone = vi.fn();
  endpoint.onUnavailable = gone;
  await own.close();
  await vi.waitFor(() => expect(gone).toHaveBeenCalledTimes(1));
  await endpoint.close();
}, 60_000);

it("lets a chat's endpoint go once it is closed or refused, while the relay connection stays open", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const own = await startRelay({ testnet: 2 });
  // Another chat keeps the app's one relay connection open, as it does for as long as the app runs.
  const keeperSeed = seed();
  const keeper = await createRelayedHyperEndpoint(keeperSeed, own.url);
  // In a function of its own: this test's own frame would keep the last one.
  const openAndClose = async () => {
    const endpoint = await createRelayedHyperEndpoint(seed(), own.url);
    await endpoint.close();
    return new WeakRef(endpoint);
  };
  const endpoints: WeakRef<NativeEndpoint>[] = [];
  for (let i = 0; i < 20; i++) endpoints.push(await openAndClose());
  // Refused listens on the same connection between (the relay refuses a key it already listens on) keep none of them.
  for (let i = 0; i < 20; i++) await expect(createRelayedHyperEndpoint(keeperSeed, own.url)).rejects.toThrow("did not let this chat listen");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // Each was kept, with its listener and its key pair, until the connection closed (about 6 KiB each).
  await vi.waitFor(() => { gc(); expect(endpoints.flatMap((ref, i) => ref.deref() ? [i] : [])).toEqual([]); }, { timeout: 2000, interval: 50 });
  await keeper.close();
  await own.close();
}, 60_000);

it("drops a client past its listen budget and refuses topic queries, and keeps serving the others", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
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

it("refuses a listen on a key already listened on, by another client or the same one, and keeps serving the client that holds it", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const reasons: string[] = [];
  const own = await startRelay({ testnet: 2, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const { default: DHT } = await import("hyperdht");
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  type RawServer = { listen(keyPair: unknown): Promise<void> };
  const sockets: WebSocket[] = [];
  try {
    const holder = await createRelayedHyperEndpoint(seed(), own.url);
    const gone = vi.fn();
    holder.onUnavailable = gone;
    // Another client, on its own WebSocket: it listens on the holder's key, and twice on a key of its own.
    const socket = new WebSocket(own.url);
    sockets.push(socket);
    const other = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): RawServer };
    void other.createServer().listen({ publicKey: Buffer.from((holder.descriptor as { publicKey: string }).publicKey, "hex"), secretKey: null });
    const mine = DHT.keyPair();
    await other.createServer().listen(mine);
    void other.createServer().listen(mine);
    await vi.waitFor(() => expect(unhandled.length + reasons.filter(r => r.startsWith("refused listen")).length).toBe(2), { timeout: 15_000 });
    expect(unhandled).toEqual([]);
    expect(reasons.filter(r => r.startsWith("refused listen"))).toEqual(["refused listen KEYPAIR_ALREADY_USED", "refused listen KEYPAIR_ALREADY_USED"]);
    // Nobody was dropped, and the holder is still reached on its key.
    expect(own.stats()).toMatchObject({ clients: 2, dropped: 0 });
    const caller = await createRelayedHyperEndpoint(seed(), own.url.replace("127.0.0.1", "localhost"));
    const accepted = incoming(holder);
    const dialled = await caller.connect(holder.descriptor);
    expect((await accepted).binding).toEqual(dialled.binding);
    dialled.channel.close();
    expect(gone).not.toHaveBeenCalled();
    await Promise.allSettled([holder.close(), caller.close()]);
  } finally {
    for (const socket of sockets) socket.close();
    process.off("unhandledRejection", onUnhandled);
    await own.close();
  }
}, 60_000);

/**
 * A dht-relay server whose node answers every listen as `answer` says: `refused` as the relay answers a listen its
 * node refuses (`listening` at no address, then `closed`), `closed later` with `listening` at an address and a
 * `closed` once `close()` is called here.
 */
async function answeringRelay(answer: "refused" | "closed later") {
  const { EventEmitter } = await import("node:events");
  const { WebSocketServer } = await import("ws");
  const { relay: serve } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  const servers: InstanceType<typeof EventEmitter>[] = [];
  const dht = {
    createServer() {
      const server = Object.assign(new EventEmitter(), {
        port: 0,
        address: () => ({ host: answer === "refused" ? "0.0.0.0" : "127.0.0.1", port: server.port }),
        listen() {
          if (answer === "closed later") server.port = 49737;
          setImmediate(() => { server.emit("listening"); if (answer === "refused") server.emit("close"); });
          return Promise.resolve();
        },
        close() { server.emit("close"); return Promise.resolve(); },
      });
      servers.push(server);
      return server;
    },
  };
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => wss.once("listening", resolve));
  wss.on("connection", ws => { void serve(dht, new WebSocketStream(false, ws)); });
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    closeServers: () => { for (const server of servers) server.emit("close"); },
    close: () => new Promise<void>(resolve => { for (const ws of wss.clients) ws.terminate(); wss.close(() => resolve()); }),
  };
}

it("fails at once when the relay refuses the listen, not after its own timeout, and says the endpoint is gone when the relay closes it later", async () => {
  const refusing = await answeringRelay("refused");
  try {
    const started = Date.now();
    await expect(createRelayedHyperEndpoint(seed(), refusing.url)).rejects.toThrow("The HyperDHT relay did not let this chat listen");
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    await refusing.close();
  }
  const closing = await answeringRelay("closed later");
  try {
    const endpoint = await createRelayedHyperEndpoint(seed(), closing.url);
    const gone = vi.fn();
    endpoint.onUnavailable = gone;
    closing.closeServers();
    await vi.waitFor(() => expect(gone).toHaveBeenCalledTimes(1));
    await endpoint.close();
  } finally {
    await closing.close();
  }
}, 30_000);

it("frees the slot of a client that neither listens nor dials, one that stops answering pings, and a request that never ends, but keeps a browser", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { WebSocket: NodeWebSocket } = await import("ws");
  const { connect } = await import("node:net");
  const reasons: string[] = [];
  const own = await startRelay({ testnet: 2, limits: { idleMs: 1500, pingMs: 300, requestMs: 1000 }, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  const browser = await createRelayedHyperEndpoint(seed(), own.url);
  const gone = vi.fn();
  browser.onUnavailable = gone;
  // Opens its WebSocket and says nothing (it answers pings).
  const silent = new WebSocket(own.url);
  const silentClosed = new Promise(resolve => silent.addEventListener("close", resolve));
  // Says nothing and never answers a ping.
  const deaf = new NodeWebSocket(own.url, { autoPong: false });
  const deafClosed = new Promise(resolve => deaf.once("close", resolve));
  // Sends half a request and never upgrades.
  const half = connect(Number(new URL(own.url).port), "127.0.0.1");
  half.on("error", () => {});
  let answer = "";
  half.on("data", data => { answer += String(data); });
  half.write("GET / HTTP/1.1\r\nHost: relay\r\n");
  const halfClosed = new Promise(resolve => half.once("close", resolve));
  await vi.waitFor(() => expect(own.stats().accepted).toBe(3));
  await Promise.all([deafClosed, silentClosed, halfClosed]);
  expect(answer).toMatch(/^HTTP\/1\.1 408/);
  expect(reasons).toEqual(expect.arrayContaining(["dropped no pong", "dropped idle"]));
  expect(own.stats().clients).toBe(1);
  // The browser listens, answers pings, and stays.
  await new Promise(resolve => setTimeout(resolve, 2000));
  expect(gone).not.toHaveBeenCalled();
  expect(own.stats()).toMatchObject({ clients: 1, dropped: 2 });
  await browser.close();
  await own.close();
}, 60_000);

it("neither drops nor logs a client that listened and then left", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const reasons: string[] = [];
  const own = await startRelay({ testnet: 2, limits: { idleMs: 1500 }, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  const { default: DHT } = await import("hyperdht");
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  // It listens, then its WebSocket closes with its server still open (a reload, a phone switching networks).
  const socket = new WebSocket(own.url);
  const closed = new Promise(resolve => socket.addEventListener("close", resolve));
  const client = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): { listen(keyPair: unknown): Promise<void> } };
  await client.createServer().listen(DHT.keyPair());
  socket.close();
  await closed;
  await vi.waitFor(() => expect(own.stats().clients).toBe(0));
  // The relay closes its server after it has gone; nothing may count it as idle once `idleMs` has passed.
  await new Promise(resolve => setTimeout(resolve, 3000));
  expect(reasons.filter(reason => reason.startsWith("dropped"))).toEqual([]);
  expect(own.stats()).toMatchObject({ accepted: 1, dropped: 0 });
  await own.close();
}, 60_000);

it("refuses an upgrade by origin, address or a full relay to a client that has already reset, and keeps serving", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { WebSocket: NodeWebSocket } = await import("ws");
  const { connect } = await import("node:net");
  const allowed = "https://ghostly.test";
  const own = await startRelay({ testnet: 2, origins: [allowed], proxies: 1, limits: { clients: 2, clientsPerAddress: 1 } });
  const port = Number(new URL(own.url).port);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on("uncaughtException", onUncaught);
  const held: InstanceType<typeof NodeWebSocket>[] = [];
  const hold = async (address: string) => {
    const socket = new NodeWebSocket(own.url, { origin: allowed, headers: { "x-forwarded-for": address } });
    held.push(socket);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  };
  // A well-formed upgrade the relay refuses, reset by the client as soon as it is written.
  const resetUpgrade = (headers: string) => new Promise<void>(resolve => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 1).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`);
      setTimeout(() => { socket.resetAndDestroy(); resolve(); }, 1);
    });
    socket.on("error", () => resolve());
  });
  const resets = async (headers: string) => {
    for (let i = 0; i < 20; i++) {
      await resetUpgrade(headers);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    await resets("Origin: https://elsewhere.test\r\nX-Forwarded-For: 10.0.0.9\r\n");
    await hold("10.0.0.1");
    await resets(`Origin: ${allowed}\r\nX-Forwarded-For: 10.0.0.1\r\n`);
    await hold("10.0.0.2");
    await resets(`Origin: ${allowed}\r\nX-Forwarded-For: 10.0.0.3\r\n`);
    await vi.waitFor(() => expect(own.stats().refused).toBe(60));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(uncaught).toEqual([]);
    // The clients it holds are still there, and a slot that frees is taken again.
    expect(own.stats()).toMatchObject({ clients: 2, dropped: 0 });
    const closed = new Promise(resolve => held[0].once("close", resolve));
    held[0].close();
    await closed;
    await vi.waitFor(() => expect(own.stats().clients).toBe(1));
    await hold("10.0.0.3");
    expect(own.stats().clients).toBe(2);
  } finally {
    process.off("uncaughtException", onUncaught);
    for (const socket of held) socket.terminate();
    await own.close();
  }
}, 60_000);

it("closes every HyperDHT stream it holds for a client when the client leaves: dials under one alias, and incoming ones never taken", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { default: DHT } = await import("hyperdht");
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  type Stream = { destroyed: boolean; once(event: string, f: () => void): void; on(event: string, f: (...args: unknown[]) => void): void; destroy(): void };
  const own = await startRelay({ testnet: 2 });
  const native = new DHT({ bootstrap: own.bootstrap.map((node: string) => { const [host, port] = node.split(":"); return { host, port: Number(port) }; }), host: "127.0.0.1", firewalled: false });
  const streams: Stream[] = [];
  const keep = (stream: Stream) => { stream.on("error", () => {}); streams.push(stream); return stream; };
  const open = (list: Stream[]) => list.filter(stream => !stream.destroyed).length;
  const client = async () => {
    const socket = new WebSocket(own.url);
    await new Promise(resolve => socket.addEventListener("open", resolve));
    const closed = new Promise(resolve => socket.addEventListener("close", resolve));
    return { socket, closed, node: new RelayedDHT(new WebSocketStream(true, socket)) as unknown as { _protocol: Record<string, { send(m: unknown): void }>; createServer(): { listen(keyPair: unknown): Promise<void> } } };
  };

  // Three dials sent under one alias, to a native server.
  const server = native.createServer();
  const accepted: Stream[] = [];
  server.on("connection", (stream: Stream) => accepted.push(keep(stream)));
  const serverKeys = DHT.keyPair();
  await server.listen(serverKeys);
  const dialer = await client();
  const keyPair = DHT.keyPair();
  for (let i = 0; i < 3; i++) dialer.node._protocol.connect.send({ custodial: true, alias: 7, publicKey: keyPair.publicKey, secretKey: keyPair.secretKey, remotePublicKey: serverKeys.publicKey });
  await vi.waitFor(() => expect(open(accepted)).toBe(3), { timeout: 20_000 });
  dialer.socket.close();
  await dialer.closed;

  // A listener that never takes the connections it is offered.
  const listener = await client();
  listener.node._protocol.connected.send = () => {};
  const listenKeys = DHT.keyPair();
  await listener.node.createServer().listen(listenKeys);
  const dials = [0, 1].map(() => keep(native.connect(listenKeys.publicKey) as Stream));
  await Promise.all(dials.map(stream => new Promise(resolve => stream.once("open", resolve))));
  listener.socket.close();
  await listener.closed;

  await vi.waitFor(() => expect(open(accepted) + open(dials)).toBe(0), { timeout: 15_000 });
  for (const stream of streams) stream.destroy();
  await native.destroy();
  await own.close();
}, 90_000);

it("holds at most `streams` HyperDHT streams for a client while it stays: a dial past that drops it, an incoming one past that is closed", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { default: DHT } = await import("hyperdht");
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  type Stream = { destroyed: boolean; once(event: string, f: () => void): void; on(event: string, f: (...args: unknown[]) => void): void; destroy(): void };
  const reasons: string[] = [];
  const own = await startRelay({ testnet: 2, limits: { streams: 3 }, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  const native = new DHT({ bootstrap: own.bootstrap.map((node: string) => { const [host, port] = node.split(":"); return { host, port: Number(port) }; }), host: "127.0.0.1", firewalled: false });
  const streams: Stream[] = [];
  const keep = (stream: Stream) => { stream.on("error", () => {}); streams.push(stream); return stream; };
  const open = (list: Stream[]) => list.filter(stream => !stream.destroyed).length;
  const client = async () => {
    const socket = new WebSocket(own.url);
    await new Promise(resolve => socket.addEventListener("open", resolve));
    const closed = new Promise(resolve => socket.addEventListener("close", resolve));
    return { socket, closed, node: new RelayedDHT(new WebSocketStream(true, socket)) as unknown as {
      _protocol: Record<string, { send(m: unknown): void }>;
      createServer(options: object, onconnection: (stream: Stream) => void): { listen(keyPair: unknown): Promise<void> };
    } };
  };

  // A listener whose servers get more connections than it may hold: the extra ones close, it stays.
  const listener = await client();
  const taken: Stream[] = [];
  const listenKeys = DHT.keyPair();
  await listener.node.createServer({}, stream => taken.push(keep(stream))).listen(listenKeys);
  const incoming = [0, 1, 2, 3, 4].map(() => keep(native.connect(listenKeys.publicKey) as Stream));
  await vi.waitFor(() => expect(incoming.filter(stream => stream.destroyed).length).toBe(2), { timeout: 30_000 });
  expect(open(incoming)).toBe(3);
  expect(own.stats().dropped).toBe(0);

  // A dialler that keeps every stream: the dial past its budget drops it, and what it held closes with it.
  const server = native.createServer();
  const accepted: Stream[] = [];
  server.on("connection", (stream: Stream) => accepted.push(keep(stream)));
  const serverKeys = DHT.keyPair();
  await server.listen(serverKeys);
  const dialer = await client();
  const keyPair = DHT.keyPair();
  const dial = (alias: number) => dialer.node._protocol.connect.send({ custodial: true, alias, publicKey: keyPair.publicKey, secretKey: keyPair.secretKey, remotePublicKey: serverKeys.publicKey });
  for (let alias = 1; alias <= 3; alias++) dial(alias);
  await vi.waitFor(() => expect(open(accepted)).toBe(3), { timeout: 20_000 });
  expect(own.stats().dropped).toBe(0);
  dial(4);
  await dialer.closed;
  expect(reasons).toContain("dropped stream limit");
  expect(own.stats().dropped).toBe(1);
  await vi.waitFor(() => expect(open(accepted)).toBe(0), { timeout: 15_000 });
  // The listener was never dropped and still holds its three.
  expect(open(incoming)).toBe(3);

  for (const stream of streams) stream.destroy();
  listener.socket.close();
  await native.destroy();
  await own.close();
}, 90_000);

it("holds at most `queuedBytes` that a client has not read: one that reads gets a whole fast transfer, one that stops reading is dropped", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { default: DHT } = await import("hyperdht");
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  const net = await import("node:net");
  type Stream = { destroyed: boolean; write(data: Uint8Array): boolean; once(event: string, f: () => void): void; on(event: string, f: (...args: never[]) => void): void; destroy(): void };
  const reasons: string[] = [];
  const own = await startRelay({ testnet: 2, limits: { queuedBytes: 4 * 1024 * 1024 }, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  const native = new DHT({ bootstrap: own.bootstrap.map((node: string) => { const [host, port] = node.split(":"); return { host, port: Number(port) }; }), host: "127.0.0.1", firewalled: false });
  // A native peer that sends 1 MiB, then, once let go, as fast as its own stream lets it, up to `total`.
  const total = 96 * 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024).fill(7);
  const written: number[] = [];
  const go: (() => void)[] = [];
  const server = native.createServer();
  server.on("connection", (stream: Stream) => {
    stream.on("error", () => {});
    const at = written.push(0) - 1;
    let upTo = 1024 * 1024;
    const pump = () => {
      while (!stream.destroyed && written[at] < upTo) {
        written[at] += chunk.byteLength;
        if (!stream.write(chunk)) return stream.once("drain", pump);
      }
    };
    go[at] = () => { upTo = total; pump(); };
    pump();
  });
  const serverKeys = DHT.keyPair();
  await server.listen(serverKeys);
  // The link between a client and the relay: one the test can stop reading from the relay, as a slow or stalled one does.
  const links: { up: import("node:net").Socket; down: import("node:net").Socket }[] = [];
  const proxy = net.createServer(down => {
    const up = net.connect(own.port, "127.0.0.1");
    for (const socket of [up, down]) socket.on("error", () => {});
    down.on("data", data => up.write(data));
    up.on("data", data => down.write(data));
    up.on("close", () => down.destroy());
    down.on("close", () => up.destroy());
    links.push({ up, down });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  // A browser-like client (it runs the Noise handshake itself) that dials the native peer.
  const client = async () => {
    const socket = new WebSocket(url);
    await new Promise(resolve => socket.addEventListener("open", resolve));
    const link = links[links.length - 1];
    const node = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as unknown as { connect(key: Uint8Array): Stream };
    const stream = node.connect(serverKeys.publicKey);
    stream.on("error", () => {});
    const got = { bytes: 0 };
    stream.on("data", (data: Uint8Array) => { got.bytes += data.byteLength; });
    await vi.waitFor(() => expect(got.bytes).toBe(1024 * 1024), { timeout: 20_000 });
    return { socket, link, got, at: written.length - 1 };
  };

  try {
    // Reads as fast as the far peer sends: every byte comes, and the client stays.
    const reader = await client();
    go[reader.at]();
    await vi.waitFor(() => expect(reader.got.bytes).toBe(total), { timeout: 60_000 });
    expect(own.stats().dropped).toBe(0);
    reader.socket.close();

    // Stops reading (a slow link, a frozen tab): the relay would hold all the far peer sends; past the bound it drops
    // the client, long before the far peer is done, and the stream it held closes with it.
    const stalled = await client();
    stalled.link.up.pause();
    go[stalled.at]();
    await vi.waitFor(() => expect(reasons).toContain("dropped queue"), { timeout: 10_000 });
    expect(own.stats().dropped).toBe(1);
    expect(written[stalled.at]).toBeLessThan(total / 2);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(written[stalled.at]).toBeLessThan(total / 2);
  } finally {
    for (const { up, down } of links) { up.destroy(); down.destroy(); }
    proxy.close();
    await native.destroy();
    await own.close();
  }
}, 120_000);

it("holds at most `queuedTotalBytes` unread over all clients: past it the one holding the most is dropped, and one that reads stays", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { default: DHT } = await import("hyperdht");
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  const net = await import("node:net");
  type Stream = { destroyed: boolean; write(data: Uint8Array): boolean; once(event: string, f: () => void): void; on(event: string, f: (...args: never[]) => void): void; destroy(): void };
  const reasons: string[] = [];
  // Each client alone stays far below its own bound: only the sum over them is past the relay's.
  const perClient = 64 * 1024 * 1024;
  const own = await startRelay({ testnet: 2, limits: { queuedBytes: perClient, queuedTotalBytes: 16 * 1024 * 1024 }, log: (what: string, why: string) => { reasons.push(`${what} ${why}`); } });
  const native = new DHT({ bootstrap: own.bootstrap.map((node: string) => { const [host, port] = node.split(":"); return { host, port: Number(port) }; }), host: "127.0.0.1", firewalled: false });
  // A native peer that sends 1 MiB, then, once let go, as fast as its own stream lets it, up to `total`.
  const total = 96 * 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024).fill(7);
  const written: number[] = [];
  const go: (() => void)[] = [];
  const server = native.createServer();
  server.on("connection", (stream: Stream) => {
    stream.on("error", () => {});
    const at = written.push(0) - 1;
    let upTo = 1024 * 1024;
    const pump = () => {
      while (!stream.destroyed && written[at] < upTo) {
        written[at] += chunk.byteLength;
        if (!stream.write(chunk)) return stream.once("drain", pump);
      }
    };
    go[at] = () => { upTo = total; pump(); };
    pump();
  });
  const serverKeys = DHT.keyPair();
  await server.listen(serverKeys);
  // The link between a client and the relay: one the test can stop reading from the relay, as a stalled one does.
  const links: { up: import("node:net").Socket; down: import("node:net").Socket }[] = [];
  const proxy = net.createServer(down => {
    const up = net.connect(own.port, "127.0.0.1");
    for (const socket of [up, down]) socket.on("error", () => {});
    down.on("data", data => up.write(data));
    up.on("data", data => down.write(data));
    up.on("close", () => down.destroy());
    down.on("close", () => up.destroy());
    links.push({ up, down });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const client = async () => {
    const socket = new WebSocket(url);
    await new Promise(resolve => socket.addEventListener("open", resolve));
    const link = links[links.length - 1];
    const node = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as unknown as { connect(key: Uint8Array): Stream };
    const stream = node.connect(serverKeys.publicKey);
    stream.on("error", () => {});
    const got = { bytes: 0 };
    stream.on("data", (data: Uint8Array) => { got.bytes += data.byteLength; });
    await vi.waitFor(() => expect(got.bytes).toBe(1024 * 1024), { timeout: 20_000 });
    return { socket, link, got, at: written.length - 1 };
  };

  try {
    const reader = await client();
    const stalled = [await client(), await client(), await client()];
    // Three clients stop reading while their far peers send on: each would stay under its own bound for 64 MiB.
    for (const one of stalled) { one.link.up.pause(); go[one.at](); }
    // The reader gets a whole fast transfer meanwhile.
    go[reader.at]();
    await vi.waitFor(() => expect(reasons.filter(reason => reason === "dropped queue total")).toHaveLength(3), { timeout: 60_000 });
    expect(reasons).not.toContain("dropped queue");
    for (const one of stalled) expect(written[one.at]).toBeLessThan(perClient / 2);
    await vi.waitFor(() => expect(reader.got.bytes).toBe(total), { timeout: 60_000 });
    expect(own.stats().dropped).toBe(3);
    expect(own.stats().clients).toBe(1);
  } finally {
    for (const { up, down } of links) { up.destroy(); down.destroy(); }
    proxy.close();
    await native.destroy();
    await own.close();
  }
}, 150_000);

it("holds a client's handshakes only while they wait on it, and its signatures only until they come", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  const own = await startRelay({ testnet: 3, limits: { handshakeMs: 2_000 } });
  const held = () => own.stats().held;
  const [a, b] = await Promise.all([createRelayedHyperEndpoint(seed(), own.url), createRelayedHyperEndpoint(seed(), own.url)]);
  let socket: WebSocket | undefined;
  try {
    // Dials that open, both ends on this relay: each made a handshake for the dialler and one for the listener.
    for (let round = 0; round < 4; round++) {
      const accepted = incoming(a);
      const dialled = await b.connect(a.descriptor);
      await accepted;
      dialled.channel.close();
    }
    // Dials to keys nobody listens on.
    for (let round = 0; round < 2; round++) await expect(b.connect({ ...b.descriptor, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex") })).rejects.toThrow();
    // a's listen was announced (b reached it), so the relay asked a for its signatures, and they came.
    await vi.waitFor(() => expect(held()).toEqual({ handshakes: 0, signatures: 0 }), { timeout: 10_000 });

    // A client that never answers its part of a handshake holds it only until `handshakeMs`.
    socket = new WebSocket(own.url);
    await new Promise(resolve => socket!.addEventListener("open", resolve));
    const silent = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as unknown as { _protocol: Record<string, { send(m: unknown): void }>; connect(key: Uint8Array): { on(event: string, f: () => void): void } };
    silent._protocol.noiseReply.send = () => {};
    silent.connect(Buffer.from(a.descriptor.publicKey as string, "hex")).on("error", () => {});
    await vi.waitFor(() => expect(held().handshakes).toBe(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(held().handshakes).toBe(0), { timeout: 5_000 });
  } finally {
    socket?.close();
    await Promise.allSettled([a.close(), b.close()]);
    await own.close();
  }
}, 90_000);

it("keeps a client's other chats reachable, both ways, while one chat's contact dials it over and over", async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  const { default: DHT } = await import("hyperdht");
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const net = await import("node:net");
  const reasons: string[] = [];
  const own = await startRelay({ testnet: 3, log: (...words: string[]) => { reasons.push(words.join(" ")); } });
  const bootstrap = own.bootstrap.map((node: string) => { const [host, port] = node.split(":"); return { host, port: Number(port) }; });
  // The browser's one relay connection, 150 ms each way: its handshakes wait on it as long as a far browser's do.
  const links: import("node:net").Socket[] = [];
  const delayed = (from: import("node:net").Socket, to: import("node:net").Socket) => from.on("data", data => { setTimeout(() => { if (!to.destroyed) to.write(data); }, 150); });
  const proxy = net.createServer(down => {
    const up = net.connect(own.port, "127.0.0.1");
    for (const socket of [up, down]) socket.on("error", () => {});
    delayed(down, up); delayed(up, down);
    up.on("close", () => down.destroy());
    down.on("close", () => up.destroy());
    links.push(up, down);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  // Two chats of one browser on that connection; chat 2's contact runs a Desktop.
  const [chat1, chat2] = await Promise.all([createRelayedHyperEndpoint(seed(), url), createRelayedHyperEndpoint(seed(), url)]);
  chat1.onConnection = bound => bound.channel.close();
  const contact = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: "127.0.0.1" }) as NativeEndpoint;
  // Chat 1's contact dials chat 1 in 300 loops, each again as soon as the last ends.
  const flooder = new DHT({ bootstrap, host: "127.0.0.1", firewalled: false });
  const key1 = Buffer.from((chat1.descriptor as { publicKey: string }).publicKey, "hex");
  let flooding = true;
  const loops = Array.from({ length: 300 }, async () => {
    while (flooding) {
      await new Promise<void>(resolve => {
        const socket = flooder.connect(key1);
        socket.on("error", () => {});
        socket.on("open", () => socket.destroy());
        socket.on("close", () => resolve());
      });
    }
  });
  // One at a time: each waits for its own connection at the far end.
  const dials = async (from: NativeEndpoint, to: NativeEndpoint) => {
    const results: string[] = [];
    for (let round = 0; round < 6; round++) {
      try {
        const accepted = incoming(to);
        const dialled = await from.connect(to.descriptor);
        await accepted;
        dialled.channel.close();
        results.push("ok");
      } catch (error) {
        results.push(String((error as Error)?.message ?? error));
      }
    }
    return results;
  };
  try {
    // The flood holds all chat 1 may hold waiting on the browser (a quarter of `handshakes`), and more before.
    await vi.waitFor(() => expect(own.stats().held.handshakes).toBeGreaterThanOrEqual(16), { timeout: 20_000 });
    const out = await dials(chat2, contact);
    const into = await dials(contact, chat2);
    expect({ out, into }).toEqual({ out: Array(6).fill("ok"), into: Array(6).fill("ok") });
    // The flood is refused past chat 1's share, and the operator sees it; nobody is dropped.
    expect(reasons).toContain("refused handshake listen share");
    expect(own.stats().dropped).toBe(0);
  } finally {
    flooding = false;
    await Promise.allSettled(loops);
    await flooder.destroy();
    await Promise.allSettled([chat1.close(), chat2.close(), contact.close()]);
    for (const socket of links) socket.destroy();
    proxy.close();
    await own.close();
  }
}, 120_000);

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

it("never puts a secret key on the relay's wire: not in the handshake, a listen, a dial, an incoming stream or an announcement", async () => {
  // Everything the endpoints of this file did (listened, dialled, answered, carried frames) was recorded in `sent`.
  const [a, b] = [await web(), await web()];
  const accepted = incoming(b);
  const dialled = await a.connect(b.descriptor);
  await accepted;
  dialled.channel.close();
  expect(secrets.length).toBeGreaterThanOrEqual(2);
  for (const secret of secrets) {
    expect(contains(sent, secret)).toBe(false);
    expect(contains(sent, secret.subarray(0, 32))).toBe(false); // the seed half alone
  }
  // The check can see a leak: dht-relay's own default (custodial) sends the secret key in its first message.
  const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
  const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
  const leaked: Uint8Array[] = [];
  const socket = new WebSocket(relay.url);
  const send = socket.send.bind(socket);
  socket.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    if (ArrayBuffer.isView(data)) leaked.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    send(data);
  };
  const keyPair = hyperKeyPair(crypto.getRandomValues(new Uint8Array(32)));
  const custodial = new RelayedDHT(new WebSocketStream(true, socket), { keyPair }) as { destroy(): Promise<void> };
  await vi.waitFor(() => expect(contains(leaked, keyPair.secretKey)).toBe(true));
  await custodial.destroy().catch(() => {});
}, 60_000);
