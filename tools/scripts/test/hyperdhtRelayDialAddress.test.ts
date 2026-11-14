import { createSocket } from "node:dgram";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { expect, it } from "vitest";

// covers: transport.hyperdht-relay

/**
 * A dial through the relay sends its stream to the address its far peer was reached at, not to one the far peer names.
 * A far server that says it is open names a "canary" UDP socket as its address: the canary gets nothing, and the dial
 * still reaches the far server. HyperDHT skips loopback as a bogon in that pick, so this test's process (its own, as
 * every test file's) counts 127.0.0.1 as public, before HyperDHT loads, as a relay on a public address sees one.
 * The far server never sends to the relay first, as one that wants this would not.
 */

const require = createRequire(import.meta.url);
const bogon = require(require.resolve("bogon", { paths: [dirname(require.resolve("hyperdht"))] }));
const isBogon = bogon.isBogon;
bogon.isBogon = (ip: string) => ip !== "127.0.0.1" && isBogon(ip);

const { default: DHT } = await import("hyperdht");
const { default: RelayedDHT } = await import("@hyperswarm/dht-relay");
const { default: WebSocketStream } = await import("@hyperswarm/dht-relay/ws");
const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");

type Stream = { write(data: Buffer): boolean; once(event: string, f: (...args: unknown[]) => void): Stream; on(event: string, f: (...args: unknown[]) => void): Stream; destroy(): void };
const MARKER = Buffer.from("canary-marker-");

/**
 * A client (non-custodial as a browser is, unless `custodial`: it hands the relay its key, which runs its handshake)
 * dials a far server that names `names` as its address (and the canary as its relays, if `relays`), and writes to it,
 * `dials` times.
 */
async function dial(names: (canary: number) => { host: string; port: number } | null, { custodial = false, relays = false, dials = 1 } = {}) {
  const relay = await startRelay({ testnet: 3 });
  // With no address of its own to name, the relay's node waits for the far server to answer it: a far server that is
  // open connects back to a dialler that names its address, and that packet would decide where the stream goes.
  relay.dht.remoteAddress = () => null;
  const canary = createSocket("udp4");
  let packets = 0;
  canary.on("message", () => { packets++; });
  await new Promise<void>(resolve => canary.bind(0, "127.0.0.1", resolve));
  const node = new DHT({ bootstrap: relay.bootstrap, host: "127.0.0.1", firewalled: false });
  let socket: WebSocket | undefined;
  try {
    await node.ready();
    const named = names(canary.address().port);
    if (named) {
      const remoteAddress = node.remoteAddress.bind(node);
      node.remoteAddress = () => (remoteAddress() ? named : null);
    }
    let received = 0;
    const server = node.createServer((stream: Stream) => {
      stream.on("error", () => {});
      stream.on("data", (data: Buffer) => { if (data.includes(MARKER)) received++; });
    });
    const keyPair = DHT.keyPair();
    await server.listen(keyPair);
    if (relays) Object.defineProperty(server, "relayAddresses", { get: () => [{ host: "127.0.0.1", port: canary.address().port }] });
    const ws = socket = new WebSocket(relay.url);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    const client = new RelayedDHT(new WebSocketStream(true, ws), { custodial }) as { connect(publicKey: Buffer): Stream };
    let reached = 0;
    for (let n = 0; n < dials; n++) {
      received = 0;
      const stream = client.connect(keyPair.publicKey).on("error", () => {});
      await new Promise(resolve => stream.once("open", resolve));
      for (let i = 0; i < 20; i++) stream.write(Buffer.concat([MARKER, Buffer.alloc(1016, i)]));
      for (const end = Date.now() + 5000; received === 0 && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50));
      // Whatever was on its way to the canary has come by now.
      await new Promise(resolve => setTimeout(resolve, 500));
      stream.destroy();
      if (received > 0) reached++;
    }
    return { packets, received: reached };
  } finally {
    socket?.close();
    await node.destroy();
    canary.close();
    await relay.close();
  }
}

it("sends a dial's stream to where the far server was reached, not to an address it names", async () => {
  const { packets, received } = await dial(canary => ({ host: "127.0.0.1", port: canary }));
  expect(packets).toBe(0);
  expect(received).toBeGreaterThan(0);
}, 30_000);

it("does the same for a custodial client's dial", async () => {
  const { packets, received } = await dial(canary => ({ host: "127.0.0.1", port: canary }), { custodial: true });
  expect(packets).toBe(0);
  expect(received).toBeGreaterThan(0);
}, 30_000);

it("still connects a far server that names its own address", async () => {
  const { packets, received } = await dial(() => null);
  expect(packets).toBe(0);
  expect(received).toBeGreaterThan(0);
}, 30_000);

it("does not dial again through relays a far server names", async () => {
  const { packets, received } = await dial(() => null, { relays: true, dials: 2 });
  expect(packets).toBe(0);
  expect(received).toBe(2);
}, 30_000);
