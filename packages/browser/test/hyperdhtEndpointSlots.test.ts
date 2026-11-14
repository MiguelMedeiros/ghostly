import { afterAll, beforeAll, expect, it } from "vitest";
import { createIdentity, type BoundChannel, type NativeEndpoint } from "@ghostly/core";
import { createRelayedHyperEndpoint } from "../src/platform/hyperdhtRelay";
// covers: transport.hyperdht-relay, transport.hyperdht

/**
 * A HyperDHT endpoint's channel slots, the browser's (through a real dht-relay) and the Desktop's: streams dialled in
 * that never send the preface take none of them. The contact still gets in beside them, this side's own dial still goes
 * out, and past MAX_UNPREFACED the oldest of them is dropped for the new one.
 */

type Relay = { url: string; bootstrap: string[]; close(): Promise<void> };
type RawSocket = { opened: Promise<boolean>; destroyed: boolean; on(event: string, listener: (...args: unknown[]) => void): void; once(event: string, listener: () => void): void; destroy(): void };
type RawNode = { connect(publicKey: Buffer): RawSocket; destroy(): Promise<void> };

let relay: Relay;
let bootstrap: { host: string; port: number }[];
const opened: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
  relay = await startRelay({ testnet: 3 });
  bootstrap = relay.bootstrap.map(node => { const [host, port] = node.split(":"); return { host, port: Number(port) }; });
}, 60_000);
afterAll(async () => {
  await Promise.allSettled(opened.map(item => item.close()));
  await relay?.close();
});

async function web(): Promise<NativeEndpoint> {
  const endpoint = await createRelayedHyperEndpoint(createIdentity().seedB64, relay.url);
  opened.push(endpoint);
  return endpoint;
}
async function desktop(): Promise<NativeEndpoint> {
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const endpoint = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap, host: "127.0.0.1" } as never) as NativeEndpoint;
  opened.push(endpoint);
  return endpoint;
}

/** `count` Noise streams to `endpoint`'s key that open and never send the preface. */
async function stalls(endpoint: NativeEndpoint, count: number): Promise<RawSocket[]> {
  const { default: DHT } = await import("hyperdht");
  const node = new DHT({ bootstrap, host: "127.0.0.1" }) as unknown as RawNode;
  opened.push({ close: () => node.destroy() });
  const key = Buffer.from((endpoint.descriptor as { publicKey: string }).publicKey, "hex");
  const sockets: RawSocket[] = [];
  for (let i = 0; i < count; i++) {
    const socket = node.connect(key);
    socket.on("error", () => {});
    socket.on("data", () => {});
    expect(await socket.opened).toBe(true);
    sockets.push(socket);
  }
  return sockets;
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms))]);

for (const [name, make] of [["browser (relayed)", web], ["Desktop", desktop]] as const) {
  it(`${name}: streams without the preface hold no slot; the contact and this side's own dial still get in`, async () => {
    const endpoint = await make();
    const accepted: BoundChannel[] = [];
    endpoint.onConnection = bound => { accepted.push(bound); };
    // Two stalls: once, both slots.
    const held = await stalls(endpoint, 2);

    const contact = await desktop();
    contact.onConnection = () => {};
    const dialledIn = await within(contact.connect(endpoint.descriptor), 15_000);
    expect(dialledIn.binding.transport).toBe("hyperdht/1");
    await within((async () => { while (!accepted.length) await new Promise(resolve => setTimeout(resolve, 20)); })(), 5_000);

    const other = await desktop();
    other.onConnection = () => {};
    const out = await within(endpoint.connect(other.descriptor), 15_000);
    expect(out.binding.transport).toBe("hyperdht/1");
    expect(held.every(socket => !socket.destroyed)).toBe(true);
  }, 60_000);

  it(`${name}: past four streams without the preface, the oldest is dropped for the new one`, async () => {
    const endpoint = await make();
    endpoint.onConnection = () => {};
    const held = await stalls(endpoint, 5);
    await within(new Promise<void>(resolve => { if (held[0].destroyed) resolve(); else held[0].once("close", resolve); }), 5_000);
    expect(held.slice(1).every(socket => !socket.destroyed)).toBe(true);
  }, 60_000);
}
