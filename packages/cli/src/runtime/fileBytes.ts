import { createHash } from "node:crypto";
import { mkdir, open, readdir, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { FILE_BYTES_STEP, checkFileId, digestText, fileSpace, type FileBytes } from "@ghostly/browser/shared/fileBytes";

/**
 * Files as real files in the profile's folder (`files/<space>/<id>`, 0600 in 0700 folders), the Node twin of the
 * Desktop's `native` backend (`shared/fileBytesNative.ts`, which goes through Rust). Registered as `native` and
 * preferred, so every file of any size is a file on disk, read and written a step at a time.
 */
export class NodeFileBytes implements FileBytes {
  readonly kind = "native" as const;
  private readonly writers = new Map<string, Promise<FileHandle>>();

  constructor(private readonly root: string) {}

  private folder(space = fileSpace()): string { return join(this.root, space); }
  private path(id: string): string { return join(this.folder(), checkFileId(id)); }

  private writer(id: string): Promise<FileHandle> {
    const path = this.path(id);
    let handle = this.writers.get(path);
    if (!handle) {
      handle = mkdir(this.folder(), { recursive: true, mode: 0o700 }).then(() => open(path, "a", 0o600));
      this.writers.set(path, handle);
      handle.catch(() => this.writers.delete(path));
    }
    return handle;
  }

  async stage(id: string, source: Blob, onProgress?: (copied: number) => void): Promise<string> {
    await this.remove(id);
    try {
      for (let offset = 0; offset < source.size; offset += FILE_BYTES_STEP) {
        const bytes = new Uint8Array(await source.slice(offset, offset + FILE_BYTES_STEP).arrayBuffer());
        await this.append(id, offset, bytes);
        onProgress?.(offset + bytes.length);
      }
      if (source.size === 0) await this.append(id, 0, new Uint8Array());
      await this.close(id);
      return await this.digest(id);
    } catch (error) {
      await this.remove(id).catch(() => {});
      throw error;
    }
  }

  async append(id: string, offset: number, bytes: Uint8Array): Promise<void> {
    const size = (await this.size(id)) ?? 0;
    if (offset !== size) throw new Error(`Append at ${offset}, but the file holds ${size} bytes`);
    const handle = await this.writer(id);
    if (bytes.length) await handle.write(bytes);
  }

  async flush(id: string): Promise<void> {
    const handle = this.writers.get(this.path(id));
    if (handle) await (await handle).sync();
  }

  async close(id: string): Promise<void> {
    const path = this.path(id);
    const handle = this.writers.get(path);
    if (!handle) return;
    this.writers.delete(path);
    const file = await handle;
    await file.sync();
    await file.close();
  }

  async size(id: string): Promise<number | null> {
    const path = this.path(id);
    try { return (await stat(path)).size; } catch { return null; }
  }

  async truncate(id: string, size: number): Promise<void> {
    await this.close(id);
    const handle = await open(this.path(id), "r+");
    try { await handle.truncate(size); await handle.sync(); } finally { await handle.close(); }
  }

  async read(id: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await open(this.path(id), "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, 16 * FILE_BYTES_STEP));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }

  async digest(id: string): Promise<string> {
    const hash = createHash("sha256");
    const handle = await open(this.path(id), "r");
    try {
      for await (const chunk of handle.createReadStream({ highWaterMark: FILE_BYTES_STEP })) hash.update(chunk as Buffer);
    } finally { await handle.close().catch(() => {}); }
    return digestText(new Uint8Array(hash.digest()));
  }

  /** The file read into memory, to show; a large one only ever goes to disk (`ghostly file save`). */
  async blob(id: string, type: string): Promise<Blob | null> {
    const size = await this.size(id);
    if (size === null || size > 64 * 1024 * 1024) return null;
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < size; offset += FILE_BYTES_STEP) parts.push(await this.read(id, offset, FILE_BYTES_STEP));
    return new Blob(parts as BlobPart[], { type });
  }

  async remove(id: string): Promise<void> {
    await this.close(id).catch(() => {});
    await rm(this.path(id), { force: true });
  }

  async removeWhere(prefix: string): Promise<void> {
    if (prefix && !/^[A-Za-z0-9_-]{1,200}$/.test(prefix)) throw new Error("Invalid file id");
    let names: string[];
    try { names = await readdir(this.folder()); } catch { return; }
    await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) => this.remove(name)));
  }

  async room(): Promise<number | null> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const fs = await statfs(this.root);
      return fs.bavail * fs.bsize;
    } catch { return null; }
  }

  async dropSpace(space: string): Promise<void> {
    await rm(this.folder(space), { recursive: true, force: true });
  }
}
