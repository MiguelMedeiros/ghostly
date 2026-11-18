import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AudioSocket, audioSocketPath, feedQueue } from "../src/calls/audioSocket";
import { frameBytes, PARTIAL_WAIT_MS, PlaybackQueue } from "../src/calls/pcm";
// covers: headless.calls

/**
 * A new program on a call's audio socket starts on a whole sample: the queue stays with the call, so what the last
 * program left (half a sample above all) must not be paired with the new one's first byte. No call, no audio device:
 * the queue alone, then the socket with a program written in the test.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** One 20 ms frame at 16 kHz whose every sample is `value`. */
function frameOf(value: number): Buffer {
  const frame = Buffer.alloc(frameBytes(16000));
  for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(value, i);
  return frame;
}
const samples = (frame: Buffer): number[] => Array.from({ length: frame.length / 2 }, (_, i) => frame.readInt16LE(i * 2));

async function until(check: () => unknown, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function program(path: string): Promise<{ socket: Socket; ended: Promise<void> }> {
  const socket = connect({ path });
  socket.on("data", () => {});
  const ended = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, ended };
}

describe("a new program on the call's audio", () => {
  it("starts on a whole sample: the last program's leftover, half a sample included, is dropped", () => {
    let now = 0;
    const q = new PlaybackQueue(16000, () => now);
    // Program A: one sample (10000) and half of the next.
    q.push(Buffer.from([0x10, 0x27, 0x10]));
    now += PARTIAL_WAIT_MS;
    expect(samples(q.next().frame)[0]).toBe(10000);
    expect(q.newWriter()).toBe(0);
    // Program B: one frame of 100. Paired with A's odd byte it came out as 25616, 25600, ...
    q.push(frameOf(100));
    const { frame, silent } = q.next();
    expect(silent).toBe(false);
    expect(samples(frame)[0]).toBe(100);
    expect(samples(frame).every((s) => s === 100)).toBe(true);
    expect(q.next().silent).toBe(true);
  });

  it("drops the last program's whole leftover, so the new one is heard at once", () => {
    const q = new PlaybackQueue(16000, () => 0);
    q.push(Buffer.concat([frameOf(7), frameOf(7), frameOf(7)]));
    expect(q.newWriter()).toBe(60);
    expect(q.queuedMs).toBe(0);
    q.push(frameOf(100));
    expect(samples(q.next().frame).every((s) => s === 100)).toBe(true);
  });

  it("starts on a whole sample after a flush that cut the last program's half sample", () => {
    const q = new PlaybackQueue(16000, () => 0);
    q.push(Buffer.from([0x10, 0x27, 0x10]));
    q.flush();
    q.newWriter();
    // The flushed half sample's other half would have been A's next byte: none of B's bytes is taken for it.
    q.push(frameOf(100));
    expect(samples(q.next().frame).every((s) => s === 100)).toBe(true);
  });

  it("the socket: a program that replaces the last one starts the queue afresh; one that has not proved itself does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"));
    dirs.push(dir);
    const path = audioSocketPath(dir, "abc");
    let now = 0;
    const queue = new PlaybackQueue(16000, () => now);
    const fresh = vi.spyOn(queue, "newWriter");
    const handlers = feedQueue(queue);
    let got = 0;
    const socket = await AudioSocket.open(path, 16000, { ...handlers, onAudio: (chunk) => { got += chunk.length; handlers.onAudio(chunk); } }, { requireToken: true, proveMs: 300 });
    try {
      // Program A: the token, then a sample and a half.
      const a = await program(path);
      a.socket.write(Buffer.concat([Buffer.from(`${socket.token}\n`), Buffer.from([0x10, 0x27, 0x10])]));
      await until(() => got === 3);
      const atA = fresh.mock.calls.length;
      now += PARTIAL_WAIT_MS;
      expect(samples(queue.next().frame)[0]).toBe(10000);
      // A connection without the token takes nothing over: A's audio stays.
      const stranger = await program(path);
      await stranger.ended;
      const afterStranger = fresh.mock.calls.length;
      // Program B replaces A (which is closed) and writes one frame of 100.
      const b = await program(path);
      b.socket.write(`${socket.token}\n`);
      await a.ended;
      b.socket.write(frameOf(100));
      await until(() => got === 3 + frameBytes(16000));
      const { frame, silent } = queue.next();
      expect(silent).toBe(false);
      expect(samples(frame)[0]).toBe(100);
      expect(samples(frame).every((s) => s === 100)).toBe(true);
      // Once for A, once for B: never for the connection that did not prove itself.
      expect([atA, afterStranger, fresh.mock.calls.length]).toEqual([1, 1, 2]);
      b.socket.destroy();
    } finally {
      await socket.close();
    }
  });
  it("the socket: a replaced program that keeps its side open is let go, so the socket still closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"));
    dirs.push(dir);
    const path = audioSocketPath(dir, "abc");
    const socket = await AudioSocket.open(path, 16000, feedQueue(new PlaybackQueue(16000)), { requireToken: true, proveMs: 300 });
    // Program A writes only: it never ends its side after the EOF that replacing it sends.
    const a = connect({ path, allowHalfOpen: true });
    a.on("data", () => {});
    await new Promise<void>((resolve) => a.once("connect", resolve));
    a.write(`${socket.token}\n`);
    await until(() => socket.connected);
    const b = await program(path);
    b.socket.write(`${socket.token}\n`);
    await until(() => a.readableEnded);
    try {
      // The call ends: the socket closes within the 2 s it gives the program that is on.
      let closed = false;
      const closing = socket.close().then(() => { closed = true; });
      await until(() => closed, 3500);
      await closing;
    } finally {
      a.destroy();
    }
  });
});
