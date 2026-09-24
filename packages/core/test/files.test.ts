import { describe, expect, it } from "vitest";
import {
  CHUNK_KIND,
  FileTransfers,
  LIMITS,
  concatBytes,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  safeBlobType,
  sanitizeFileName,
  sanitizeMime,
  type FileInfo,
  type FrameChannel,
} from "../src";
import { createChannelPair } from "./helpers";
// covers: files.legacy.send

function setup(accept: boolean | string = true) {
  const [senderSide, receiverSide] = createChannelPair();
  const received = new Map<string, { info: FileInfo; parts: Uint8Array[]; closed: boolean; aborted: boolean }>();
  const log: string[] = [];

  const receiver = new FileTransfers(receiverSide, {
    onIncoming(info) {
      if (typeof accept === "string") return accept;
      if (!accept) return null;
      const entry = { info, parts: [] as Uint8Array[], closed: false, aborted: false };
      received.set(info.id, entry);
      return {
        write: (chunk) => void entry.parts.push(chunk),
        close: () => void (entry.closed = true),
        abort: () => void (entry.aborted = true),
      };
    },
    onComplete: (id) => log.push(`in:done:${id}`),
    onFailed: (id, reason) => log.push(`in:failed:${id}:${reason}`),
  });
  const sender = new FileTransfers(senderSide, {
    onIncoming: () => null,
    onComplete: (id) => log.push(`out:done:${id}`),
    onFailed: (id, reason) => log.push(`out:failed:${id}:${reason}`),
  });

  const wire = (channel: FrameChannel, transfers: FileTransfers) => {
    channel.onMessage = (data) => {
      if (typeof data !== "string") return transfers.handleChunk(decodeChunk(data)!);
      const frame = decodeControl(data);
      if (frame?.t === "file") transfers.handleFile(frame);
      else if (frame?.t === "rst") transfers.handleReset(frame);
    };
  };
  wire(receiverSide, receiver);
  wire(senderSide, sender);
  return { sender, receiver, senderSide, received, log };
}

async function* chunksOf(bytes: Uint8Array, size = 50_000) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const info = (overrides: Partial<FileInfo> = {}): FileInfo => ({
  id: "file-0001",
  name: "boo.bin",
  size: 0,
  mime: "application/octet-stream",
  timestamp: 1,
  ...overrides,
});

describe("file transfer", () => {
  it("delivers a binary file intact", async () => {
    const { sender, received, log } = setup();
    const bytes = new Uint8Array(700_000).map((_, i) => (i * 7) % 256);
    await sender.send(info({ size: bytes.length, name: "photo.png", mime: "image/png" }), chunksOf(bytes));
    await settle();

    const file = received.get("file-0001")!;
    expect(file.info).toMatchObject({ name: "photo.png", size: bytes.length, mime: "image/png" });
    expect(concatBytes(...file.parts)).toEqual(bytes);
    expect(file.closed).toBe(true);
    expect(log).toEqual(["out:done:file-0001", "in:done:file-0001"]);
  });

  it("handles empty files", async () => {
    const { sender, received } = setup();
    await sender.send(info(), chunksOf(new Uint8Array(0)));
    await settle();
    expect(received.get("file-0001")?.closed).toBe(true);
  });

  it("tells the sender when the file is refused", async () => {
    const { sender, log } = setup(false);
    const bytes = new Uint8Array(400_000);
    await expect(sender.send(info({ size: bytes.length }), chunksOf(bytes))).rejects.toThrow("refused");
    expect(log).toEqual(["out:failed:file-0001:The peer refused the file"]);
  });

  it("passes the receiver's reason for refusing on to the sender", async () => {
    const { senderSide, received } = setup("no room for more files");
    const resets: unknown[] = [];
    const onMessage = senderSide.onMessage;
    senderSide.onMessage = (data) => {
      if (typeof data === "string") resets.push(decodeControl(data));
      onMessage?.(data);
    };
    senderSide.send(encodeControl({ t: "file", id: 7, f: "full-disk", ts: 1, n: "x", s: 10, m: "text/plain" }));
    await settle();
    expect(received.size).toBe(0);
    expect(resets).toEqual([{ t: "rst", id: 7, d: "f", e: "no room for more files" }]);
  });

  it("discards a file that does not match the announced size", async () => {
    const { senderSide, received, log } = setup();
    const announce = (id: number, f: string, s: number) =>
      senderSide.send(encodeControl({ t: "file", id, f, ts: 1, n: "x", s, m: "text/plain" }));

    announce(1, "short-file", 10);
    senderSide.send(encodeChunk({ kind: CHUNK_KIND.fileBody, id: 1, end: true, payload: new Uint8Array(4) }));
    announce(2, "long-file0", 10);
    senderSide.send(encodeChunk({ kind: CHUNK_KIND.fileBody, id: 2, end: false, payload: new Uint8Array(11) }));
    await settle();

    expect(received.get("short-file")).toMatchObject({ closed: false, aborted: true });
    expect(received.get("long-file0")).toMatchObject({ closed: false, aborted: true });
    expect(log).toEqual(["in:failed:short-file:incomplete file", "in:failed:long-file0:more data than announced"]);
  });

  it("refuses oversized files, bad ids and too many transfers at once", async () => {
    const { senderSide, received } = setup();
    const announce = (id: number, f: string, s = 1) =>
      senderSide.send(encodeControl({ t: "file", id, f, ts: 1, n: "x", s, m: "text/plain" }));

    announce(1, "too-large-file", LIMITS.maxFileBytes + 1);
    announce(2, "../../etc");
    for (let i = 0; i < LIMITS.maxIncomingFilesPerPeer + 2; i++) announce(10 + i, `parallel-${i}`);
    await settle();

    expect([...received.keys()]).toEqual(["parallel-0", "parallel-1", "parallel-2"]);
  });

  it("aborts what is in flight when the link closes", async () => {
    const { senderSide, receiver, received, log } = setup();
    senderSide.send(encodeControl({ t: "file", id: 1, f: "half-done", ts: 1, n: "x", s: 100, m: "text/plain" }));
    await settle();
    receiver.closeAll();
    expect(received.get("half-done")?.aborted).toBe(true);
    expect(log).toEqual(["in:failed:half-done:connection lost"]);
  });

  it("never treats a name as a path or trusts a type", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeFileName("C:\\Users\\me\\a.txt")).toBe("CUsersmea.txt");
    expect(sanitizeFileName(".bashrc")).toBe("bashrc");
    expect(sanitizeFileName("a\nb.txt")).toBe("ab.txt");
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("x".repeat(500))).toHaveLength(200);
    expect(sanitizeFileName("😀".repeat(300))).toBe("😀".repeat(200));
  });

  it("does not let whitespace hide a leading dot", () => {
    expect(sanitizeFileName(" .bashrc")).toBe("bashrc");
    expect(sanitizeFileName(" . .profile ")).toBe("profile");
    expect(sanitizeFileName("\t..ssh")).toBe("ssh");
    expect(sanitizeFileName("  report.pdf  ")).toBe("report.pdf");
  });

  it("removes invisible and direction-changing characters", () => {
    // Would read as "invoiceexe.pdf".
    expect(sanitizeFileName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFileName("a\u2066b\u2067c\u2068d\u2069e\u202Af\u202Bg\u202Ch\u202Di\u200Ej\u200Fk.txt")).toBe("abcdefghijk.txt");
    expect(sanitizeFileName("ze\u200Bro\u200C\u200Dwidth\uFEFF\u2060.txt")).toBe("zerowidth.txt");
    expect(sanitizeFileName("line\u2028break\u2029.txt")).toBe("linebreak.txt");
    expect(sanitizeFileName("c1\u0085\u009B.txt")).toBe("c1.txt");
    expect(sanitizeFileName("\u200B.hidden")).toBe("hidden");
    expect(sanitizeFileName("\u202E")).toBe("file");
    expect(sanitizeFileName("naïve café 日本.txt")).toBe("naïve café 日本.txt");
  });

  it("serves received bytes as inert unless they are a previewable image", () => {
    expect(safeBlobType("image/png")).toBe("image/png");
    expect(safeBlobType("image/JPEG")).toBe("image/jpeg");
    expect(safeBlobType("image/webp")).toBe("image/webp");
    expect(safeBlobType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeBlobType("text/html")).toBe("application/octet-stream");
    expect(safeBlobType("application/xhtml+xml")).toBe("application/octet-stream");
    expect(safeBlobType("application/pdf")).toBe("application/octet-stream");
    expect(safeBlobType("")).toBe("application/octet-stream");
    expect(sanitizeMime("image/PNG")).toBe("image/png");
    expect(sanitizeMime("text/html; charset=utf-8")).toBe("application/octet-stream");
    expect(sanitizeMime("nonsense")).toBe("application/octet-stream");
  });
});
