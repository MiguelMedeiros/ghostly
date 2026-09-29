import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTransfers, type FileInfo, type FileSink } from "../src/files";
import { CHUNK_KIND, LIMITS, decodeChunk, decodeControl, type FileFrame, type FrameChannel } from "../src/frames";

// covers: files.legacy.send, files.size-limit

afterEach(() => void vi.useRealTimers());

/** FileTransfers on a channel that records what it sends; frames from the peer are fed by hand. */
function transfers(onIncoming: () => FileSink | string | null = () => sinkSpy()) {
  const sent: (string | Uint8Array)[] = [];
  const channel: FrameChannel & { broken: boolean } = {
    broken: false,
    bufferedAmount: 0, drained: async () => {}, close() {}, onMessage: null, onClose: null,
    send(data) {
      if (this.broken) throw new Error("Data link is not open");
      sent.push(data);
    },
  };
  const events = { onIncoming: vi.fn(onIncoming), onComplete: vi.fn(), onFailed: vi.fn(), onProgress: vi.fn() };
  const files = new FileTransfers(channel, events);
  const controls = () => sent.filter((s): s is string => typeof s === "string").map((s) => decodeControl(s));
  const chunk = (id: number, payload: number[], end = false) =>
    files.handleChunk({ kind: CHUNK_KIND.fileBody, id, end, payload: Uint8Array.from(payload) });
  return { files, channel, sent, events, controls, chunk };
}

function sinkSpy(): FileSink & { written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return { written, write: vi.fn((c: Uint8Array) => void written.push(c)), close: vi.fn(), abort: vi.fn() };
}

const announce = (patch: Partial<FileFrame> = {}): FileFrame => ({ t: "file", id: 1, f: "file-0001", ts: 1, n: "a.txt", s: 3, m: "text/plain", ...patch });
const info: FileInfo = { id: "file-0001", name: "a.txt", size: 3, mime: "text/plain", timestamp: 1 };
async function* parts(...list: number[][]) {
  for (const part of list) yield Uint8Array.from(part);
}

describe("files: receiving", () => {
  it("ignores a second announcement on a stream already receiving", () => {
    const t = transfers();
    t.files.handleFile(announce());
    t.files.handleFile(announce({ f: "file-0002" }));
    expect(t.events.onIncoming).toHaveBeenCalledOnce();
    expect(t.sent).toEqual([]);
  });

  it("accepts a file of exactly the size limit and refuses one byte more", () => {
    const t = transfers();
    t.files.handleFile(announce({ s: LIMITS.maxFileBytes }));
    expect(t.events.onIncoming).toHaveBeenCalledOnce();
    t.files.handleFile(announce({ id: 2, s: LIMITS.maxFileBytes + 1 }));
    expect(t.controls()).toEqual([{ t: "rst", id: 2, d: "f", e: "file too large" }]);
    t.files.closeAll();
  });

  it("sanitizes the announced name and type before the application sees them", () => {
    const t = transfers();
    t.files.handleFile(announce({ n: "../../.ssh/authorized_keys", m: "text/html; charset=utf-8" }));
    expect(t.events.onIncoming).toHaveBeenCalledWith({ id: "file-0001", name: "sshauthorized_keys", size: 3, mime: "application/octet-stream", timestamp: 1 });
    t.files.closeAll();
  });

  it("drops chunks for streams it is not receiving", () => {
    const t = transfers();
    t.chunk(9, [1], true);
    expect(t.sent).toEqual([]);
    expect(t.events.onFailed).not.toHaveBeenCalled();
  });

  it("aborts and tells the sender when more bytes arrive than announced", () => {
    const t = transfers();
    const sink = sinkSpy();
    t.events.onIncoming.mockReturnValue(sink);
    t.files.handleFile(announce());
    t.chunk(1, [1, 2]);
    t.chunk(1, [3, 4]);
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(t.controls()).toEqual([{ t: "rst", id: 1, d: "f", e: "more data than announced" }]);
    expect(t.events.onFailed).toHaveBeenCalledWith("file-0001", "more data than announced", "in");
    // The stream is gone; its remaining chunks are ignored.
    t.chunk(1, [5], true);
    expect(t.events.onFailed).toHaveBeenCalledOnce();
  });

  it("reports progress for non-empty chunks only and completes after the sink closes", async () => {
    const t = transfers();
    t.files.handleFile(announce());
    t.chunk(1, [1, 2, 3]);
    t.chunk(1, [], true);
    await vi.waitFor(() => expect(t.events.onComplete).toHaveBeenCalledWith("file-0001", "in"));
    expect(t.events.onProgress.mock.calls).toEqual([["file-0001", 3, "in"]]);
  });

  it("aborts the sink and reports a failure when storing the file fails", async () => {
    const sink = { ...sinkSpy(), close: vi.fn(async () => { throw new Error("disk full"); }) };
    const t = transfers(() => sink);
    t.files.handleFile(announce());
    t.chunk(1, [1, 2, 3], true);
    await vi.waitFor(() => expect(t.events.onFailed).toHaveBeenCalledWith("file-0001", "could not store the file", "in"));
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(t.events.onComplete).not.toHaveBeenCalled();
  });

  it("gives up on a stalled transfer after the idle timeout, re-armed by each chunk", () => {
    vi.useFakeTimers();
    const t = transfers();
    t.files.handleFile(announce());
    vi.advanceTimersByTime(LIMITS.bodyIdleTimeoutMs - 1);
    t.chunk(1, [1]);
    vi.advanceTimersByTime(LIMITS.bodyIdleTimeoutMs - 1);
    expect(t.events.onFailed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.events.onFailed).toHaveBeenCalledWith("file-0001", "transfer stalled", "in");
    expect(t.controls()).toEqual([{ t: "rst", id: 1, d: "f", e: "transfer stalled" }]);
  });

  it("uses a default reason when the sender resets without one, and ignores resets for unknown streams", () => {
    const t = transfers();
    t.files.handleFile(announce());
    t.files.handleReset({ t: "rst", id: 7, d: "f", e: "" });
    expect(t.events.onFailed).not.toHaveBeenCalled();
    t.files.handleReset({ t: "rst", id: 1, d: "f", e: "" });
    expect(t.events.onFailed).toHaveBeenCalledWith("file-0001", "cancelled by the sender", "in");
    expect(t.sent).toEqual([]);
  });

  it("survives a closed channel while refusing or failing a file", () => {
    const t = transfers(() => null);
    t.channel.broken = true;
    expect(() => t.files.handleFile(announce())).not.toThrow();

    const u = transfers();
    u.files.handleFile(announce());
    u.channel.broken = true;
    expect(() => u.chunk(1, [1, 2, 3, 4])).not.toThrow();
    expect(u.events.onFailed).toHaveBeenCalledWith("file-0001", "more data than announced", "in");
  });
});

describe("files: sending", () => {
  it("refuses a file over the size limit before announcing it", async () => {
    const t = transfers();
    await expect(t.files.send({ ...info, size: LIMITS.maxFileBytes + 1 }, parts([1]))).rejects.toThrow("File is too large");
    expect(t.sent).toEqual([]);
  });

  it("announces with a sanitized name and type, and gives each file its own stream", async () => {
    const t = transfers();
    await t.files.send({ ...info, name: "..\\x/y:z", mime: "TEXT/PLAIN" }, parts([1, 2, 3]));
    await t.files.send({ ...info, id: "file-0002" }, parts([1, 2, 3]));
    const announced = t.controls().filter((f) => f?.t === "file");
    expect(announced).toEqual([
      { t: "file", id: 1, f: "file-0001", ts: 1, n: "xyz", s: 3, m: "text/plain" },
      { t: "file", id: 2, f: "file-0002", ts: 1, n: "a.txt", s: 3, m: "text/plain" },
    ]);
    expect(t.events.onProgress.mock.calls).toEqual([["file-0001", 3, "out"], ["file-0002", 3, "out"]]);
    expect(t.events.onComplete).toHaveBeenCalledTimes(2);
  });

  it("fails and resets the stream when the source does not match the announced size", async () => {
    const t = transfers();
    await expect(t.files.send(info, parts([1, 2]))).rejects.toThrow("File changed while it was being sent");
    expect(t.controls().at(-1)).toEqual({ t: "rst", id: 1, d: "f", e: "aborted" });
    expect(t.events.onFailed).toHaveBeenCalledWith("file-0001", "File changed while it was being sent", "out");
  });

  it("stops when the receiver resets the stream, without resetting it back", async () => {
    const t = transfers();
    let release!: () => void;
    const source = (async function* () {
      yield Uint8Array.of(1);
      await new Promise<void>((resolve) => (release = resolve));
      yield Uint8Array.of(2, 3);
    })();
    const sending = t.files.send(info, source);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    t.files.handleReset({ t: "rst", id: 1, d: "f", e: "no thanks" });
    release();
    await expect(sending).rejects.toThrow("The peer refused the file");
    expect(t.controls().filter((f) => f?.t === "rst")).toEqual([]);
    expect(t.sent.filter((s) => typeof s !== "string").map((s) => decodeChunk(s as Uint8Array)!.end)).toEqual([false]);
  });

  it("stops every outgoing file when the link closes", async () => {
    const t = transfers();
    let release!: () => void;
    const sending = t.files.send(info, (async function* () {
      await new Promise<void>((resolve) => (release = resolve));
      yield Uint8Array.of(1, 2, 3);
    })());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    t.files.closeAll();
    release();
    await expect(sending).rejects.toThrow("The peer refused the file");
  });

  it("reports a failure when the channel is already closed", async () => {
    const t = transfers();
    t.channel.broken = true;
    await expect(t.files.send(info, parts([1, 2, 3]))).rejects.toThrow("Data link is not open");
    expect(t.events.onFailed).toHaveBeenCalledWith("file-0001", "Data link is not open", "out");
  });

  it("reports a failing source with its own message", async () => {
    const t = transfers();
    const source = (async function* () {
      yield Uint8Array.of(1);
      throw "read error";
    })();
    await expect(t.files.send(info, source)).rejects.toBe("read error");
    expect(t.events.onFailed).toHaveBeenCalledWith("file-0001", "read error", "out");
  });
});
