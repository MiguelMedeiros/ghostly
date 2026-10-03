import { FILE_BYTES_STEP, checkFileId, fileSpace, type FileBytes, type FileStream } from "./fileBytes";

/** Tauri's `invoke`, with the raw-body form the file commands take. */
export type NativeInvoke = (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<unknown>;

/** Received files up to this size can be shown in the app as a Blob (an image, a voice message); a larger video streams (`stream`). */
export const NATIVE_BLOB_MAX = 64 * 1024 * 1024;

/**
 * Files as real files in the app's data folder (`files/<space>/<id>`), written and read by the Rust
 * commands in `apps/desktop/src/file_store.rs`. Bytes cross as raw IPC bodies, a step at a time.
 */
export class NativeFileBytes implements FileBytes {
  readonly kind = "native" as const;
  /** `fixedSpace`: another profile's folder (`forSpace`); the active profile's when left out. */
  constructor(private readonly invoke: NativeInvoke, private readonly fixedSpace?: string) {}

  private space(): string { return this.fixedSpace ?? fileSpace(); }
  private args(id: string, extra: Record<string, unknown> = {}) {
    return { space: this.space(), id: checkFileId(id), ...extra };
  }
  forSpace(space: string): NativeFileBytes { return new NativeFileBytes(this.invoke, space); }

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
    await this.invoke("file_bytes_append", bytes, { headers: { "x-space": this.space(), "x-id": checkFileId(id), "x-offset": String(offset) } });
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
    await this.invoke("file_bytes_remove_where", { space: this.space(), prefix });
  }
  async room(): Promise<number | null> {
    try { return (await this.invoke("file_bytes_room", { space: this.space() })) as number; } catch { return null; }
  }

  /** Small files are read into memory to show them; a large one is only ever saved (`save`). */
  async blob(id: string, type: string): Promise<Blob | null> {
    const size = await this.size(id);
    if (size === null || size > NATIVE_BLOB_MAX) return null;
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < size; offset += FILE_BYTES_STEP) parts.push(await this.read(id, offset, FILE_BYTES_STEP));
    return new Blob(parts as BlobPart[], { type });
  }

  /**
   * A URL Rust serves the file from in ranges (`apps/desktop/src/file_stream.rs`): the `ghostly-file` scheme, or HTTP on
   * 127.0.0.1 on Linux, whose WebKitGTK plays no custom scheme. The WebView reads it as a video seeks.
   */
  async stream(id: string, type: string): Promise<FileStream | null> {
    const opened = await this.invoke("file_bytes_stream_open", this.args(id, { mime: type })).catch(() => null) as { url?: unknown; token?: unknown } | null;
    if (typeof opened?.url !== "string" || typeof opened.token !== "string") return null;
    const { url, token } = opened as { url: string; token: string };
    let released = false;
    return {
      url,
      release: () => {
        if (released) return;
        released = true;
        void this.invoke("file_bytes_stream_close", { token }).catch(() => {});
      },
    };
  }

  async dropSpace(space: string): Promise<void> {
    await this.invoke("file_bytes_remove_where", { space, prefix: "" });
  }

  async save(id: string, name: string): Promise<boolean> {
    return (await this.invoke("file_bytes_save", this.args(id, { name }))) as boolean;
  }
}
