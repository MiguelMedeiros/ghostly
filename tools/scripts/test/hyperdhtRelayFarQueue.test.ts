import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * What a client sends toward a far peer that stops taking it is bounded: a UDX stream has no limit of its own on what
 * waits for its far end's acks, so the relay counts it with what waits for the client itself (`queuedBytes`). One stream
 * past half of it is closed; a client past all of it is dropped.
 */

type Stream = {
  write(data: Buffer): boolean;
  once(event: string, f: (...args: unknown[]) => void): Stream;
  on(event: string, f: (...args: unknown[]) => void): Stream;
};

const MiB = 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

/** A HyperDHT server on the relay's testnet, in a process of its own: SIGSTOP freezes it, acks and all. */
const FAR = `
import DHT from "hyperdht";
const node = new DHT({ bootstrap: JSON.parse(process.argv[1]), host: "127.0.0.1", firewalled: false });
const server = node.createServer(stream => { stream.on("error", () => {}); stream.on("data", () => {}); console.log("connected"); });
const keyPair = DHT.keyPair();
await server.listen(keyPair);
console.log(keyPair.publicKey.toString("hex"));
`;

/**
 * A relay with `queuedBytes` of 1 MiB and its byte budget out of the way (what is bounded is what piles up, not how fast
 * it comes), a far peer on its testnet, and a relay client whose `count` dials to it have opened, the far peer frozen
 * since. `run` gets them and is cleaned up after.
 */
async function frozen(count: number, run: (on: { relay: Awaited<ReturnType<typeof startRelay>>; socket: WebSocket; streams: Stream[]; lines: string[]; closed: () => boolean }) => Promise<void>) {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 3, limits: { bytesPerSecond: 1024 * MiB, burstBytes: 1024 * MiB, queuedBytes: MiB }, log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
  const far = spawn(process.execPath, ["--input-type=module", "-e", FAR, JSON.stringify(relay.bootstrap)], { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "inherit"] });
  const farLines = createInterface({ input: far.stdout! })[Symbol.asyncIterator]();
  let socket: WebSocket | undefined;
  try {
    const publicKey = Buffer.from(String((await farLines.next()).value), "hex");
    const ws = socket = new WebSocket(relay.url);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    let closed = false;
    ws.addEventListener("close", () => { closed = true; });
    const node = new RelayedDHT(new WebSocketStream(true, ws), { custodial: false }) as { connect(publicKey: Buffer): Stream };
    const streams: Stream[] = [];
    for (let i = 0; i < count; i++) {
      const stream = node.connect(publicKey).on("error", () => {});
      await new Promise(resolve => stream.once("open", resolve));
      expect((await farLines.next()).value).toBe("connected");
      streams.push(stream);
    }
    far.kill("SIGSTOP");
    await run({ relay, socket: ws, streams, lines, closed: () => closed });
  } finally {
    far.kill("SIGKILL");
    socket?.close();
    await relay.close();
  }
}

/**
 * Writes `bytes` to `stream` in 64 KiB writes, each once the client's own stream and socket have drained (what this
 * process holds past its start is then the relay's), until `stop`. Resolves with what it wrote and the most this process
 * held meanwhile, past its start, half a second after too.
 */
async function send(stream: Stream, socket: WebSocket, bytes: number, stop: () => boolean) {
  let streamClosed = false;
  stream.once("close", () => { streamClosed = true; });
  const before = process.memoryUsage().arrayBuffers;
  let most = 0;
  let sent = 0;
  for (; sent < bytes && !stop() && !streamClosed; sent += CHUNK.length) {
    if (!stream.write(CHUNK)) await new Promise(resolve => stream.once("drain", resolve));
    while (socket.bufferedAmount > 0 && !stop()) await new Promise(resolve => setTimeout(resolve, 1));
    most = Math.max(most, process.memoryUsage().arrayBuffers - before);
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  return { sent, most: Math.max(most, process.memoryUsage().arrayBuffers - before), streamClosed };
}

it("closes a stream whose far peer has stopped taking what the client sends, past half of queuedBytes", async () => {
  await frozen(1, async ({ socket, streams: [stream], lines, closed }) => {
    const { sent, most, streamClosed } = await send(stream, socket, 20 * MiB, closed);
    // Before, the relay took all 20 MiB (about 54 MB of this process, and it would have gone on taking whatever came next)
    // and closed nothing. Now the stream is closed once the relay holds 512 KiB for it; what else is counted here is the
    // sockets' own buffers and garbage not collected yet.
    expect(streamClosed).toBe(true);
    expect(sent).toBeLessThanOrEqual(MiB / 2 + CHUNK.length);
    expect(most).toBeLessThan(8 * MiB);
    expect(lines).toContain("closed far queue");
    // The client itself stays: only that conversation was stuck.
    expect(closed()).toBe(false);
  });
}, 60_000);

it("drops a client whose streams together hold more than queuedBytes toward far peers that have stopped taking it", async () => {
  await frozen(3, async ({ relay, socket, streams, lines, closed }) => {
    // 448 KiB each: under half of `queuedBytes` per stream, over all of it by the third.
    for (const stream of streams) await send(stream, socket, 7 * CHUNK.length, closed);
    expect(closed()).toBe(true);
    expect(lines).toContain("dropped queue");
    expect(lines).not.toContain("closed far queue");
    expect(relay.stats()).toMatchObject({ clients: 0, dropped: 1 });
  });
}, 60_000);
