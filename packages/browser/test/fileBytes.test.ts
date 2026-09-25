import "fake-indexeddb/auto";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_BYTES_STEP, blobDigest, checkFileId, digestText, dropFileSpace, fileBytes, fileBytesOf, registerFileBytes, removeFileBytes, resetFileBytes, type FileBytes } from "../src/shared/fileBytes";
import { IdbFileBytes } from "../src/shared/fileBytesIdb";
import { NATIVE_BLOB_MAX, NativeFileBytes, type NativeInvoke } from "../src/shared/fileBytesNative";
import { fileStore } from "../src/shared/idb";
import { FileAppender, readStored, removeStored, storedBlob, storedSize, streamStored } from "../src/shared/storedFiles";
// covers: files.storage

/** Deterministic bytes for any offset: a file of any size can be written and checked without holding it. */
function pattern(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = ((offset + i) * 31 + ((offset + i) >> 11)) & 0xff;
  return out;
}
const STEP = FILE_BYTES_STEP;

afterEach(() => resetFileBytes());

describe("files in IndexedDB pieces (no file system)", () => {
  it("appends at any size, reads any range across pieces, and hashes what it stored", async () => {
    const bytes = new IdbFileBytes();
    const id = "chat-in-ranges";
    const size = 3 * STEP + 12_345;
    const hash = sha256.create();
    // Wire-sized writes and a large one, in order.
    for (let offset = 0; offset < size;) {
      const length = Math.min(offset < STEP ? 16 * 1024 : 700_000, size - offset);
      const part = pattern(offset, length);
      hash.update(part);
      await bytes.append(id, offset, part);
      offset += length;
    }
    await bytes.close(id);
    expect(await bytes.size(id)).toBe(size);
    expect(await bytes.digest(id)).toBe(digestText(hash.digest()));
    for (const [offset, length] of [[0, 10], [STEP - 5, 10], [2 * STEP - 1, STEP + 2], [size - 3, 100]]) {
      expect(await bytes.read(id, offset, length)).toEqual(pattern(offset, Math.min(length, size - offset)));
    }
    const blob = (await bytes.blob(id, "image/png"))!;
    expect(blob.size).toBe(size);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.slice(STEP, STEP + 4).arrayBuffer())).toEqual(pattern(STEP, 4));
  });

  it("refuses a write out of order, and goes back to a point with truncate (a resumed transfer)", async () => {
    const bytes = new IdbFileBytes();
    const id = "chat-in-resume";
    await bytes.append(id, 0, pattern(0, STEP + 100));
    await expect(bytes.append(id, 5, pattern(5, 1))).rejects.toThrow("out of order");
    await bytes.flush(id);
    await bytes.truncate(id, STEP - 7);
    expect(await bytes.size(id)).toBe(STEP - 7);
    // Another instance (a restart) continues where the file stands.
    const again = new IdbFileBytes();
    await again.append(id, STEP - 7, pattern(STEP - 7, 3 * STEP));
    await again.close(id);
    expect(await again.size(id)).toBe(4 * STEP - 7);
    expect(await again.digest(id)).toBe(await blobDigest(new Blob([pattern(0, 4 * STEP - 7) as BlobPart])));
    await again.truncate(id, 2 * STEP);
    expect(await again.size(id)).toBe(2 * STEP);
    await again.truncate(id, 0);
    expect(await again.size(id)).toBeNull();
  });

  it("what was only gathered in memory is lost by a crash; what was flushed is not", async () => {
    const bytes = new IdbFileBytes();
    const id = "chat-in-crash";
    await bytes.append(id, 0, pattern(0, 1000));
    await bytes.flush(id);
    await bytes.append(id, 1000, pattern(1000, 500));
    // A new instance reads storage only: the process that held the rest in memory is gone.
    expect(await new IdbFileBytes().size(id)).toBe(1000);
  });

  it("stages a picked file with its digest and progress, and removes by id, by chat and by space", async () => {
    const bytes = new IdbFileBytes();
    const source = new Blob([pattern(0, 2 * STEP + 1) as BlobPart]);
    const seen: number[] = [];
    const digest = await bytes.stage("chatA-out-1", source, (n) => seen.push(n));
    expect(digest).toBe(await blobDigest(source));
    expect(seen.at(-1)).toBe(source.size);
    await bytes.append("chatA-in-2", 0, pattern(0, 10));
    await bytes.append("chatB-in-3", 0, pattern(0, 10));
    await bytes.flush("chatA-in-2"); await bytes.flush("chatB-in-3");
    await bytes.removeWhere("chatA-");
    expect(await bytes.size("chatA-out-1")).toBeNull();
    expect(await bytes.size("chatA-in-2")).toBeNull();
    expect(await bytes.size("chatB-in-3")).toBe(10);
    await bytes.remove("chatB-in-3");
    expect(await bytes.size("chatB-in-3")).toBeNull();
    expect(await bytes.blob("chatB-in-3", "")).toBeNull();
  });

  it("ids are plain names", () => {
    for (const id of ["../x", "a/b", "", "a.b", "x".repeat(201)]) expect(() => checkFileId(id)).toThrow("Invalid file id");
    expect(checkFileId("abc-in-XYZ_1")).toBe("abc-in-XYZ_1");
  });
});

describe("choosing where files go", () => {
  it("falls back to IndexedDB where there is no worker, and a platform can put its own first", async () => {
    resetFileBytes();
    expect((await fileBytes()).kind).toBe("idb");
    expect(await fileBytesOf("opfs")).toBeNull();
    const invoke = vi.fn(async () => null);
    registerFileBytes("native", async () => new NativeFileBytes(invoke as unknown as NativeInvoke), true);
    expect((await fileBytes()).kind).toBe("native");
    await removeFileBytes("chat-");
    expect(invoke).toHaveBeenCalledWith("file_bytes_remove_where", { space: "ghostly", prefix: "chat-" });
    await dropFileSpace("ghostly_work");
    expect(invoke).toHaveBeenCalledWith("file_bytes_remove_where", { space: "ghostly_work", prefix: "" });
    await expect(dropFileSpace("../x")).rejects.toThrow("Invalid profile space");
    registerFileBytes("native", async () => null);
  });
});

describe("files on Desktop (Rust commands)", () => {
  /** The Rust side, as a map of files: what each command does to the file named by space and id. */
  function fakeRust() {
    const files = new Map<string, Uint8Array>();
    const key = (a: { space: string; id: string }) => `${a.space}/${a.id}`;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => {
      if (command === "file_bytes_append") {
        const k = `${options!.headers["x-space"]}/${options!.headers["x-id"]}`, have = files.get(k) ?? new Uint8Array();
        if (Number(options!.headers["x-offset"]) !== have.length) throw "File write out of order";
        const next = new Uint8Array(have.length + (args as Uint8Array).length);
        next.set(have); next.set(args as Uint8Array, have.length);
        files.set(k, next);
        return null;
      }
      const a = args as { space: string; id: string; offset: number; length: number; size: number; name: string; prefix: string };
      switch (command) {
        case "file_bytes_size": return files.get(key(a))?.length ?? null;
        case "file_bytes_read": { const f = files.get(key(a))!; return f.slice(a.offset, a.offset + a.length).buffer; }
        case "file_bytes_digest": return digestText(sha256(files.get(key(a))!));
        case "file_bytes_truncate": files.set(key(a), files.get(key(a))!.slice(0, a.size)); return null;
        case "file_bytes_remove": files.delete(key(a)); return null;
        case "file_bytes_room": return 123;
        case "file_bytes_save": return a.name === "keep.bin";
        default: return null;
      }
    });
    return { files, invoke, bytes: new NativeFileBytes(invoke as unknown as NativeInvoke) };
  }

  it("stages a step at a time as raw bodies, hashes in Rust, and hands small files out as Blobs", async () => {
    const { invoke, bytes } = fakeRust();
    const source = new Blob([pattern(0, 2 * STEP + 5) as BlobPart]);
    const digest = await bytes.stage("c-out-1", source);
    expect(digest).toBe(await blobDigest(source));
    const appends = invoke.mock.calls.filter(([command]) => command === "file_bytes_append");
    expect(appends).toHaveLength(3);
    expect(appends.every(([, body]) => body instanceof Uint8Array && body.length <= STEP)).toBe(true);
    expect(await bytes.read("c-out-1", STEP - 1, 2)).toEqual(pattern(STEP - 1, 2));
    expect((await bytes.blob("c-out-1", "image/png"))!.size).toBe(source.size);
    expect(await bytes.room()).toBe(123);
    expect(await bytes.save("c-out-1", "keep.bin")).toBe(true);
    expect(await bytes.save("c-out-1", "other")).toBe(false);
  });

  it("a received file too large to show is only saved, never read into memory", async () => {
    const { invoke, bytes } = fakeRust();
    invoke.mockImplementationOnce(async () => NATIVE_BLOB_MAX + 1);
    expect(await bytes.blob("c-in-big", "")).toBeNull();
    expect(invoke.mock.calls.filter(([command]) => command === "file_bytes_read")).toHaveLength(0);
  });

  it("a failed copy leaves nothing behind", async () => {
    const { files, bytes } = fakeRust();
    const broken = { size: 3 * STEP, slice: (from: number) => from >= STEP ? { arrayBuffer: () => Promise.reject(new Error("unreadable")) } : new Blob([pattern(0, STEP) as BlobPart]) } as unknown as Blob;
    await expect(bytes.stage("c-out-2", broken)).rejects.toThrow("unreadable");
    expect(files.size).toBe(0);
  });
});

describe("stored files, wherever their bytes are", () => {
  it("a small file is its Blob, a large one its storage; both read, stream and go away the same way", async () => {
    resetFileBytes(["idb"]);
    const storage = await fileBytes();
    await storage.append("l-in-big", 0, pattern(0, 2 * STEP + 3));
    await storage.close("l-in-big");
    const large = { id: "l-in-big", linkId: "l", bytes: "idb" as const, createdAt: 1, metadata: { name: "a", size: 2 * STEP + 3, mime: "", timestamp: 1 } };
    const small = { id: "l-in-small", linkId: "l", blob: new Blob([pattern(0, 10) as BlobPart]), createdAt: 1 };
    await fileStore.put(large); await fileStore.put(small);
    expect(storedSize(large)).toBe(2 * STEP + 3);
    expect(storedSize(small)).toBe(10);
    expect(await readStored(large, STEP, 4)).toEqual(pattern(STEP, 4));
    expect(await readStored(small, 2, 4)).toEqual(pattern(2, 4));
    const parts: Uint8Array[] = [];
    for await (const part of streamStored(large)) parts.push(part);
    expect(parts.map((p) => p.length)).toEqual([STEP, STEP, 3]);
    expect((await storedBlob(large, "image/gif"))!.type).toBe("image/gif");
    await removeStored("l-in-big");
    expect(await fileStore.get("l-in-big")).toBeUndefined();
    expect(await storage.size("l-in-big")).toBeNull();
  });

  it("gathers wire-sized writes into larger ones and counts what it was handed", async () => {
    const appended: number[] = [];
    const storage = { append: vi.fn(async (_id: string, _offset: number, bytes: Uint8Array) => { appended.push(bytes.length); }), flush: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as FileBytes;
    const appender = new FileAppender(storage, "x-in-1", 100);
    for (let i = 0; i < 20; i++) await appender.append(pattern(i * 16384, 16384));
    expect(appender.written).toBe(100 + 20 * 16384);
    expect(appended).toEqual([16 * 16384]);
    await appender.append(pattern(0, 300 * 1024));
    await appender.flush();
    expect(appended).toEqual([16 * 16384, 4 * 16384, 300 * 1024]);
    expect(storage.flush).toHaveBeenCalledWith("x-in-1");
  });
});
