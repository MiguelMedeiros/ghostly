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

/**
 * A HyperDHT server on the relay's testnet, in a process of its own: SIGSTOP freezes it, acks and all. It says how much
 * it has received each time that passes another 64 KiB.
 */
const FAR = `
import DHT from "hyperdht";
const node = new DHT({ bootstrap: JSON.parse(process.argv[1]), host: "127.0.0.1", firewalled: false });
const server = node.createServer(stream => {
  let got = 0;
  stream.on("error", () => {});
  stream.on("data", data => { const before = Math.floor(got / 65536); got += data.length; if (Math.floor(got / 65536) !== before) console.log("got " + got); });
  console.log("connected");
});
const keyPair = DHT.keyPair();
await server.listen(keyPair);
console.log(keyPair.publicKey.toString("hex"));
`;

/**
 * A relay with `queuedBytes` of 1 MiB and its byte budget out of the way (what is bounded is what piles up, not how fast
 * it comes), a far peer on its testnet, and a relay client whose `count` dials to it have opened, the far peer frozen
 * since (unless not `freeze`, then `received` resolves once it has received at least `bytes`). `run` gets them and is
 * cleaned up after.
 */
async function frozen(count: number, run: (on: { relay: Awaited<ReturnType<typeof startRelay>>; socket: WebSocket; streams: Stream[]; lines: string[]; closed: () => boolean; received: (bytes: number) => Promise<void> }) => Promise<void>, { setup, freeze = true }: { setup?: (relay: Awaited<ReturnType<typeof startRelay>>) => void; freeze?: boolean } = {}) {
  const lines: string[] = [];
  const relay = await startRelay({ testnet: 3, limits: { bytesPerSecond: 1024 * MiB, burstBytes: 1024 * MiB, queuedBytes: MiB }, log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
  setup?.(relay);
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
    if (freeze) far.kill("SIGSTOP");
    let got = 0;
    const received = async (bytes: number) => {
      while (got < bytes) {
        const line = await farLines.next();
        if (line.done) throw new Error(`far peer gone after ${got} bytes`);
        if (String(line.value).startsWith("got ")) got = Number(String(line.value).slice(4));
      }
    };
    await run({ relay, socket: ws, streams, lines, closed: () => closed, received });
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

type Write = { buffer: Buffer | null; buffers: Buffer[] | null };
type Raw = { _writev(buffers: Buffer[], cb: unknown): void; _wreqs: Write[] };

it("weighs what a stream holds toward a frozen far peer without going over every write it holds, at each write", async () => {
  // What the relay's UDX streams hold until their far end acks, counted each time one of its writes (`_wreqs`), or a
  // buffer in one of its batches, is read: where the relay used to go over all of them again after every write the client
  // sent. Counted whether UDX hands the writes down one by one or batched, which depends on how fast they come.
  let visits = 0;
  let counting = true;
  let taken = 0;
  const counted = <T extends object>(list: T) => new Proxy(list, { get: (target, key, receiver) => { if (counting && typeof key === "string" && /^\d+$/.test(key)) visits++; return Reflect.get(target, key, receiver); } });
  const count = (relay: Awaited<ReturnType<typeof startRelay>>) => {
    const dht = relay.dht as unknown as { createRawStream(...args: unknown[]): Raw; connect(...args: unknown[]): { write(...args: unknown[]): boolean } };
    // Each write the relay makes on a dial for its client (counted before the relay weighs that stream).
    const connect = dht.connect.bind(dht);
    dht.connect = (...args) => {
      const stream = connect(...args);
      const write = stream.write;
      stream.write = function (...args) { taken++; return write.apply(this, args); };
      return stream;
    };
    const create = dht.createRawStream.bind(dht);
    dht.createRawStream = (...args) => {
      const raw = create(...args);
      let writes = counted(raw._wreqs);
      Object.defineProperty(raw, "_wreqs", { get: () => writes, set: list => { writes = counted(list); }, configurable: true });
      const writev = raw._writev;
      raw._writev = function (buffers, cb) {
        writev.call(this, buffers, cb);
        counting = false;
        const write = this._wreqs.find(write => write.buffers === buffers);
        counting = true;
        if (write) write.buffers = counted(buffers);
      };
      return raw;
    };
  };
  await frozen(1, async ({ streams: [stream], lines, closed }) => {
    let streamClosed = false;
    stream.once("close", () => { streamClosed = true; });
    // 10,000 writes of 16 bytes at once (about 360 KiB with their framing, under half of `queuedBytes`): the far peer acks
    // none of them, so the relay's UDX stream holds them all.
    const WRITES = 10_000;
    const small = Buffer.alloc(16, 0x62);
    visits = 0;
    taken = 0;
    for (let i = 0; i < WRITES; i++) stream.write(small);
    // Until the relay has written every one of them on its dial, however long that takes here.
    const deadline = Date.now() + 40_000;
    while (taken < WRITES && !streamClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    // Before, thousands of writes and buffers looked at per write (tens of millions in all, growing with the square of
    // the writes); now the one each write is handed down as, and none of the others until the far peer acks.
    expect(visits / WRITES).toBeLessThan(2);
    expect(taken).toBeGreaterThanOrEqual(WRITES);
    // The bound still holds, and this burst stays under it.
    expect(streamClosed).toBe(false);
    expect(closed()).toBe(false);
    expect(lines).not.toContain("closed far queue");
  }, { setup: count });
}, 60_000);

it("keeps a stream open whose far peer takes what is sent, however much passes through it", async () => {
  await frozen(1, async ({ streams: [stream], lines, closed, received }) => {
    let streamClosed = false;
    const closing = new Promise<void>(resolve => stream.once("close", () => { streamClosed = true; resolve(); }));
    // 8 MiB, sixteen times the bound, 64 KiB at a time, each once the far peer has received all before it: the relay
    // then holds about one write for it, whatever the pace of this machine's loopback. What the far peer acks is no longer
    // counted as held; counted still, the stream would be closed past 512 KiB.
    let sent = 0;
    while (sent < 8 * MiB && !streamClosed && !closed()) {
      stream.write(CHUNK);
      await Promise.race([received(sent + CHUNK.length), closing]);
      if (!streamClosed) sent += CHUNK.length;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(sent).toBe(8 * MiB);
    expect(streamClosed).toBe(false);
    expect(closed()).toBe(false);
    expect(lines).not.toContain("closed far queue");
  }, { freeze: false });
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
