import { afterAll, beforeAll, expect, it } from "vitest";
import type { NativeEndpoint } from "@ghostly/core";
// covers: transport.hyperdht

/**
 * The Desktop's and the CLI's HyperDHT endpoint (native/transports/hyperdht/endpoint.mjs) on a HyperDHT network of its
 * own, on loopback. A dial whose stream opened and carried nothing is made again after 2 s (redial.mjs, bug hunt
 * r11h); an endpoint holds at most two channels, so the stalled dial must give its place up at once, or the dial
 * made again is refused while another chat's channel is live.
 */

type Testnet = { bootstrap: { host: string; port: number }[]; destroy(): Promise<void> };
type Node = { createServer(onSocket: (socket: Socket) => void): { listen(keyPair: unknown): Promise<void>; close(): Promise<void> }; destroy(): Promise<void> };
type Socket = { write(data: Buffer): void; on(event: string, listener: (...args: unknown[]) => void): void };

let net: Testnet;
const opened: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  const { default: testnet } = await import("hyperdht/testnet.js");
  net = await testnet(3, { host: "127.0.0.1" });
}, 30_000);
afterAll(async () => {
  await Promise.allSettled(opened.map((item) => item.close()));
  await net?.destroy();
});

async function endpoint(): Promise<NativeEndpoint> {
  const { createHyperEndpoint } = await import("../../../native/transports/hyperdht/endpoint.mjs");
  const made = await createHyperEndpoint(crypto.getRandomValues(new Uint8Array(32)), { bootstrap: net.bootstrap, host: "127.0.0.1" } as never);
  opened.push(made);
  return made;
}

/** The framed `ghostly/paired-chat/1` preface, as endpoint.mjs writes it. */
function preface(): Buffer {
  const payload = Buffer.from("ghostly/paired-chat/1");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

it("a dial that opened and carried nothing gives its place up, so the next dial goes through beside a live chat", async () => {
  const [alice, bob] = [await endpoint(), await endpoint()];
  bob.onConnection = () => {};
  // Alice's first channel: another chat, live.
  const live = await alice.connect(bob.descriptor);
  expect(live.binding.transport).toBe("hyperdht/1");

  // A contact whose first connection opens and then says nothing (the stall), and whose next one answers.
  const { default: DHT } = await import("hyperdht");
  const keyPair = DHT.keyPair();
  const node = new DHT({ bootstrap: net.bootstrap, host: "127.0.0.1" }) as unknown as Node;
  opened.push({ close: () => node.destroy() });
  let sockets = 0;
  const server = node.createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", () => {});
    if (++sockets > 1) socket.write(preface());
  });
  await server.listen(keyPair);

  const started = Date.now();
  const bound = await alice.connect({ publicKey: keyPair.publicKey.toString("hex") });
  expect(bound.binding.transport).toBe("hyperdht/1");
  expect(sockets).toBe(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  expect(Date.now() - started).toBeLessThan(8000);
}, 30_000);
