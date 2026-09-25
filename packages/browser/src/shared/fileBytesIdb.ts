import { sha256 } from "@noble/hashes/sha2.js";
import { STORES, openDb, wrap } from "./idb";
import { FILE_BYTES_STEP, checkFileId, digestText, type FileBytes } from "./fileBytes";

/** One piece of a file. Every piece but the last is exactly `FILE_BYTES_STEP` long. */
interface Chunk { id: string; index: number; length: number; data: Blob }

/** The piece being filled, kept in memory until it is full or flushed: at most one step per open file. */
interface Tail { index: number; bytes: Uint8Array; length: number; dirty: boolean }

const STEP = FILE_BYTES_STEP;

async function chunks(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(STORES.fileChunks, mode).objectStore(STORES.fileChunks);
}
const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Infinity]);

/**
 * Files in IndexedDB, in 1 MiB pieces stored as Blobs (which browsers keep on disk), for platforms without
 * the origin-private file system. Reading one hands out a Blob made of the pieces, so a download never
 * loads the file into memory either.
 */
export class IdbFileBytes implements FileBytes {
  readonly kind = "idb" as const;
  private readonly tails = new Map<string, Tail>();
  /** Writes to one file run one after another. */
  private readonly queues = new Map<string, Promise<unknown>>();

  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => {});
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return run;
  }

  private async list(id: string): Promise<Omit<Chunk, "data">[]> {
    const store = await chunks("readonly");
    const keys = (await wrap(store.getAllKeys(range(id)))) as [string, number][];
    if (!keys.length) return [];
    const last = (await wrap(store.get(keys[keys.length - 1]))) as Chunk;
    return keys.map(([, index], i) => ({ id, index, length: i === keys.length - 1 ? last.length : STEP }));
  }

  private async put(chunk: Chunk): Promise<void> {
    await wrap((await chunks("readwrite")).put(chunk));
  }

  /** The piece being filled, loaded from storage the first time a file is written. */
  private async tail(id: string): Promise<Tail> {
    let tail = this.tails.get(id);
    if (tail) return tail;
    const pieces = await this.list(id);
    const last = pieces[pieces.length - 1];
    tail = { index: 0, bytes: new Uint8Array(STEP), length: 0, dirty: false };
    if (last && last.length < STEP) {
      const stored = (await wrap((await chunks("readonly")).get([id, last.index]))) as Chunk;
      tail.index = last.index;
      tail.bytes.set(new Uint8Array(await stored.data.arrayBuffer()));
      tail.length = last.length;
    } else if (last) tail.index = last.index + 1;
    this.tails.set(id, tail);
    return tail;
  }

  private async sizeNow(id: string): Promise<number | null> {
    const tail = this.tails.get(id);
    if (tail) return tail.index * STEP + tail.length;
    const pieces = await this.list(id);
    if (!pieces.length) return null;
    return (pieces.length - 1) * STEP + pieces[pieces.length - 1].length;
  }

  private async flushNow(id: string): Promise<void> {
    const tail = this.tails.get(id);
    if (!tail?.dirty) return;
    await this.put({ id, index: tail.index, length: tail.length, data: new Blob([tail.bytes.slice(0, tail.length)]) });
    tail.dirty = false;
  }

  async stage(id: string, source: Blob, onProgress?: (copied: number) => void): Promise<string> {
    checkFileId(id);
    await this.remove(id);
    const hash = sha256.create();
    let offset = 0;
    const reader = source.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await this.append(id, offset, value);
        offset += value.length;
        onProgress?.(offset);
      }
      await this.close(id);
    } catch (error) {
      await reader.cancel().catch(() => {});
      await this.remove(id).catch(() => {});
      throw error;
    }
    return digestText(hash.digest());
  }

  append(id: string, offset: number, bytes: Uint8Array): Promise<void> {
    checkFileId(id);
    return this.serial(id, async () => {
      const tail = await this.tail(id);
      if (offset !== tail.index * STEP + tail.length) throw new Error("File write out of order");
      let pos = 0;
      while (pos < bytes.length) {
        const take = Math.min(STEP - tail.length, bytes.length - pos);
        tail.bytes.set(bytes.subarray(pos, pos + take), tail.length);
        tail.length += take; pos += take; tail.dirty = true;
        if (tail.length === STEP) {
          await this.flushNow(id);
          tail.index += 1; tail.length = 0;
        }
      }
    });
  }

  flush(id: string): Promise<void> {
    return this.serial(id, () => this.flushNow(id));
  }

  close(id: string): Promise<void> {
    return this.serial(id, async () => { await this.flushNow(id); this.tails.delete(id); });
  }

  size(id: string): Promise<number | null> {
    checkFileId(id);
    return this.serial(id, () => this.sizeNow(id));
  }

  truncate(id: string, size: number): Promise<void> {
    checkFileId(id);
    return this.serial(id, async () => {
      await this.flushNow(id);
      this.tails.delete(id);
      const pieces = await this.list(id);
      const keep = Math.floor(size / STEP), rest = size % STEP;
      const store = await chunks("readwrite");
      await Promise.all(pieces.filter((piece) => piece.index > keep || (piece.index === keep && rest === 0))
        .map((piece) => wrap(store.delete([id, piece.index]))));
      const cut = pieces.find((piece) => piece.index === keep);
      if (cut && rest > 0 && cut.length > rest) {
        const stored = (await wrap((await chunks("readonly")).get([id, keep]))) as Chunk;
        await this.put({ id, index: keep, length: rest, data: stored.data.slice(0, rest) });
      }
    });
  }

  read(id: string, offset: number, length: number): Promise<Uint8Array> {
    checkFileId(id);
    return this.serial(id, async () => {
      await this.flushNow(id);
      const out: Uint8Array[] = [];
      const store = await chunks("readonly");
      const end = offset + length;
      for (let index = Math.floor(offset / STEP); index * STEP < end; index++) {
        const piece = (await wrap(store.get([id, index]))) as Chunk | undefined;
        if (!piece) break;
        const from = Math.max(0, offset - index * STEP), to = Math.min(piece.length, end - index * STEP);
        if (from < to) out.push(new Uint8Array(await piece.data.slice(from, to).arrayBuffer()));
        if (piece.length < STEP) break;
      }
      if (out.length === 1) return out[0];
      const joined = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
      let pos = 0;
      for (const part of out) { joined.set(part, pos); pos += part.length; }
      return joined;
    });
  }

  async digest(id: string): Promise<string> {
    const hash = sha256.create();
    for await (const part of this.pieces(id)) hash.update(new Uint8Array(await part.arrayBuffer()));
    return digestText(hash.digest());
  }

  private async *pieces(id: string): AsyncGenerator<Blob> {
    checkFileId(id);
    await this.flush(id);
    const pieces = await this.list(id);
    for (const piece of pieces) {
      const stored = (await wrap((await chunks("readonly")).get([id, piece.index]))) as Chunk | undefined;
      if (stored) yield stored.data;
    }
  }

  async blob(id: string, type: string): Promise<Blob | null> {
    const parts: Blob[] = [];
    for await (const part of this.pieces(id)) parts.push(part);
    return parts.length ? new Blob(parts, { type }) : (await this.size(id)) === 0 ? new Blob([], { type }) : null;
  }

  remove(id: string): Promise<void> {
    checkFileId(id);
    return this.serial(id, async () => {
      this.tails.delete(id);
      await wrap((await chunks("readwrite")).delete(range(id)));
    });
  }

  async removeWhere(prefix: string): Promise<void> {
    for (const id of [...this.tails.keys()]) if (id.startsWith(prefix)) this.tails.delete(id);
    const store = await chunks("readwrite");
    await wrap(prefix ? store.delete(IDBKeyRange.bound([prefix, 0], [`${prefix}￿`, Infinity])) : store.clear());
  }

  async room(): Promise<number | null> {
    return storageRoom();
  }
}

/** What the browser still lets this origin store, or null when it does not say. */
export async function storageRoom(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.quota) return null;
    return Math.max(0, estimate.quota - (estimate.usage ?? 0));
  } catch { return null; }
}
