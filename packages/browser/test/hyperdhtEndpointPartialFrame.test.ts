import { afterAll, beforeAll, expect, it } from "vitest";
import type { BoundChannel, NativeEndpoint } from "@ghostly/core";
import { createIdentity } from "@ghostly/core";
import { createRelayedHyperEndpoint } from "../src/platform/hyperdhtRelay";
// covers: transport.hyperdht, transport.hyperdht-relay

/**
 * A frame that comes in many small records, read by the Desktop's and the CLI's HyperDHT endpoint
 * (native/transports/hyperdht/endpoint.mjs) and by a browser's through a real dht-relay, on a HyperDHT network of
 * their own: secret-stream hands each record over as its own chunk, so a reader that joined what it had of the frame
 * to each one copied it again at every byte.
 */

type Relay = { url: string; bootstrap: string[]; close(): Promise<void> };
type RawSocket = {
  write(data: Uint8Array): boolean; end(): void; destroy(): void; opened: Promise<boolean>;
  on(event: string, listener: (...args: never[]) => void): void;
};
type RawNode = { connect(publicKey: Buffer): RawSocket; destroy(): Promise<void> };

const MAX_FRAME = 60 * 1024;
const PREFACE = "ghostly/paired-chat/1";
let relay: Relay;
let raw: RawNode;
const opened: NativeEndpoint[] = [];

beforeAll(async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  relay = await startRelay({ testnet: 3 });
  const { default: DHT } = await import("hyperdht");
  raw = new DHT({ bootstrap: relay.bootstrap, host: "127.0.0.1", firewalled: false }) as RawNode;
}, 60_000);
afterAll(async () => {
  await Promise.allSettled(opened.map(endpoint => endpoint.close()));
  await raw?.destroy();
  await relay?.close();
});

async function desktop(): Promise<NativeEndpoint> {
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const bootstrap = relay.bootstrap.map(node => { const [host, port] = node.split(":"); return { host, port: Number(port) }; });
  const endpoint = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: "127.0.0.1" }) as NativeEndpoint;
  opened.push(endpoint);
  return endpoint;
}
async function web(): Promise<NativeEndpoint> {
  const endpoint = await createRelayedHyperEndpoint(createIdentity().seedB64, relay.url);
  opened.push(endpoint);
  return endpoint;
}
const endpoints = [["the Desktop's endpoint", desktop], ["a browser's, relayed", web]] as const;

/** A raw HyperDHT stream to `endpoint`, its Noise handshake done. */
async function dial(endpoint: NativeEndpoint): Promise<RawSocket> {
  const socket = raw.connect(Buffer.from((endpoint.descriptor as { publicKey: string }).publicKey, "hex"));
  socket.on("error", () => {});
  expect(await socket.opened).toBe(true);
  return socket;
}
function frame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, 4);
  return out;
}
/** Every byte this process copies by Buffer.concat or Uint8Array#set while `run` runs (the relay's own included). */
async function copied(run: () => Promise<void>): Promise<number> {
  const concat = Buffer.concat, set = Uint8Array.prototype.set;
  let bytes = 0;
  Buffer.concat = function (list: readonly Uint8Array[], total?: number) {
    const out = concat.call(Buffer, list, total);
    bytes += out.length;
    return out;
  } as typeof Buffer.concat;
  Uint8Array.prototype.set = function (this: Uint8Array, source: ArrayLike<number>, offset?: number) {
    bytes += source.length;
    return set.call(this, source, offset);
  } as typeof set;
  try { await run(); }
  finally { Buffer.concat = concat; Uint8Array.prototype.set = set; }
  return bytes;
}

for (const [name, make] of endpoints) {
  it(`${name} reads a whole-size frame sent one byte per record without copying it again at each one`, async () => {
    const endpoint = await make();
    endpoint.onConnection = () => {};
    const socket = await dial(endpoint);
    const closed = new Promise<void>(resolve => socket.on("close", () => resolve()));
    const whole = frame("x".repeat(MAX_FRAME));
    const bytes = await copied(async () => {
      for (let i = 0; i < whole.length; i++) socket.write(whole.subarray(i, i + 1));
      // Not the preface: the endpoint drops the stream once the frame is whole.
      await closed;
    });
    // Before: ~1.89 GB, every byte of the partial frame copied again at each of its 61,444 records.
    expect(bytes).toBeLessThan(256 * MAX_FRAME);
  }, 60_000);

  it(`${name} still reads the preface and frames cut anywhere, whole and in order`, async () => {
    const endpoint = await make();
    const bound = new Promise<BoundChannel>(resolve => { endpoint.onConnection = resolve; });
    const socket = await dial(endpoint);
    const texts = Array.from({ length: 40 }, (_, i) => `${i}:${"y".repeat(i * 97)}`);
    const wire = Buffer.concat([frame(PREFACE), ...texts.map(frame)]);
    let at = 0, step = 0;
    while (at < wire.length) { const size = 1 + (step++ % 7); socket.write(wire.subarray(at, at + size)); at += size; }
    const { channel } = await bound;
    const heard: string[] = [];
    channel.onMessage = data => { heard.push(String(data)); };
    await expect.poll(() => heard.length, { timeout: 20_000 }).toBe(texts.length);
    expect(heard).toEqual(texts);
    socket.destroy();
  }, 60_000);
}
