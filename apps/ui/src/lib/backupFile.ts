import { fileBytes } from "@ghostly/browser/shared/fileBytes";
import type { BackupSink } from "@ghostly/browser/backup/stream";
import { saveMade } from "./fileDownload";
import { writeProfileBackup, type BackupOptions, type BackupResult } from "./profileBackup";

/**
 * A backup being written, kept out of memory: staged in this device's file storage (a real file on Desktop, the
 * origin-private file system in a browser, pieces in IndexedDB where neither exists) as it is made, then saved where
 * the person chooses. `save-` copies are removed when the save is over; one a closed window left behind goes when
 * the next backup starts (and, on Desktop, when the app starts).
 *
 * A private window has no storage to stage it in (WebKit's keeps no Blob in IndexedDB and has no origin-private file
 * system): there the bundle is kept in memory, which a private window's short-lived profile fits in.
 */
export interface StagedBackup extends BackupSink {
  /** Bytes written so far. */
  readonly size: number;
  /** The system's save dialog where there is one (`saved`, or `cancelled` when the person closed it), else a download. */
  save(name: string): Promise<"saved" | "downloaded" | "cancelled">;
  /** The whole bundle in memory, for a store that takes it in one request (S3). */
  bytes(): Promise<Uint8Array>;
  /** Removes the staged copy. Safe to call twice, and after `save`. */
  discard(): Promise<void>;
}

const PREFIX = "save-backup-";
/** How long a staged copy outlives the click that downloads it: the browser reads it from storage as it saves it. */
const downloadLifetime = (size: number) => 60_000 + Math.ceil(size / (1024 * 1024)) * 250;

export async function stageBackup(): Promise<StagedBackup> {
  const store = await fileBytes();
  await store.removeWhere(PREFIX).catch(() => {});
  const id = `${PREFIX}${crypto.randomUUID()}`;
  let size = 0, gone = false, keepUntil = 0;
  // Asked once before anything is written: a store that cannot keep a byte is not found out half way through.
  let memory: Uint8Array[] | null = null;
  if (!store.save) {
    try { await store.append(id, 0, new Uint8Array([0])); await store.flush(id); await store.remove(id); } catch { await store.remove(id).catch(() => {}); memory = []; }
  }
  const discard = async () => {
    if (gone || Date.now() < keepUntil) return;
    gone = true;
    if (memory) { memory = []; return; }
    await store.remove(id).catch(() => {});
  };
  return {
    get size() { return size; },
    async write(bytes) {
      if (memory) memory.push(bytes.slice());
      else {
        // The device ran out of room part of the way: said in words a person can act on, like a restore's.
        await store.append(id, size, bytes).catch((error: unknown) => {
          throw (error as { name?: string })?.name === "QuotaExceededError" ? Object.assign(new Error("This device has no room left for this backup. Free some space, then try again."), { cause: error }) : error;
        });
      }
      size += bytes.length;
    },
    async save(name) {
      if (memory) { await saveMade(null, new Blob(memory as BlobPart[], { type: "application/octet-stream" }), name); return "downloaded"; }
      await store.close(id);
      if (store.save) return (await store.save(id, name)) ? "saved" : "cancelled";
      const blob = await store.blob(id, "application/octet-stream");
      if (!blob) throw new Error("This device has no storage for files");
      // A Blob backed by storage: the download reads it from there, so the copy stays until it has had time to.
      await saveMade(null, blob, name);
      const lifetime = downloadLifetime(size);
      keepUntil = Date.now() + lifetime;
      setTimeout(() => { keepUntil = 0; void discard(); }, lifetime);
      return "downloaded";
    },
    async bytes() {
      const out = new Uint8Array(size);
      if (memory) { let at = 0; for (const part of memory) { out.set(part, at); at += part.length; } return out; }
      await store.close(id);
      for (let at = 0; at < size;) {
        const part = await store.read(id, at, 1024 * 1024);
        if (!part.length) throw new Error("The file is shorter than it says");
        out.set(part, at);
        at += part.length;
      }
      return out;
    },
    discard,
  };
}

/**
 * A profile's backup made and saved as a file: staged as it is written, then saved through the save dialog or as a
 * download. `onSaving` when the bundle is whole and the save begins. Cancelled (by the signal, or by closing the save
 * dialog) or failed, the staged copy is removed: no half-written file stays anywhere.
 */
export async function backUpToFile(options: BackupOptions, name: string, onSaving?: () => void): Promise<{ how: "saved" | "downloaded" | "cancelled"; result: BackupResult }> {
  const staged = await stageBackup();
  try {
    const result = await writeProfileBackup(staged, options);
    onSaving?.();
    return { how: await staged.save(name), result };
  } finally {
    await staged.discard();
  }
}

/** A size as people read it: "640 KB", "12.4 MB", "1.3 GB". */
export function byteSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
