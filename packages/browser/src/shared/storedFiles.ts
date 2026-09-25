import { FILE_BYTES_STEP, fileBytesOf, type FileBytes } from "./fileBytes";
import { fileStore, type StoredFile } from "./idb";

/** The bytes a file holds: its metadata says, and a file stored before that says it with its Blob. */
export function storedSize(file: StoredFile): number {
  return file.metadata?.size ?? file.blob?.size ?? 0;
}

async function backend(file: StoredFile): Promise<FileBytes | null> {
  return file.bytes ? fileBytesOf(file.bytes) : null;
}

/** The file as a Blob backed by storage, or null where it cannot be had as one (see `FileBytes.blob`). */
export async function storedBlob(file: StoredFile, type: string): Promise<Blob | null> {
  if (file.blob) return file.blob.slice(0, file.blob.size, type);
  return (await backend(file))?.blob(file.id, type) ?? null;
}

/** At most `length` bytes from `offset`. */
export async function readStored(file: StoredFile, offset: number, length: number): Promise<Uint8Array> {
  if (file.blob) return new Uint8Array(await file.blob.slice(offset, offset + length).arrayBuffer());
  const bytes = await backend(file);
  if (!bytes) throw new Error("The file is gone");
  return bytes.read(file.id, offset, length);
}

/** The file, a step at a time, from `offset`. */
export async function* streamStored(file: StoredFile, offset = 0): AsyncGenerator<Uint8Array> {
  const size = storedSize(file);
  while (offset < size) {
    const part = await readStored(file, offset, Math.min(FILE_BYTES_STEP, size - offset));
    if (!part.length) throw new Error("The file is shorter than it says");
    offset += part.length;
    yield part;
  }
}

/** A file's record and its bytes, wherever they are. */
export async function removeStored(id: string): Promise<void> {
  const file = await fileStore.get(id);
  await fileStore.delete(id);
  if (file?.bytes) await (await backend(file))?.remove(id);
}

/** Writes are gathered to this size before they go to storage: a chunk from the wire is 16 KiB. */
const GATHER = 256 * 1024;

/**
 * Writes one file in order, gathering small writes into larger ones. `written` counts what was handed over,
 * gathered or not; `flush` makes all of it durable.
 */
export class FileAppender {
  private buffer = new Uint8Array(GATHER);
  private buffered = 0;
  private stored: number;

  constructor(readonly bytes: FileBytes, readonly id: string, offset = 0) { this.stored = offset; }

  get written(): number { return this.stored + this.buffered; }

  async append(chunk: Uint8Array): Promise<void> {
    if (this.buffered + chunk.length > GATHER) await this.drain();
    if (chunk.length >= GATHER) {
      await this.bytes.append(this.id, this.stored, chunk);
      this.stored += chunk.length;
      return;
    }
    this.buffer.set(chunk, this.buffered);
    this.buffered += chunk.length;
  }

  private async drain(): Promise<void> {
    if (!this.buffered) return;
    const part = this.buffer.slice(0, this.buffered);
    await this.bytes.append(this.id, this.stored, part);
    this.stored += part.length;
    this.buffered = 0;
  }

  async flush(): Promise<void> {
    await this.drain();
    await this.bytes.flush(this.id);
  }

  async close(): Promise<void> {
    await this.drain();
    await this.bytes.close(this.id);
  }
}
