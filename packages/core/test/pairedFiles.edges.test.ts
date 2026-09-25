import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "../src/bytes";
import type { FileInfo, FileSink } from "../src/files";
import { LIMITS, type FrameChannel } from "../src/frames";
import { PairedFiles } from "../src/pairedFiles";

// covers: files.paired.send, files.size-limit

afterEach(() => void vi.useRealTimers());

const ID = "file-0001";
const CHUNK = 16 * 1024;

function sinkSpy(): FileSink & { written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return { written, write: vi.fn((chunk: Uint8Array) => void written.push(chunk)), close: vi.fn(), abort: vi.fn() };
}

/** A receiving PairedFiles fed frames by hand, with everything it sends recorded. */
function receiver(options: { sink?: FileSink | string | null; onStored?: (file: FileInfo) => Promise<string | undefined> } = {}) {
  const sent: Record<string, unknown>[] = [];
  const sink = options.sink === undefined ? sinkSpy() : options.sink;
  const channel: FrameChannel = {
    bufferedAmount: 0, drained: async () => {}, close() {}, onMessage: null, onClose: null,
    send: (data) => void sent.push(JSON.parse(String(data))),
  };
  const events = { onIncoming: vi.fn(() => sink), onComplete: vi.fn(), onFailed: vi.fn(), onProgress: vi.fn(), onStored: options.onStored };
  const files = new PairedFiles(channel, events);
  const start = (patch: Record<string, unknown> = {}) =>
    files.handle({ t: "pf-start", id: ID, name: "a.txt", mime: "text/plain", size: 3, timestamp: 1, ...patch });
  const chunk = (bytes: Uint8Array, offset = 0, id = ID) => files.handle({ t: "pf-chunk", id, offset, data: toBase64Url(bytes) });
  const end = (offset: number, digest: string, id = ID) => files.handle({ t: "pf-end", id, offset, digest });
  const cancels = () => sent.filter((f) => f.t === "pf-cancel");
  return { files, sent, sink, events, start, chunk, end, cancels };
}

const digestOf = (bytes: Uint8Array) => toBase64Url(sha256(bytes));

describe("paired files: what the receiver refuses", () => {
  it.each([
    ["a non-text name", { name: 5 }],
    ["an overlong name", { name: "n".repeat(1001) }],
    ["a non-text type", { mime: null }],
    ["an overlong type", { mime: "a/".padEnd(131, "b") }],
    ["a size that is not a number", { size: "3" }],
    ["a fractional size", { size: 1.5 }],
    ["a negative size", { size: -1 }],
    ["a size over the file limit", { size: LIMITS.maxFileBytes + 1 }],
    ["a missing timestamp", { timestamp: undefined }],
    ["a zero timestamp", { timestamp: 0 }],
    ["a fractional timestamp", { timestamp: 1.5 }],
  ])("refuses an announcement with %s and tells the sender", async (_, patch) => {
    const r = receiver();
    await r.start(patch);
    expect(r.events.onIncoming).not.toHaveBeenCalled();
    expect(r.cancels()).toEqual([{ t: "pf-cancel", id: ID, target: "sender" }]);
  });

  it("accepts a name and type at their length limits", async () => {
    const r = receiver();
    await r.start({ name: "n".repeat(1000), mime: "a/".padEnd(130, "b") });
    expect(r.sent).toEqual([{ t: "pf-ack", id: ID, phase: "start", offset: 0 }]);
    r.files.closeAll();
  });

  it("ignores frames whose id is missing or malformed", async () => {
    const r = receiver();
    for (const id of [undefined, 5, "short", "has space!", "x".repeat(65)]) await r.start({ id });
    expect(r.sent).toEqual([]);
    expect(r.events.onIncoming).not.toHaveBeenCalled();
  });

  it("acknowledges the same announcement again before any chunk (a transport switch lost the first ack)", async () => {
    const r = receiver();
    await r.start();
    await r.start();
    expect(r.events.onIncoming).toHaveBeenCalledOnce();
    expect(r.sent.map((f) => `${f.t}:${f.phase}:${f.offset}`)).toEqual(["pf-ack:start:0", "pf-ack:start:0"]);
    expect(r.cancels()).toHaveLength(0);
    r.files.closeAll();
  });

  it("refuses a different announcement for a file already in progress, or any once bytes arrived", async () => {
    const other = receiver();
    await other.start();
    await other.start({ name: "another.bin" });
    expect(other.cancels()).toHaveLength(1);
    expect(other.events.onFailed).toHaveBeenCalledWith(ID, "Duplicate active file", "in");
    const late = receiver();
    await late.start();
    await late.chunk(Uint8Array.of(1));
    await late.start();
    expect(late.events.onFailed).toHaveBeenCalledWith(ID, "Duplicate active file", "in");
  });

  it("acknowledges the last chunk again without writing it twice, and refuses an older one", async () => {
    const r = receiver();
    await r.start();
    await r.chunk(Uint8Array.of(1, 2));
    await r.chunk(Uint8Array.of(1, 2));
    expect((r.sink as ReturnType<typeof sinkSpy>).written).toEqual([Uint8Array.of(1, 2)]);
    expect(r.sent.map((f) => `${f.t}:${f.phase}:${f.offset}`)).toEqual(["pf-ack:start:0", "pf-ack:chunk:2", "pf-ack:chunk:2"]);
    await r.chunk(Uint8Array.of(3), 2);
    await r.chunk(Uint8Array.of(1));
    expect(r.events.onFailed).toHaveBeenCalledWith(ID, "Invalid file offset", "in");
  });

  it("keeps at most the per-peer number of incoming files", async () => {
    const r = receiver({ sink: null });
    r.events.onIncoming.mockImplementation(() => sinkSpy());
    for (let i = 0; i <= LIMITS.maxIncomingFilesPerPeer; i++) await r.start({ id: `file-000${i}x` });
    expect(r.events.onIncoming).toHaveBeenCalledTimes(LIMITS.maxIncomingFilesPerPeer);
    expect(r.cancels()).toEqual([{ t: "pf-cancel", id: `file-000${LIMITS.maxIncomingFilesPerPeer}x`, target: "sender" }]);
    r.files.closeAll();
  });

  it("tells the sender when the application refuses, without reporting a failure for a file it never took", async () => {
    const r = receiver({ sink: "Too big for this device" });
    await r.start();
    expect(r.events.onFailed).not.toHaveBeenCalled();
    expect(r.cancels()).toEqual([{ t: "pf-cancel", id: ID, target: "sender" }]);
  });

  it("drops chunks for a file it never accepted", async () => {
    const r = receiver();
    await r.chunk(Uint8Array.of(1));
    expect(r.sent).toEqual([]);
  });

  it("refuses a chunk at the wrong offset", async () => {
    const r = receiver();
    await r.start();
    await r.chunk(Uint8Array.of(1), 1);
    expect(r.events.onFailed).toHaveBeenCalledWith(ID, "Invalid file offset", "in");
    expect((r.sink as FileSink).abort).toHaveBeenCalledOnce();
    expect(r.cancels()).toHaveLength(1);
  });

  it.each([
    ["no data", undefined],
    ["non-text data", 12],
    ["characters outside base64url", "AA+/"],
    ["an encoding longer than a chunk", "A".repeat(Math.ceil((CHUNK * 4) / 3) + 1)],
  ])("refuses a chunk with %s", async (_, data) => {
    const r = receiver();
    await r.start();
    await r.files.handle({ t: "pf-chunk", id: ID, offset: 0, data });
    expect(r.events.onFailed).toHaveBeenCalledWith(ID, "Invalid chunk", "in");
  });

  it("refuses base64url that does not decode, and a chunk that runs past the announced size", async () => {
    const undecodable = receiver();
    await undecodable.start();
    await undecodable.files.handle({ t: "pf-chunk", id: ID, offset: 0, data: "A" });
    expect(undecodable.events.onFailed).toHaveBeenCalledWith(ID, expect.any(String), "in");
    expect(undecodable.cancels()).toHaveLength(1);

    const over = receiver();
    await over.start();
    await over.chunk(Uint8Array.of(1, 2, 3, 4));
    expect(over.events.onFailed).toHaveBeenCalledWith(ID, "Invalid chunk size", "in");
    expect((over.sink as ReturnType<typeof sinkSpy>).written).toEqual([]);
  });

  it("refuses an end frame before every byte arrived, or with the wrong digest", async () => {
    const early = receiver();
    await early.start();
    await early.chunk(Uint8Array.of(1));
    await early.end(1, digestOf(Uint8Array.of(1)));
    expect(early.events.onFailed).toHaveBeenCalledWith(ID, "File integrity check failed", "in");

    const wrong = receiver();
    await wrong.start();
    await wrong.chunk(Uint8Array.of(1, 2, 3));
    await wrong.end(3, digestOf(Uint8Array.of(1, 2, 4)));
    expect(wrong.events.onFailed).toHaveBeenCalledWith(ID, "File integrity check failed", "in");
    expect((wrong.sink as FileSink).close).not.toHaveBeenCalled();
    expect(wrong.events.onComplete).not.toHaveBeenCalled();
  });

  it("accepts the bytes in order and acknowledges only after the sink closed", async () => {
    const r = receiver();
    await r.start();
    await r.chunk(Uint8Array.of(1, 2));
    await r.chunk(Uint8Array.of(3), 2);
    await r.end(3, digestOf(Uint8Array.of(1, 2, 3)));
    expect((r.sink as ReturnType<typeof sinkSpy>).written).toEqual([Uint8Array.of(1, 2), Uint8Array.of(3)]);
    expect((r.sink as FileSink).close).toHaveBeenCalledWith(digestOf(Uint8Array.of(1, 2, 3)));
    expect(r.events.onProgress.mock.calls).toEqual([[ID, 2, "in"], [ID, 3, "in"]]);
    expect(r.events.onComplete).toHaveBeenCalledWith(ID, "in");
    expect(r.sent.map((f) => `${f.t}:${f.phase}:${f.offset}`)).toEqual(["pf-ack:start:0", "pf-ack:chunk:2", "pf-ack:chunk:3", "pf-ack:end:3"]);
    // The entry is gone: a replayed end frame is acknowledged again (its ack may have been lost in a switch), and
    // nothing is written or completed twice; one for another offset is ignored.
    await r.end(3, digestOf(Uint8Array.of(1, 2, 3)));
    expect(r.sent.map((f) => `${f.t}:${f.phase}:${f.offset}`).slice(4)).toEqual(["pf-ack:end:3"]);
    await r.end(2, digestOf(Uint8Array.of(1, 2, 3)));
    expect(r.sent).toHaveLength(5);
    expect(r.events.onComplete).toHaveBeenCalledOnce();
  });
});

describe("paired files: already stored files", () => {
  it("re-verifies a stored file against its digest without a new sink", async () => {
    const bytes = Uint8Array.of(7, 8, 9);
    const r = receiver({ onStored: async () => digestOf(bytes) });
    await r.start();
    expect(r.events.onIncoming).not.toHaveBeenCalled();
    await r.chunk(bytes);
    await r.end(3, digestOf(bytes));
    expect(r.sent.at(-1)).toEqual({ t: "pf-ack", id: ID, phase: "end", offset: 3 });
    expect(r.events.onComplete).not.toHaveBeenCalled();
  });

  it("refuses bytes that do not match what is stored, silently for the application", async () => {
    const r = receiver({ onStored: async () => digestOf(Uint8Array.of(1, 1, 1)) });
    await r.start();
    const bytes = Uint8Array.of(7, 8, 9);
    await r.chunk(bytes);
    await r.end(3, digestOf(bytes));
    expect(r.cancels()).toHaveLength(1);
    expect(r.events.onFailed).not.toHaveBeenCalled();
  });

  it("does nothing when the link closed while the store was being checked", async () => {
    let answer!: (value: string | undefined) => void;
    const r = receiver({ onStored: () => new Promise((resolve) => (answer = resolve)) });
    const starting = r.start();
    r.files.closeAll();
    answer(undefined);
    await starting;
    expect(r.events.onIncoming).not.toHaveBeenCalled();
    expect(r.sent).toEqual([]);
  });
});

describe("paired files: cancellation, stalls and teardown on the receiving side", () => {
  it("fails the incoming file when the sender cancels it, without answering", async () => {
    const r = receiver();
    await r.start();
    await r.files.handle({ t: "pf-cancel", id: ID, target: "receiver" });
    expect(r.events.onFailed).toHaveBeenCalledWith(ID, "Cancelled by sender", "in");
    expect((r.sink as FileSink).abort).toHaveBeenCalledOnce();
    expect(r.cancels()).toEqual([]);
  });

  it("gives up on a transfer that stalls and tells the sender", async () => {
    vi.useFakeTimers();
    const r = receiver();
    await r.start();
    await vi.advanceTimersByTimeAsync(LIMITS.bodyIdleTimeoutMs - 1);
    await r.chunk(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(LIMITS.bodyIdleTimeoutMs - 1);
    expect(r.events.onFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.events.onFailed).toHaveBeenCalledWith(ID, "File transfer stalled", "in");
    expect(r.cancels()).toHaveLength(1);
  });

  it("does not acknowledge a chunk whose write finished after the transfer was cancelled", async () => {
    let finishWrite!: () => void;
    const sink = { ...sinkSpy(), write: vi.fn(() => new Promise<void>((resolve) => (finishWrite = resolve))) };
    const r = receiver({ sink });
    await r.start();
    const writing = r.chunk(Uint8Array.of(1));
    await r.files.handle({ t: "pf-cancel", id: ID, target: "receiver" });
    finishWrite();
    await writing;
    expect(r.sent.filter((f) => f.phase === "chunk")).toEqual([]);
  });

  it("does not acknowledge an end whose close finished after the transfer was cancelled", async () => {
    let finishClose!: () => void;
    const sink = { ...sinkSpy(), close: vi.fn(() => new Promise<void>((resolve) => (finishClose = resolve))) };
    const r = receiver({ sink });
    await r.start();
    await r.chunk(Uint8Array.of(1, 2, 3));
    const ending = r.end(3, digestOf(Uint8Array.of(1, 2, 3)));
    await r.files.handle({ t: "pf-cancel", id: ID, target: "receiver" });
    finishClose();
    await ending;
    expect(r.sent.filter((f) => f.phase === "end")).toEqual([]);
    expect(r.events.onComplete).not.toHaveBeenCalled();
  });

  it("aborts every incoming file and ignores all frames once closed", async () => {
    const r = receiver();
    await r.start();
    r.files.closeAll();
    expect((r.sink as FileSink).abort).toHaveBeenCalledOnce();
    expect(r.events.onFailed).toHaveBeenCalledWith(ID, "Connection lost", "in");
    await r.start({ id: "file-0002" });
    expect(r.sent).toEqual([{ t: "pf-ack", id: ID, phase: "start", offset: 0 }]);
  });
});

/** A sending PairedFiles whose peer answers with `reply`, frame by frame. */
function sender(reply: (frame: Record<string, unknown>, files: PairedFiles) => void | Promise<void>) {
  const sent: Record<string, unknown>[] = [];
  // eslint-disable-next-line prefer-const -- the channel closes over it before it exists.
  let files!: PairedFiles;
  const channel: FrameChannel = {
    bufferedAmount: 0, drained: async () => {}, close() {}, onMessage: null, onClose: null,
    send(data) {
      const frame = JSON.parse(String(data));
      sent.push(frame);
      queueMicrotask(() => void reply(frame, files));
    },
  };
  const events = { onIncoming: () => null, onComplete: vi.fn(), onFailed: vi.fn(), onProgress: vi.fn() };
  files = new PairedFiles(channel, events);
  return { files, sent, events };
}
const ackAll = (frame: Record<string, unknown>, files: PairedFiles) => {
  if (frame.t === "pf-start") return files.handle({ t: "pf-ack", id: frame.id, phase: "start", offset: 0 });
  if (frame.t === "pf-chunk") {
    const length = Buffer.from(String(frame.data), "base64url").length;
    return files.handle({ t: "pf-ack", id: frame.id, phase: "chunk", offset: Number(frame.offset) + length });
  }
  if (frame.t === "pf-end") return files.handle({ t: "pf-ack", id: frame.id, phase: "end", offset: frame.offset });
};
const info: FileInfo = { id: ID, name: "../../evil‮txt.exe", mime: "TEXT/HTML", size: 3, timestamp: 5 };
async function* bytes(...parts: number[][]) {
  for (const part of parts) yield Uint8Array.from(part);
}

describe("paired files: the sending side", () => {
  it("announces a sanitized name and type and reports progress per chunk", async () => {
    const s = sender(ackAll);
    await s.files.send(info, bytes([1], [2, 3]));
    expect(s.sent[0]).toMatchObject({ t: "pf-start", id: ID, name: "eviltxt.exe", mime: "text/html", size: 3 });
    expect(s.events.onProgress.mock.calls).toEqual([[ID, 1, "out"], [ID, 3, "out"]]);
    expect(s.sent.at(-1)).toEqual({ t: "pf-end", id: ID, offset: 3, digest: digestOf(Uint8Array.of(1, 2, 3)) });
    expect(s.events.onComplete).toHaveBeenCalledWith(ID, "out");
  });

  it.each([
    ["an invalid id", { id: "bad id" }],
    ["a negative size", { size: -1 }],
    ["a fractional size", { size: 1.5 }],
    ["an oversized file", { size: LIMITS.maxFileBytes + 1 }],
  ])("refuses to send %s before anything goes out", async (_, patch) => {
    const s = sender(ackAll);
    await expect(s.files.send({ ...info, ...patch }, bytes([1]))).rejects.toThrow("Invalid file or connection closed");
    expect(s.sent).toEqual([]);
  });

  it("refuses a second send of the same file, or beyond the concurrent limit", async () => {
    const s = sender(() => {});
    const first = s.files.send(info, bytes([1, 2, 3]));
    await expect(s.files.send(info, bytes([1, 2, 3]))).rejects.toThrow("File transfer already active");
    const others = ["file-0002", "file-0003"].map((id) => s.files.send({ ...info, id }, bytes([1, 2, 3])));
    await expect(s.files.send({ ...info, id: "file-0004" }, bytes([1, 2, 3]))).rejects.toThrow("File transfer already active");
    s.files.closeAll();
    await expect(first).rejects.toThrow("Connection lost");
    await Promise.allSettled(others);
  });

  it("fails when the source yields more bytes than announced, and cancels the receiver", async () => {
    const s = sender(ackAll);
    await expect(s.files.send(info, bytes([1, 2], [3, 4]))).rejects.toThrow("File changed during transfer");
    expect(s.sent.at(-1)).toEqual({ t: "pf-cancel", id: ID, target: "receiver" });
    expect(s.events.onFailed).toHaveBeenCalledWith(ID, "File changed during transfer", "out");
  });

  it("fails when the source yields fewer bytes than announced", async () => {
    const s = sender(ackAll);
    await expect(s.files.send(info, bytes([1, 2]))).rejects.toThrow("Incomplete file");
  });

  it("splits a large part into chunks of at most 16 KiB, each waiting for its acknowledgement", async () => {
    const s = sender(ackAll);
    const size = CHUNK * 2 + 1;
    await s.files.send({ ...info, size }, (async function* () { yield new Uint8Array(size); })());
    expect(s.sent.filter((f) => f.t === "pf-chunk").map((f) => f.offset)).toEqual([0, CHUNK, CHUNK * 2]);
  });

  it("times out when the receiver never acknowledges", async () => {
    vi.useFakeTimers();
    const s = sender(() => {});
    const sending = s.files.send(info, bytes([1, 2, 3]));
    const failed = expect(sending).rejects.toThrow("File transfer timed out");
    await vi.advanceTimersByTimeAsync(LIMITS.bodyIdleTimeoutMs);
    await failed;
  });

  it("ignores acknowledgements for another phase or offset, and malformed ones", async () => {
    vi.useFakeTimers();
    const s = sender((frame, files) => {
      if (frame.t !== "pf-start") return;
      void files.handle({ t: "pf-ack", id: frame.id, phase: "chunk", offset: 0 });
      void files.handle({ t: "pf-ack", id: frame.id, phase: "start", offset: 1 });
      void files.handle({ t: "pf-ack", id: frame.id, phase: "start", offset: "0" });
      void files.handle({ t: "pf-ack", id: frame.id, phase: "other", offset: 0 });
    });
    const sending = s.files.send(info, bytes([1, 2, 3]));
    const failed = expect(sending).rejects.toThrow("File transfer timed out");
    await vi.advanceTimersByTimeAsync(LIMITS.bodyIdleTimeoutMs);
    await failed;
    expect(s.sent.filter((f) => f.t === "pf-chunk")).toEqual([]);
  });

  it("stops when the receiver refuses the file", async () => {
    const s = sender((frame, files) => files.handle({ t: "pf-cancel", id: frame.id, target: "sender" }));
    await expect(s.files.send(info, bytes([1, 2, 3]))).rejects.toThrow("Peer refused or could not store the file");
  });

  it("a refusal for one file leaves another file's transfer alone", async () => {
    const s = sender((frame, files) => {
      if (frame.id === "file-0002") return files.handle({ t: "pf-cancel", id: "file-0002", target: "sender" });
      return ackAll(frame, files);
    });
    const other = s.files.send({ ...info, id: "file-0002" }, bytes([1, 2, 3]));
    await s.files.send(info, bytes([1, 2, 3]));
    await expect(other).rejects.toThrow("refused");
  });

  it("fails at once when the channel refuses to send", async () => {
    const s = sender(ackAll);
    const failing = new PairedFiles(
      { bufferedAmount: 0, drained: async () => {}, close() {}, onMessage: null, onClose: null, send: () => { throw new Error("socket gone"); } },
      s.events,
    );
    await expect(failing.send(info, bytes([1, 2, 3]))).rejects.toThrow("socket gone");
    expect(s.events.onFailed).toHaveBeenCalledWith(ID, "socket gone", "out");
  });

  it("refuses to send once closed", async () => {
    const s = sender(ackAll);
    s.files.closeAll();
    await expect(s.files.send(info, bytes([1, 2, 3]))).rejects.toThrow("Invalid file or connection closed");
  });
});

describe("paired files: a transport switch mid-transfer", () => {
  it("sends what awaits its acknowledgement again on the new channel, and finishes there", async () => {
    // The old channel swallows everything from the first chunk on, as one closing under a switch would.
    let lost = false;
    const s = sender((frame, files) => { if (frame.t === "pf-chunk") lost = true; if (!lost) return ackAll(frame, files); });
    const moved: Record<string, unknown>[] = [];
    const next: FrameChannel = {
      bufferedAmount: 0, drained: async () => {}, close() {}, onMessage: null, onClose: null,
      send(data) { const frame = JSON.parse(String(data)); moved.push(frame); queueMicrotask(() => void ackAll(frame, s.files)); },
    };
    const done = s.files.send({ ...info, size: 3 }, bytes([1, 2, 3]));
    await vi.waitFor(() => expect(lost).toBe(true));
    s.files.rebind(next);
    await done;
    expect(moved.map(f => `${f.t}:${f.offset}`)).toEqual(["pf-chunk:0", "pf-end:3"]);
    // Closed, it takes nothing more.
    s.files.closeAll();
    s.files.rebind(next);
    expect(moved).toHaveLength(2);
  });
});
