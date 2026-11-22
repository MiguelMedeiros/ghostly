import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AudioSocket, MAX_UNREAD_MS } from "../src/calls/audioSocket";
import { bytesToMs, FRAME_MS, frameBytes, type CallRate } from "../src/calls/pcm";
// covers: headless.calls

/**
 * A program that stops reading the call's audio (a voice agent that pauses to think) finds at most `MAX_UNREAD_MS` of
 * it waiting when it reads again, what the kernel's socket buffer holds included: the frames past that are dropped.
 * Real Unix sockets in a temp folder, no call. The kernel's own share is measured here, on this system, as a program
 * that reads nothing sees it, in the smallest writes the daemon makes (a 16th of a frame): only where it alone holds
 * more than `MAX_UNREAD_MS` even then is that the bound. On dev the daemon's own buffer came on top of the kernel's.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "gua-"));
  dirs.push(dir);
  return dir;
}

async function until(check: () => unknown, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Waits until `count` stops growing (200 ms without a byte more), once it has started. */
async function settled(count: () => number): Promise<void> {
  await until(() => count() > 0);
  for (let last = -1; count() !== last;) {
    last = count();
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Bytes the kernel takes in 16ths of `rate`'s frames, one per write, for a reader in this process that reads none. */
async function kernelHolds(rate: CallRate): Promise<number> {
  const path = join(folder(), "k.sock");
  let held = 0;
  const server = createServer((writer) => {
    writer.on("error", () => {});
    const frame = Buffer.alloc(frameBytes(rate) / 16);
    // All in one turn of the event loop: the reader cannot read before it ends.
    for (let i = 0; i < 1500 * 16; i++) {
      writer.write(frame);
      if (writer.writableLength > 0) { held += frame.length - writer.writableLength; break; }
      held += frame.length;
    }
    writer.destroy();
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const reader = connect(path);
  reader.on("error", () => {});
  await until(() => held > 0);
  reader.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return held;
}

/** A program that connects, then reads nothing (its reads stopped in the kernel, not in a buffer of its own) until `resume`. */
async function stoppedProgram(path: string): Promise<{ socket: Socket; read: () => number }> {
  let read = 0;
  const socket = connect({ path, onread: { buffer: Buffer.alloc(64 * 1024), callback: (n: number) => { read += n; return true; } } });
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.pause();
  return { socket, read: () => read };
}

describe("a program that stops reading the call's audio", () => {
  for (const rate of [8000, 48000] as const) {
    it(`finds at most ${MAX_UNREAD_MS} ms waiting when it reads again at ${rate} Hz, the kernel's buffer included, or what the kernel alone holds where that is more`, async () => {
      const kernelMs = bytesToMs(rate, await kernelHolds(rate));
      const dir = folder();
      const socket = await AudioSocket.open(join(dir, "a.sock"), rate, { onAudio: () => {} });
      const program = await stoppedProgram(socket.path);
      await until(() => socket.connected);
      // 30 s of the contact's voice while it reads nothing, a few frames per turn of the event loop.
      const frame = Buffer.alloc(frameBytes(rate), 1);
      for (let i = 0; i < 1500; i++) {
        socket.write(frame);
        if (i % 5 === 4) await tick();
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(program.read()).toBe(0);
      program.socket.resume();
      // Everything it reads now was written while it read nothing: how far behind it is.
      await settled(program.read);
      const behindMs = bytesToMs(rate, program.read());
      // One frame of slack: the frame the kernel took only part of.
      expect(behindMs).toBeLessThanOrEqual(Math.max(MAX_UNREAD_MS, kernelMs) + FRAME_MS);
      expect(socket.dropped).toBeGreaterThan(0);
      program.socket.destroy();
      await socket.close();
    }, 20_000);
  }

  it("loses nothing while it keeps up, frames coming faster than real time", async () => {
    const rate = 48000;
    const socket = await AudioSocket.open(join(folder(), "a.sock"), rate, { onAudio: () => {} });
    let read = 0;
    const program = connect(socket.path);
    program.on("data", (chunk: Buffer) => { read += chunk.length; });
    await until(() => socket.connected);
    const frame = Buffer.alloc(frameBytes(rate), 1);
    for (let i = 0; i < 250; i++) {
      socket.write(frame);
      if (i % 3 === 2) await tick();
    }
    await until(() => read === 250 * frame.length);
    expect(socket.dropped).toBe(0);
    program.destroy();
    await socket.close();
  });
});
