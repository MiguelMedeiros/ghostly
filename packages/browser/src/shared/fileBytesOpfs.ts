import { FILE_BYTES_STEP, checkFileId, fileSpace, type FileBytes } from "./fileBytes";
import { storageRoom } from "./fileBytesIdb";
import type { WorkerReply, WorkerRequest } from "./fileBytesWorker";

type Request = WorkerRequest extends infer R ? R extends unknown ? Omit<R, "n" | "space"> : never : never;

/**
 * Files in the origin-private file system, written by `fileBytesWorker.ts`. Every page and the peer of one
 * profile see the same folder; a file is written by one of them at a time (the page copies a file it sends,
 * the peer writes one it receives), and read as a Blob only once it is closed.
 */
export class OpfsFileBytes implements FileBytes {
  readonly kind = "opfs" as const;
  private next = 1;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; progress?(n: number): void }>();

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data, pending = this.waiting.get(reply.n);
      if (!pending) return;
      if ("progress" in reply) return pending.progress?.(reply.progress);
      this.waiting.delete(reply.n);
      if (reply.ok) pending.resolve(reply.value); else pending.reject(new Error(reply.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      for (const pending of this.waiting.values()) pending.reject(new Error(`File storage stopped: ${event.message || "unknown error"}`));
      this.waiting.clear();
    };
  }

  /** The worker, if this browser can run it and gives it sync access handles; null otherwise. */
  static async open(): Promise<OpfsFileBytes | null> {
    if (typeof Worker === "undefined" || typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    const store = new OpfsFileBytes(new Worker(new URL("./fileBytesWorker.ts", import.meta.url), { type: "module" }));
    try {
      if (await store.call<boolean>({ op: "probe" })) return store;
    } catch { /* no OPFS here (a private window, an old engine) */ }
    store.worker.terminate();
    return null;
  }

  private call<T>(request: Request, transfer: Transferable[] = [], progress?: (n: number) => void): Promise<T> {
    const n = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(n, { resolve: resolve as (value: unknown) => void, reject, progress });
      this.worker.postMessage({ ...request, n, space: fileSpace() } as WorkerRequest, transfer);
    });
  }

  stage(id: string, source: Blob, onProgress?: (copied: number) => void): Promise<string> {
    return this.call({ op: "stage", id: checkFileId(id), source }, [], onProgress);
  }
  append(id: string, offset: number, bytes: Uint8Array): Promise<void> {
    // A copy goes to the worker: the caller's buffer may be a view into something it still uses.
    const copy = bytes.slice();
    return this.call({ op: "append", id: checkFileId(id), offset, bytes: copy }, [copy.buffer]);
  }
  flush(id: string): Promise<void> { return this.call({ op: "flush", id: checkFileId(id) }); }
  close(id: string): Promise<void> { return this.call({ op: "close", id: checkFileId(id) }); }
  size(id: string): Promise<number | null> { return this.call({ op: "size", id: checkFileId(id) }); }
  truncate(id: string, size: number): Promise<void> { return this.call({ op: "truncate", id: checkFileId(id), size }); }
  read(id: string, offset: number, length: number): Promise<Uint8Array> {
    return this.call({ op: "read", id: checkFileId(id), offset, length: Math.min(length, 16 * FILE_BYTES_STEP) });
  }
  digest(id: string): Promise<string> { return this.call({ op: "digest", id: checkFileId(id) }); }
  remove(id: string): Promise<void> { return this.call({ op: "remove", id: checkFileId(id) }); }
  removeWhere(prefix: string): Promise<void> { return this.call({ op: "removeWhere", prefix }); }

  async blob(id: string, type: string): Promise<Blob | null> {
    // Closed first: a file with a sync access handle open cannot be read as a Blob.
    await this.close(id);
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files");
      const file = await (await (await root.getDirectoryHandle(fileSpace())).getFileHandle(checkFileId(id))).getFile();
      // A slice with a type: still the file on disk, never read into memory.
      return file.slice(0, file.size, type);
    } catch { return null; }
  }

  room(): Promise<number | null> { return storageRoom(); }

  async dropSpace(space: string): Promise<void> {
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files");
      await root.removeEntry(space, { recursive: true });
    } catch (error) { if ((error as { name?: string })?.name !== "NotFoundError") throw error; }
  }
}
