import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerReply, WorkerRequest } from "../src/shared/fileBytesWorker";
// covers: files.storage

/**
 * One page's file storage worker while a large file is copied in or checked: another file's request is answered
 * within a step of it, not after the whole file. The fake folder answers in a later task, as the browser's file system
 * does (each call goes to another process), and a file's bytes are ready at once, as a picked file's often are: a
 * copy that never lets a task run holds every other file's call to the folder until it ends.
 */
const ipc = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** `open`: a sync access handle on it is not closed. Such a file is locked, as in the browser: it cannot be removed. */
class FakeFile { bytes = new Uint8Array(0); open = false }
const locked = () => new DOMException("The file is locked", "NoModificationAllowedError");
class FakeDir {
  readonly entries = new Map<string, FakeDir | FakeFile>();
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    await ipc();
    let dir = this.entries.get(name);
    if (!dir && options?.create) this.entries.set(name, dir = new FakeDir());
    if (!(dir instanceof FakeDir)) throw new DOMException("Not found", "NotFoundError");
    return dir;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    await ipc();
    let file = this.entries.get(name);
    if (!file && options?.create) this.entries.set(name, file = new FakeFile());
    if (!(file instanceof FakeFile)) throw new DOMException("Not found", "NotFoundError");
    const held = file;
    return {
      async createSyncAccessHandle() {
        await ipc();
        held.open = true;
        return {
          getSize: () => held.bytes.length,
          read: (out: Uint8Array, options?: { at?: number }) => {
            const part = held.bytes.subarray(options?.at ?? 0, (options?.at ?? 0) + out.length);
            out.set(part);
            return part.length;
          },
          write: (bytes: Uint8Array, options?: { at?: number }) => {
            const at = options?.at ?? 0;
            if (at + bytes.length > held.bytes.length) { const grown = new Uint8Array(at + bytes.length); grown.set(held.bytes); held.bytes = grown; }
            held.bytes.set(bytes, at);
            return bytes.length;
          },
          truncate: (size: number) => { held.bytes = held.bytes.slice(0, size); },
          flush: () => {},
          close: () => { held.open = false; },
        };
      },
      async getFile() { await ipc(); return readyBlob(held.bytes); },
    };
  }
  /** A folder's removal takes what it can and fails on a locked file, leaving it (and the folder) in place. */
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    await ipc();
    const entry = this.entries.get(name);
    if (entry instanceof FakeFile && entry.open) throw locked();
    if (entry instanceof FakeDir) {
      if (entry.entries.size && !options?.recursive) throw new DOMException("Not empty", "InvalidModificationError");
      for (const [inner, file] of [...entry.entries]) if (!(file instanceof FakeFile && file.open)) entry.entries.delete(inner);
      if (entry.entries.size) throw locked();
    }
    this.entries.delete(name);
  }
}

/** A Blob with its bytes ready: each read is answered without waiting for a task. */
function readyBlob(bytes: Uint8Array): Blob {
  const slice = (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer });
  return { size: bytes.length, slice } as unknown as Blob;
}

const MiB = 1024 * 1024;
const big = () => new Uint8Array(24 * MiB).map((_, i) => i & 255);

interface Scope { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage(reply: WorkerReply): void }

async function startWorker(): Promise<{ ask: (request: WorkerRequest) => Promise<WorkerReply>; answered: number[] }> {
  const waiting = new Map<number, (reply: WorkerReply) => void>();
  const answered: number[] = [];
  const scope: Scope = { onmessage: null, postMessage: (reply) => { if (!("progress" in reply)) { answered.push(reply.n); waiting.get(reply.n)?.(reply); } } };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  vi.resetModules();
  await import("../src/shared/fileBytesWorker");
  return {
    answered,
    ask: (request) => new Promise((resolve) => { waiting.set(request.n, resolve); scope.onmessage!({ data: request }); }),
  };
}

let root = new FakeDir();
afterEach(() => { root = new FakeDir(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("a page's file storage while a large file is copied in or checked", () => {
  it("answers another file's write before a large file being sent is copied in", async () => {
    const { ask, answered } = await startWorker();
    const copy = ask({ n: 1, space: "ghostly", op: "stage", id: "big", source: readyBlob(big()) });
    const voiceNote = ask({ n: 2, space: "ghostly", op: "append", id: "small", offset: 0, bytes: new Uint8Array(1000) });
    expect(await voiceNote).toEqual({ n: 2, ok: true });
    expect(answered).toEqual([2]);
    const copied = await copy;
    expect(copied).toMatchObject({ n: 1, ok: true });
    // The copy is whole and its hash is the file's.
    expect(await ask({ n: 3, space: "ghostly", op: "digest", id: "big" })).toEqual({ ...copied, n: 3 });
    expect(await ask({ n: 4, space: "ghostly", op: "size", id: "big" })).toEqual({ n: 4, ok: true, value: 24 * MiB });
  });

  it("answers another file's read before a large file that arrived is checked", async () => {
    const { ask, answered } = await startWorker();
    await ask({ n: 1, space: "ghostly", op: "append", id: "big", offset: 0, bytes: big() });
    await ask({ n: 2, space: "ghostly", op: "append", id: "small", offset: 0, bytes: new Uint8Array(1000) });
    await ask({ n: 3, space: "ghostly", op: "close", id: "small" });
    answered.length = 0;
    // Still held open (the last step written), and once closed: both ways a check reads the whole file.
    const held = ask({ n: 4, space: "ghostly", op: "digest", id: "big" });
    const photo = ask({ n: 5, space: "ghostly", op: "read", id: "small", offset: 0, length: 1000 });
    expect(await photo).toMatchObject({ n: 5, ok: true });
    expect(answered).toEqual([5]);
    const first = await held;
    await ask({ n: 6, space: "ghostly", op: "close", id: "big" });
    answered.length = 0;
    const closed = ask({ n: 7, space: "ghostly", op: "digest", id: "big" });
    const again = ask({ n: 8, space: "ghostly", op: "size", id: "small" });
    expect(await again).toEqual({ n: 8, ok: true, value: 1000 });
    expect(answered).toEqual([8]);
    // The check itself is the same.
    expect(await closed).toEqual({ ...first, n: 7 });
  });
});

describe("a profile's folder dropped while a file in it is still being written", () => {
  /** The page's side (`OpfsFileBytes`) on this worker, the worker run in this test's scope as the browser runs it. */
  async function openStore() {
    const scope: Scope = { onmessage: null, postMessage: (reply) => { setTimeout(() => page.onmessage?.({ data: reply } as MessageEvent<WorkerReply>), 0); } };
    const page = {
      onmessage: null as ((event: MessageEvent<WorkerReply>) => void) | null,
      onerror: null,
      postMessage: (request: WorkerRequest) => { setTimeout(() => scope.onmessage!({ data: request }), 0); },
      terminate: () => {},
    };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    vi.stubGlobal("Worker", function Worker() { return page; });
    vi.resetModules();
    await import("../src/shared/fileBytesWorker");
    const { OpfsFileBytes } = await import("../src/shared/fileBytesOpfs");
    return (await OpfsFileBytes.open())!;
  }
  const folders = async () => [...(await root.getDirectoryHandle("ghostly-files")).entries.keys()];

  it("a move stopped mid-file: its folder goes whole, the file it was writing included", async () => {
    const store = await openStore();
    const staged = store.forSpace("ghostly_stage");
    // One file whole and closed, the next one half written: the move stopped there, and nothing closed it.
    await staged.append("done", 0, new Uint8Array(1000));
    await staged.close("done");
    await staged.append("half", 0, new Uint8Array(500));
    await store.dropSpace("ghostly_stage");
    expect(await folders()).not.toContain("ghostly_stage");
    // Written again later (another move): a new file, not one the dropped folder left open.
    await staged.append("half", 0, new Uint8Array(10));
    expect(await staged.size("half")).toBe(10);
  });
});
