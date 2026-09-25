import { describe, expect, it, vi } from "vitest";
import { PairedFiles } from "../src/pairedFiles";
import { LIMITS, type FrameChannel } from "../src/frames";
import type { FileSink } from "../src/files";
// covers: files.paired.send, files.voice.meta
const file = { id: "abcdefgh12345678", name: "test.bin", mime: "application/octet-stream", size: 70001, timestamp: 10 };
async function* source(size = file.size) { yield new Uint8Array(size).fill(123); }
function setup(sink?: FileSink | null, mutate?: (frame: string) => string) {
  const bytes: Uint8Array[] = [];
  const completed = vi.fn(); const failed = vi.fn(); const received = vi.fn();
  const close = vi.fn();
  // eslint-disable-next-line prefer-const -- the channels below close over these before either exists.
  let a!: PairedFiles; let b!: PairedFiles;
  let left = Promise.resolve(), right = Promise.resolve();
  const ca: FrameChannel = { bufferedAmount: 0, drained: async () => {}, close() {}, onClose: null, onMessage: null,
    send(data) { right = right.then(() => b.handle(JSON.parse(mutate ? mutate(String(data)) : String(data)))); } };
  const cb: FrameChannel = { ...ca, send(data) { left = left.then(() => a.handle(JSON.parse(String(data)))); } };
  a = new PairedFiles(ca, { onIncoming: () => null, onComplete: completed, onFailed: failed });
  const onStored = vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined);
  b = new PairedFiles(cb, { onIncoming: received.mockImplementation(() => sink === undefined ? { write: (chunk: Uint8Array) => { bytes.push(chunk); }, close, abort: vi.fn() } : sink), onStored });
  return { a, b, bytes, completed, failed, close, received, onStored };
}
describe("paired files with durable receipts", () => {
  it("streams bounded text chunks and confirms only verified stored bytes", async () => {
    const t = setup();
    try {
      await t.a.send(file, source());
      expect(t.bytes.reduce((n, b) => n + b.length, 0)).toBe(file.size);
      expect(t.bytes.every(b => b.length <= 16384 && b.every(x => x === 123))).toBe(true);
      expect(t.close).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
      expect(t.completed).toHaveBeenCalledWith(file.id, "out");
    } finally { t.a.closeAll(); t.b.closeAll(); }
  });
  it("does not complete until the receiver commits to storage", async () => {
    let commit!: () => void;
    const closing = new Promise<void>(resolve => { commit = resolve; });
    const close = vi.fn(() => closing);
    const t = setup({ write() {}, close, abort() {} });
    const sending = t.a.send(file, source());
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(t.completed).not.toHaveBeenCalled(); commit(); await sending;
    t.a.closeAll(); t.b.closeAll();
  });
  it("refuses corrupt content even with the right byte count", async () => {
    const t = setup(undefined, data => {
      const frame = JSON.parse(data); if (frame.t === "pf-chunk") frame.data = frame.data.replace(/^./, "A"); return JSON.stringify(frame);
    });
    await expect(t.a.send(file, source())).rejects.toThrow(/refused/);
    expect(t.close).not.toHaveBeenCalled(); expect(t.completed).not.toHaveBeenCalled(); t.a.closeAll(); t.b.closeAll();
  });
  it("propagates storage failure and permits an explicit retry", async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(undefined);
    const t = setup({ write() {}, close, abort() {} });
    await expect(t.a.send(file, source())).rejects.toThrow(/refused/);
    await t.a.send(file, source()); expect(t.completed).toHaveBeenCalledOnce(); t.a.closeAll(); t.b.closeAll();
  });
  it("replays a verified stored file without a second incoming message", async () => {
    const t = setup(); await t.a.send(file, source());
    t.onStored.mockResolvedValue(t.close.mock.calls[0][0]);
    await t.a.send(file, source()); expect(t.received).toHaveBeenCalledOnce(); expect(t.close).toHaveBeenCalledOnce();
    t.a.closeAll(); t.b.closeAll();
  });
  it("refuses unsupported/oversized files and propagates disconnection", async () => {
    const t = setup(null); await expect(t.a.send(file, source())).rejects.toThrow(/refused/);
    await expect(t.a.send({ ...file, size: LIMITS.maxFileBytes + 1 }, source())).rejects.toThrow(/Invalid/);
    t.a.closeAll(); t.b.closeAll(); await expect(t.a.send(file, source())).rejects.toThrow(/closed/);
  });
  it("allows empty files", async () => {
    const t = setup(); await t.a.send({ ...file, size: 0 }, source(0)); expect(t.completed).toHaveBeenCalledOnce(); t.a.closeAll(); t.b.closeAll();
  });
  it("carries a voice message's description with the file, and drops one that does not check out", async () => {
    const voice = { duration: 4200, peaks: [0, 128, 255] };
    const t = setup();
    await t.a.send({ ...file, mime: "audio/webm", voice }, source());
    expect(t.received).toHaveBeenCalledWith({ ...file, mime: "audio/webm", voice });
    t.a.closeAll(); t.b.closeAll();

    // A peer lies about the shape: the file still arrives, as a file.
    const lied = setup(undefined, frame => frame.replace('"peaks":[0,128,255]', '"peaks":[999]'));
    await lied.a.send({ ...file, id: "voice-bad-0001", mime: "audio/webm", voice }, source());
    expect(lied.received).toHaveBeenCalledWith({ ...file, id: "voice-bad-0001", mime: "audio/webm" });
    lied.a.closeAll(); lied.b.closeAll();

    // Not audio: no voice, whatever is announced.
    const other = setup();
    await other.a.send({ ...file, id: "voice-bin-0001", voice }, source());
    expect(other.received).toHaveBeenCalledWith({ ...file, id: "voice-bin-0001" });
    other.a.closeAll(); other.b.closeAll();
  });
});
