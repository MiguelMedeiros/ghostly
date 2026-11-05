import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerReply, WorkerRequest } from "../src/shared/fileBytesWorker";
// covers: files.storage

/**
 * The origin-private file system as Chromium keeps it for one profile: one folder every page and the peer see, and a
 * sync access handle that is exclusive. A second one on a file someone holds is refused, and so is removing it.
 */
class FakeFile { locked = false; bytes = new Uint8Array(0); removed = false }
class FakeDir {
  readonly entries = new Map<string, FakeDir | FakeFile>();
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    await null;
    let dir = this.entries.get(name);
    if (!dir && options?.create) this.entries.set(name, dir = new FakeDir());
    if (!(dir instanceof FakeDir)) throw new DOMException("A requested file or directory could not be found", "NotFoundError");
    return dir;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    await null;
    let file = this.entries.get(name);
    if (!file && options?.create) this.entries.set(name, file = new FakeFile());
    if (!(file instanceof FakeFile)) throw new DOMException("A requested file or directory could not be found", "NotFoundError");
    const held = file;
    return {
      async createSyncAccessHandle() {
        await null;
        if (held.removed) throw new DOMException("A requested file or directory could not be found", "NotFoundError");
        if (held.locked) throw new DOMException("Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.", "NoModificationAllowedError");
        held.locked = true;
        return {
          getSize: () => held.bytes.length,
          read: () => 0,
          write: (bytes: Uint8Array) => bytes.length,
          truncate: () => {},
          flush: () => {},
          close: () => { held.locked = false; },
        };
      },
      async getFile() { return new Blob([held.bytes.slice()]); },
    };
  }
  async removeEntry(name: string) {
    await null;
    const entry = this.entries.get(name);
    if (!entry) throw new DOMException("A requested file or directory could not be found", "NotFoundError");
    if (entry instanceof FakeFile && entry.locked) throw new DOMException("An attempt was made to modify an object where modifications are not allowed.", "NoModificationAllowedError");
    if (entry instanceof FakeFile) entry.removed = true;
    this.entries.delete(name);
  }
}

interface Scope { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage(reply: WorkerReply): void }

/** One more copy of fileBytesWorker.ts, as a page's or the peer's own worker, on the shared folder. */
async function startWorker(): Promise<(request: WorkerRequest) => Promise<WorkerReply>> {
  const waiting = new Map<number, (reply: WorkerReply) => void>();
  const scope: Scope = { onmessage: null, postMessage: (reply) => { if (!("progress" in reply)) waiting.get(reply.n)?.(reply); } };
  vi.stubGlobal("self", scope);
  vi.resetModules();
  await import("../src/shared/fileBytesWorker");
  return (request) => new Promise((resolve) => {
    waiting.set(request.n, resolve);
    scope.onmessage!({ data: request });
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("the file system check of each page", () => {
  it("several app tabs (and the peer) opening their file storage at once all find it", async () => {
    const root = new FakeDir();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    const workers = [await startWorker(), await startWorker(), await startWorker()];
    // Every tab's first large received file opens its storage as the transfer finishes: the same moment in each.
    // Each page counts its requests from 1, so they carry the same numbers too.
    const replies = await Promise.all(workers.map((ask) => ask({ n: 1, space: "ghostly", op: "probe" })));
    // A page whose check was refused took this browser for one without the file system, for as long as it stayed open:
    // every received file kept there read as "No longer available" in it (agents#2504).
    expect(replies).toEqual([{ n: 1, ok: true, value: true }, { n: 1, ok: true, value: true }, { n: 1, ok: true, value: true }]);
    // Nothing of the checks is left in the folder.
    const space = (root.entries.get("ghostly-files") as FakeDir).entries.get("ghostly") as FakeDir;
    expect([...space.entries.keys()]).toEqual([]);
  });
});
