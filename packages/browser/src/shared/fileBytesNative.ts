import { FILE_BYTES_STEP, checkFileId, fileSpace, type FileBytes } from "./fileBytes";

/** Tauri's `invoke`, with the raw-body form the file commands take. */
export type NativeInvoke = (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<unknown>;

/** Received files up to this size can be shown in the app (an image, a voice message); larger ones are saved. */
export const NATIVE_BLOB_MAX = 64 * 1024 * 1024;

/**
 * Files as real files in the app's data folder (`files/<space>/<id>`), written and read by the Rust
 * commands in `src-tauri/src/file_store.rs`. Bytes cross as raw IPC bodies, a step at a time.
 */
export class NativeFileBytes implements FileBytes {
  readonly kind = "native" as const;
  constructor(private readonly invoke: NativeInvoke) {}

  private args(id: string, extra: Record<string, unknown> = {}) {
    return { space: fileSpace(), id: checkFileId(id), ...extra };
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
    await this.invoke("file_bytes_append", bytes, { headers: { "x-space": fileSpace(), "x-id": checkFileId(id), "x-offset": String(offset) } });
  }
  async flush(id: string): Promise<void> { await this.invoke("file_bytes_flush", this.args(id)); }
  async close(id: string): Promise<void> { await this.invoke("file_bytes_close", this.args(id)); }
  async size(id: string): Promise<number | null> { return (await this.invoke("file_bytes_size", this.args(id))) as number | null; }
  async truncate(id: string, size: number): Promise<void> { await this.invoke("file_bytes_truncate", this.args(id, { size })); }
  async read(id: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.invoke("file_bytes_read", this.args(id, { offset, length: Math.min(length, 16 * FILE_BYTES_STEP) }));
    return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes as number[]);
  }
  async digest(id: string): Promise<string> { return (await this.invoke("file_bytes_digest", this.args(id))) as string; }
  async remove(id: string): Promise<void> { await this.invoke("file_bytes_remove", this.args(id)); }
  async removeWhere(prefix: string): Promise<void> {
    if (prefix && !/^[A-Za-z0-9_-]{1,200}$/.test(prefix)) throw new Error("Invalid file id");
    await this.invoke("file_bytes_remove_where", { space: fileSpace(), prefix });
  }
  async room(): Promise<number | null> {
    try { return (await this.invoke("file_bytes_room", { space: fileSpace() })) as number; } catch { return null; }
  }

  /** Small files are read into memory to show them; a large one is only ever saved (`save`). */
  async blob(id: string, type: string): Promise<Blob | null> {
    const size = await this.size(id);
    if (size === null || size > NATIVE_BLOB_MAX) return null;
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < size; offset += FILE_BYTES_STEP) parts.push(await this.read(id, offset, FILE_BYTES_STEP));
    return new Blob(parts as BlobPart[], { type });
  }

  async dropSpace(space: string): Promise<void> {
    await this.invoke("file_bytes_remove_where", { space, prefix: "" });
  }

  async save(id: string, name: string): Promise<boolean> {
    return (await this.invoke("file_bytes_save", this.args(id, { name }))) as boolean;
  }
}
