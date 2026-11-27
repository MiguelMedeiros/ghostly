import "fake-indexeddb/auto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createIdentity, type BoundChannel, type NativeEndpoint } from "@ghostly/core";
import { createRelayedHyperEndpoint } from "../src/platform/hyperdhtRelay";
// covers: transport.hyperdht-relay

/**
 * dht-relay 0.4.3's client `Stream` waits on the app's one relay connection for it to close, once per relayed stream, and
 * never stops waiting: every stream the page ever had, dialled or dialled in, stayed in memory until that connection
 * went. A real dht-relay (infra/services/hyperdht-relay) on a HyperDHT network of its own, against the Desktop's endpoint.
 */

type Relay = { url: string; bootstrap: string[]; close(): Promise<void> };
type Wire = { listenerCount(event: string): number };
type Socket = { once(event: string, listener: () => void): unknown; destroyed?: boolean; rawStream?: { _protocol?: { _stream?: Wire } } };
let relay: Relay;
let browser: NativeEndpoint;
let native: NativeEndpoint;
const seed = () => createIdentity().seedB64;
/** The browser side's SecretStream under a channel. */
const socketOf = (bound: BoundChannel) => (bound.channel as unknown as { socket: Socket }).socket;
const incoming = (endpoint: NativeEndpoint) => new Promise<BoundChannel>(resolve => { endpoint.onConnection = resolve; });
const next = (bound: BoundChannel) => new Promise<string>(resolve => { bound.channel.onMessage = text => resolve(String(text)); });
const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

beforeAll(async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  relay = await startRelay({ testnet: 3 });
  browser = await createRelayedHyperEndpoint(seed(), relay.url);
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const bootstrap = relay.bootstrap.map(node => { const [host, port] = node.split(":"); return { host, port: Number(port) }; });
  native = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: "127.0.0.1" }) as NativeEndpoint;
  // A first stream, so both ends are up before anything is counted.
  await roundTrip(browser, native);
}, 60_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), native?.close()]);
  await relay?.close();
});

/**
 * One stream from `from` to `to`: it opens, carries a message each way, and the dialler closes it. Gives the browser
 * side's relay connection and its SecretStream, once that has closed.
 */
async function roundTrip(from: NativeEndpoint, to: NativeEndpoint): Promise<{ wire: Wire | undefined; socket: WeakRef<Socket> }> {
  const accepted = incoming(to);
  // The Desktop stops announcing its key while it has a live chat, and announces it again once that closes: a dial right
  // after the last one may find nobody yet.
  const dialled = await vi.waitFor(() => from.connect(to.descriptor), { timeout: 20_000, interval: 100 });
  const answered = await accepted;
  // Its resolve holds the promise, and so the stream, for as long as it stays the handler.
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
  return { wire: socket.rawStream?._protocol?._stream, socket: new WeakRef(socket) };
}

it("lets every relayed stream go once it has closed, dialled or dialled in, while the relay connection stays open", async () => {
  // Once each way first: the relay connection's own waits (the node's, the listener's) are there from then on.
  const first = await roundTrip(browser, native);
  await roundTrip(native, browser);
  const wire = first.wire!;
  expect(wire.listenerCount, "dht-relay's Stream keeps its relay connection at _protocol._stream").toBeTypeOf("function");
  const before = wire.listenerCount("close");
  const sockets: WeakRef<Socket>[] = [];
  const N = 20;
  for (let i = 0; i < N; i++) {
    const out = await roundTrip(browser, native);
    expect(out.wire).toBe(wire);
    sockets.push(out.socket);
  }
  const afterOut = wire.listenerCount("close");
  for (let i = 0; i < N; i++) {
    const into = await roundTrip(native, browser);
    expect(into.wire).toBe(wire);
    sockets.push(into.socket);
  }
  const afterIn = wire.listenerCount("close");
  // Left to dht-relay, each closed stream kept one wait on the relay connection: N more after the dials out, N more after
  // the dials in (and one more for each dial the Desktop's quiet moment refused).
  expect({ afterOut, afterIn }).toEqual({ afterOut: before, afterIn: before });
  // And with it the stream, its SecretStream and its buffers (about 7 KB each).
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  await vi.waitFor(() => { gc(); expect(sockets.flatMap((ref, i) => ref.deref() ? [i] : [])).toEqual([]); }, { timeout: 5000, interval: 100 });
  // The connection is still the one it was, and still carries streams both ways.
  expect((await roundTrip(browser, native)).wire).toBe(wire);
  expect((await roundTrip(native, browser)).wire).toBe(wire);
  expect(wire.listenerCount("close")).toBe(before);
}, 120_000);

it("lets a dial go that never opened: a key nobody listens on", async () => {
  const { wire } = await roundTrip(browser, native);
  const before = wire!.listenerCount("close");
  for (let i = 0; i < 3; i++) await expect(browser.connect({ publicKey: randomKey() })).rejects.toThrow();
  await vi.waitFor(() => expect(wire!.listenerCount("close")).toBe(before), { timeout: 5000 });
  // The endpoint still dials and is dialled as before.
  await roundTrip(browser, native);
  await roundTrip(native, browser);
  expect(wire!.listenerCount("close")).toBe(before);
}, 90_000);
