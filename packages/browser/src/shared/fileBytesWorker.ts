/**
 * The worker that writes files in the origin-private file system (see `fileBytesOpfs.ts`). Sync access
 * handles exist only in dedicated workers, and they write in place at an offset, which is what a transfer
 * that resumes needs. Files are `ghostly-files/<space>/<id>`. One handle per file stays open while it is
 * written, and is closed before anyone reads the file as a Blob.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { FILE_BYTES_STEP, digestText } from "./fileBytesCommon";

interface SyncHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
type Handle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

export type WorkerRequest = { n: number; space: string } & (
  | { op: "probe" }
  | { op: "stage"; id: string; source: Blob }
  | { op: "append"; id: string; offset: number; bytes: Uint8Array }
  | { op: "flush" | "close" | "size" | "digest" | "remove"; id: string }
  | { op: "truncate"; id: string; size: number }
  | { op: "read"; id: string; offset: number; length: number }
  | { op: "removeWhere"; prefix: string });

export type WorkerReply = { n: number } & ({ ok: true; value?: unknown } | { ok: false; error: string } | { progress: number });

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;
const open = new Map<string, SyncHandle>();
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const SPACE = /^[A-Za-z0-9_.-]{1,100}$/;

async function folder(space: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!SPACE.test(space)) throw new Error("Invalid profile space");
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files", { create });
    return await root.getDirectoryHandle(space, { create });
  } catch (error) {
    if (!create && (error as { name?: string })?.name === "NotFoundError") return null;
    throw error;
  }
}

async function entry(space: string, id: string, create: boolean): Promise<Handle | null> {
  if (!ID.test(id)) throw new Error("Invalid file id");
  const dir = await folder(space, create);
  if (!dir) return null;
  try { return (await dir.getFileHandle(id, { create })) as Handle; } catch (error) {
    if (!create && (error as { name?: string })?.name === "NotFoundError") return null;
    throw error;
  }
}

async function handle(space: string, id: string, create = true): Promise<SyncHandle | null> {
  const key = `${space}/${id}`;
  const held = open.get(key);
  if (held) return held;
  const file = await entry(space, id, create);
  if (!file) return null;
  const opened = await file.createSyncAccessHandle();
  open.set(key, opened);
  return opened;
}

function release(space: string, id: string): void {
  const key = `${space}/${id}`;
  const held = open.get(key);
  if (!held) return;
  open.delete(key);
  try { held.flush(); } finally { held.close(); }
}

function readAt(sync: SyncHandle, offset: number, length: number): Uint8Array {
  const size = sync.getSize();
  const out = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
  let pos = 0;
  while (pos < out.length) {
    const got = sync.read(out.subarray(pos), { at: offset + pos });
    if (got <= 0) break;
    pos += got;
  }
  return pos === out.length ? out : out.slice(0, pos);
}

function writeAll(sync: SyncHandle, bytes: Uint8Array, at: number): void {
  let pos = 0;
  while (pos < bytes.length) {
    const wrote = sync.write(bytes.subarray(pos), { at: at + pos });
    if (wrote <= 0) throw new Error("Could not write the file");
    pos += wrote;
  }
}

async function runRequest(request: WorkerRequest): Promise<{ value?: unknown; transfer?: Transferable[] }> {
  const { space } = request;
  switch (request.op) {
    case "probe": {
      // Sync access handles are the reason for this worker: a browser without them keeps files in IndexedDB.
      const sync = await handle(space, "ghostly-probe", true);
      release(space, "ghostly-probe");
      await (await folder(space, false))?.removeEntry("ghostly-probe").catch(() => {});
      return { value: !!sync };
    }
    case "stage": {
      release(space, request.id);
      const sync = (await handle(space, request.id))!;
      try {
        sync.truncate(0);
        const hash = sha256.create();
        const reader = request.source.stream().getReader();
        let offset = 0, told = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          writeAll(sync, value, offset);
          offset += value.length;
          if (offset - told >= FILE_BYTES_STEP) { told = offset; scope.postMessage({ n: request.n, progress: offset }); }
        }
        if (offset !== request.source.size) throw new Error("The file changed while it was being copied");
        release(space, request.id);
        return { value: digestText(hash.digest()) };
      } catch (error) {
        release(space, request.id);
        await (await folder(space, false))?.removeEntry(request.id).catch(() => {});
        throw error;
      }
    }
    case "append": {
      const sync = (await handle(space, request.id))!;
      if (sync.getSize() !== request.offset) throw new Error("File write out of order");
      writeAll(sync, request.bytes, request.offset);
      return {};
    }
    case "flush": open.get(`${space}/${request.id}`)?.flush(); return {};
    case "close": release(space, request.id); return {};
    case "size": {
      const held = open.get(`${space}/${request.id}`);
      if (held) return { value: held.getSize() };
      const file = await entry(space, request.id, false);
      return { value: file ? (await file.getFile()).size : null };
    }
    case "truncate": {
      const sync = await handle(space, request.id, false);
      if (!sync) { if (request.size === 0) return {}; throw new Error("No such file"); }
      if (request.size < sync.getSize()) sync.truncate(request.size);
      sync.flush();
      return {};
    }
    case "read": {
      const held = open.get(`${space}/${request.id}`);
      let bytes: Uint8Array;
      if (held) bytes = readAt(held, request.offset, request.length);
      else {
        const file = await entry(space, request.id, false);
        if (!file) throw new Error("No such file");
        bytes = new Uint8Array(await (await file.getFile()).slice(request.offset, request.offset + request.length).arrayBuffer());
      }
      return { value: bytes, transfer: [bytes.buffer] };
    }
    case "digest": {
      const hash = sha256.create();
      const held = open.get(`${space}/${request.id}`);
      if (held) {
        held.flush();
        const size = held.getSize();
        for (let offset = 0; offset < size; offset += FILE_BYTES_STEP) hash.update(readAt(held, offset, FILE_BYTES_STEP));
      } else {
        const file = await entry(space, request.id, false);
        if (!file) throw new Error("No such file");
        const reader = (await file.getFile()).stream().getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; hash.update(value); }
      }
      return { value: digestText(hash.digest()) };
    }
    case "remove": {
      release(space, request.id);
      const dir = await folder(space, false);
      await dir?.removeEntry(request.id).catch((error: { name?: string }) => { if (error?.name !== "NotFoundError") throw error; });
      return {};
    }
    case "removeWhere": {
      const dir = await folder(space, false);
      if (!dir) return {};
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) if (name.startsWith(request.prefix)) names.push(name);
      for (const name of names) { release(space, name); await dir.removeEntry(name).catch(() => {}); }
      return {};
    }
  }
}

/** Requests for one file run one after another (a read never sees half of a write); files do not wait for each other. */
const queues = new Map<string, Promise<unknown>>();
scope.onmessage = (event) => {
  const request = event.data;
  const key = "id" in request ? `${request.space}/${request.id}` : "*";
  const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
    try {
      const { value, transfer } = await runRequest(request);
      scope.postMessage({ n: request.n, ok: true, value }, transfer);
    } catch (error) {
      scope.postMessage({ n: request.n, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  queues.set(key, run);
  void run.then(() => { if (queues.get(key) === run) queues.delete(key); });
};
