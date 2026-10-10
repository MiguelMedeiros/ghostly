import { sha256 } from "@noble/hashes/sha2.js";
import type { DeviceKind } from "@ghostly/core";
import type { HandoffFile, HandoffSource, HandoffStaging, HandoffStagingHost } from "@ghostly/browser/devices/handoff";
import type { HandoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import { memorySink } from "@ghostly/browser/backup/stream";
import { databaseExists } from "@ghostly/browser/backup/database";
import { databaseName, wrap, type StoredFile } from "@ghostly/browser/shared/idb";
import { FILE_BYTES_STEP, SMALL_FILE_BYTES, digestText, dropFileSpace, fileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileSource, restoreHandoffBundle, writeProfileBackup, type FileSource } from "./profileBackup";
import { listDeviceRecords } from "@ghostly/browser/devices/store";
import { databaseOfSpace, newSpace, pointProfile, recoverProfilePointer, registryKey } from "./profiles";
import { dropWalletStorageOf } from "./profileData";

/*
 * What the handoff needs of the app (WISP 06 § The handoff): a profile's storage as the app keeps it. The giver reads
 * its files and, for pass 2, the rest of the profile in the backup format of WISP 05 (one part, `db/peer`); the taker
 * writes into a staging namespace that no profile names yet, and installs it by pointing the profile at it in one
 * write of the registry (`pointProfile`).
 *
 * A staging namespace notes which files it holds whole and checked under keys of its own outside every profile's
 * prefix (`ghostly-staging:<ns>:<file id>`, one per file), so a pull that stopped goes on without sending them again,
 * and nothing of it is ever taken for a profile's own key. One key per file: a file that begins or finishes writes
 * its own few bytes. As one list, read and written whole twice per file, the n-th file moved about 400 × n characters
 * through the page's storage: 0.77 GB for a profile of 2,000 files.
 */

const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const stagingKey = (ns: string) => `ghostly-staging:${ns}`;
/** One staged file's note. A namespace and a file id hold no colon, so no key of one namespace begins as another's does. */
const stagedKey = (ns: string, id: string) => `${stagingKey(ns)}:${id}`;
const stagedKeys = (ns: string): string[] => {
  const prefix = stagedKey(ns, "");
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(prefix));
};
const isStaged = (file: Partial<HandoffFile>): file is Pick<HandoffFile, "size" | "sha256"> => typeof file.sha256 === "string" && Number.isSafeInteger(file.size);
/** `Staging.restore` writes the files' records in transactions of this many, and of about this many bytes of small files (held in memory until written). */
const RESTORE_FILES = 200, RESTORE_BYTES = 32 * 1024 * 1024;
const spaceOf = (database: string): string => (database === "ghostly" ? "" : database.replace(/^ghostly_/, ""));

/** The peer database opened as it is stored (no version, so nothing migrates); only read-only transactions on it. */
async function openAsStored(database: string): Promise<IDBDatabase> {
  if (!(await databaseExists(database))) throw new Error("The profile's database is not on this device");
  return wrap(indexedDB.open(database));
}

async function digestOf(source: FileSource): Promise<string> {
  const hash = sha256.create();
  for (let done = 0; done < source.size;) {
    const part = await source.read(done, Math.min(FILE_BYTES_STEP, source.size - done));
    if (!part.length) throw new Error("The file is shorter than it says");
    hash.update(part);
    done += part.length;
  }
  return digestText(hash.digest());
}

/** A profile's files with their bytes on this device, and the rest of it as one part. */
function profileSource(database: string): HandoffSource {
  let db: IDBDatabase | null = null;
  let files = new Map<string, { file: HandoffFile; source: FileSource }>();
  const digests = new Map<string, string>();
  const open = async () => (db ??= await openAsStored(database));
  async function load(): Promise<Map<string, { file: HandoffFile; source: FileSource }>> {
    const peer = await open();
    const tx = peer.transaction(["files", "fileState"], "readonly");
    const [rows, states] = await Promise.all([wrap(tx.objectStore("files").getAll()), wrap(tx.objectStore("fileState").getAll())]) as [StoredFile[], Partial<StoredFile>[]];
    const state = new Map(states.map((value) => [value.id, value]));
    const found = new Map<string, { file: HandoffFile; source: FileSource }>();
    for (const row of rows) {
      const file = { ...row, ...state.get(row.id) } as StoredFile;
      if (!file.blob && !file.bytes) continue;
      const source = await fileSource(file, database, false, async () => peer).catch(() => null);
      if (!source) continue;
      // The stored digest when there is one (checked when the file was received or staged), else read and hashed once.
      let sha = digests.get(file.id) ?? (typeof file.digest === "string" && DIGEST.test(file.digest) ? file.digest : undefined);
      if (!sha) { sha = await digestOf(source).catch(() => undefined); if (!sha) continue; }
      digests.set(file.id, sha);
      found.set(file.id, { file: { id: file.id, size: source.size, sha256: sha }, source });
    }
    return found;
  }
  return {
    async files() { files = await load(); return [...files.values()].map((entry) => entry.file); },
    async read(id, offset, length) {
      const entry = files.get(id) ?? (files = await load()).get(id);
      if (!entry) throw new Error("That file is not on this device");
      return entry.source.read(offset, length);
    },
    async bundle() {
      if (databaseName() !== database) throw new Error("Only the profile this page runs is handed over");
      const sink = memorySink();
      await writeProfileBackup(sink, { passphrase: null, handoff: true });
      return sink.bytes();
    },
  };
}

/** File storage of a namespace. A platform whose files are pieces in the profile's own database has none. */
async function spaceFiles(database: string): Promise<FileBytes> {
  const store = (await fileBytes()).forSpace?.(database);
  if (!store) throw new Error("handoff-unsupported: This device keeps files inside the profile's database, which a move cannot write yet.");
  return store;
}

async function copyFile(from: FileBytes, fromId: string, to: FileBytes, file: HandoffFile): Promise<void> {
  const size = await from.size(fromId);
  if (size === null) throw new Error("The file is not on this device");
  await copyFrom({ size, read: (offset, length) => from.read(fromId, offset, length) }, to, file);
}

async function copyFrom(from: FileSource, to: FileBytes, file: HandoffFile): Promise<void> {
  if (from.size !== file.size) throw new Error("The file is not the size it should be");
  await to.remove(file.id).catch(() => {});
  for (let done = 0; done < from.size;) {
    const part = await from.read(done, Math.min(FILE_BYTES_STEP, from.size - done));
    if (!part.length) throw new Error("The file is shorter than it says");
    await to.append(file.id, done, part);
    done += part.length;
  }
  await to.close(file.id);
  if ((await to.digest(file.id)) !== file.sha256) { await to.remove(file.id).catch(() => {}); throw new Error("The copy is not the file"); }
}

/**
 * Copies a file of the frozen copy this page holds (the profile it runs, its database shut) from where the profile keeps
 * it: a file up to `SMALL_FILE_BYTES` is a Blob on its record (a move restores it so), a larger one is in file storage.
 */
async function copyHeldFile(id: string, to: FileBytes, file: HandoffFile): Promise<void> {
  const database = databaseName();
  const db = await openAsStored(database);
  try {
    const tx = db.transaction(["files", "fileState"], "readonly");
    const [row, state] = await Promise.all([wrap(tx.objectStore("files").get(id)), wrap(tx.objectStore("fileState").get(id))]) as [StoredFile | undefined, Partial<StoredFile> | undefined];
    const source = row ? await fileSource({ ...row, ...state } as StoredFile, database, false, async () => db) : null;
    if (!source) throw new Error("The file is not on this device");
    await copyFrom(source, to, file);
  } finally { db.close(); }
}

function dropDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); } catch { resolve(); }
  });
}

/**
 * Every local key of a namespace (never the first profile's, whose prefix every other one shares). Never the registry
 * of profiles: in a Desktop space of its own (GHOSTLY_PROFILE=<base>) the first profile's namespace is the base, and
 * the registry `ghostly_<base>_profiles` has its prefix. Deleting the old namespace after a handoff took the registry
 * with it, so the app opened the empty old namespace and listed no other profile (Linux bug hunt, 2026-10-03).
 */
function dropKeys(ns: string): void {
  if (!ns) return;
  const prefix = `ghostly_${ns}_`, registry = registryKey();
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(prefix) && key !== registry);
  for (const key of keys) { try { localStorage.removeItem(key); } catch { /* nothing more to do */ } }
}

class Staging implements HandoffStaging {
  readonly database: string;
  constructor(private readonly ns: string) {
    this.database = databaseOfSpace(ns);
  }

  /**
   * The one list an earlier build kept under `ghostly-staging:<ns>` (a pull that stopped before an update): each of its
   * files gets its own key, once, and the list goes.
   */
  private adopt(): void {
    const key = stagingKey(this.ns);
    const stored = localStorage.getItem(key);
    if (stored === null) return;
    let parsed: unknown = null;
    try { parsed = JSON.parse(stored); } catch { /* nothing to keep */ }
    for (const file of Array.isArray(parsed) ? parsed as (HandoffFile | null)[] : []) {
      if (!file || typeof file.id !== "string" || !isStaged(file) || localStorage.getItem(stagedKey(this.ns, file.id)) !== null) continue;
      localStorage.setItem(stagedKey(this.ns, file.id), JSON.stringify({ size: file.size, sha256: file.sha256 }));
    }
    localStorage.removeItem(key);
  }
  private list(): HandoffFile[] {
    try {
      this.adopt();
      const prefix = stagedKey(this.ns, "");
      return stagedKeys(this.ns).flatMap((key) => {
        try {
          const file = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<HandoffFile> | null;
          return file && isStaged(file) ? [{ id: key.slice(prefix.length), size: file.size, sha256: file.sha256 }] : [];
        } catch { return []; }
      });
    } catch { return []; }
  }
  private note(file: HandoffFile): void {
    this.adopt();
    localStorage.setItem(stagedKey(this.ns, file.id), JSON.stringify({ size: file.size, sha256: file.sha256 }));
  }
  private forget(id: string): void {
    this.adopt();
    localStorage.removeItem(stagedKey(this.ns, id));
  }

  async held(): Promise<HandoffFile[]> { return this.list(); }

  async begin(id: string): Promise<void> {
    this.forget(id);
    await (await spaceFiles(this.database)).remove(id).catch(() => {});
  }

  async append(id: string, offset: number, bytes: Uint8Array): Promise<void> {
    await (await spaceFiles(this.database)).append(id, offset, bytes);
  }

  async finish(file: HandoffFile): Promise<void> {
    const store = await spaceFiles(this.database);
    await store.close(file.id);
    if ((await store.size(file.id)) !== file.size) throw new Error("The file was not written whole");
    this.note(file);
  }

  async discard(id: string): Promise<void> {
    this.forget(id);
    await (await spaceFiles(this.database)).remove(id).catch(() => {});
  }

  /** From this device's frozen copy: the profile this page runs, whose database stays shut. */
  async copyHeld(fromId: string, file: HandoffFile): Promise<void> {
    await copyHeldFile(fromId, await spaceFiles(this.database), file);
    this.note(file);
  }

  async copyStaged(fromId: string, file: HandoffFile): Promise<void> {
    const store = await spaceFiles(this.database);
    await copyFile(store, fromId, store, file);
    this.note(file);
  }

  async restore(bundle: Uint8Array, files: HandoffFile[]): Promise<void> {
    await this.dropRest();
    await restoreHandoffBundle(bundle, this.ns);
    // Each file's record points at the bytes staged for it: a small one holds them whole, a large one in file storage.
    const store = await spaceFiles(this.database);
    const kind = (await fileBytes()).kind;
    const db = await wrap(indexedDB.open(this.database));
    try {
      for (let at = 0; at < files.length;) {
        // The small files' bytes are read before the transaction opens: one left with nothing asked of it commits.
        const small = new Map<string, Uint8Array>();
        let end = at;
        for (let held = 0; end < files.length && end - at < RESTORE_FILES && held < RESTORE_BYTES; end++) {
          const file = files[end];
          if (file.size > SMALL_FILE_BYTES) continue;
          const bytes = new Uint8Array(file.size);
          for (let done = 0; done < file.size;) {
            const part = await store.read(file.id, done, Math.min(FILE_BYTES_STEP, file.size - done));
            if (!part.length) throw new Error("The file is shorter than it says");
            bytes.set(part, done);
            done += part.length;
          }
          small.set(file.id, bytes);
          held += file.size;
        }
        const tx = db.transaction("files", "readwrite"), records = tx.objectStore("files");
        for (const file of files.slice(at, end)) {
          const read = records.get(file.id);
          read.onsuccess = () => {
            const row = read.result as StoredFile | undefined;
            if (!row) return;
            const { blob: _blob, bytes: _bytes, ...rest } = row;
            const bytes = small.get(file.id);
            records.put(bytes
              ? { ...rest, blob: new Blob([bytes as BlobPart], { type: row.metadata?.mime ?? "" }), digest: row.digest ?? file.sha256 }
              : { ...rest, bytes: kind, digest: row.digest ?? file.sha256 });
          };
        }
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The files' records could not be written")); });
        at = end;
      }
    } finally { db.close(); }
    for (const file of files) if (file.size <= SMALL_FILE_BYTES) await store.remove(file.id).catch(() => {});
  }

  async dropRest(): Promise<void> {
    if (await databaseExists(this.database)) await dropDatabase(this.database);
    dropKeys(this.ns);
  }

  async room(): Promise<number | null> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      return estimate?.quota === undefined ? null : Math.max(0, estimate.quota - (estimate.usage ?? 0));
    } catch { return null; }
  }
}

const staging: HandoffStagingHost = {
  async open(database) {
    return new Staging(database ? spaceOf(database) : newSpace());
  },
  async install(old, staged) { pointProfile(old, staged); },
  async revert(old, staged) { pointProfile(staged, old); },
  async drop(database) {
    const ns = spaceOf(database);
    // The wallets' own storage its records name goes first, while they can still be read (WISP 06 § Installing the
    // staged state): never what a listed profile, this one's current state included, still names.
    await dropWalletStorageOf(database).catch(() => {});
    if (await databaseExists(database)) await dropDatabase(database);
    await dropFileSpace(database).catch(() => {});
    dropKeys(ns);
    try { localStorage.removeItem(stagingKey(ns)); for (const key of stagedKeys(ns)) localStorage.removeItem(key); } catch { /* nothing kept */ }
  },
};

/**
 * At start, before the profile's storage is chosen: a profile a handoff moved to a staged namespace whose registry
 * pointer is gone points there again (`recoverProfilePointer`), if that namespace's database is still on this device.
 * Anything that goes wrong leaves things as they are. Returns whether the pointer was written.
 */
export async function recoverHandoffPointer(id: string): Promise<boolean> {
  try {
    const records = await listDeviceRecords();
    const present: typeof records = [];
    for (const record of records) if (record.home && (await databaseExists(record.profile).catch(() => false))) present.push(record);
    return recoverProfilePointer(id, [...records.filter((record) => !record.home), ...present]);
  } catch { return false; }
}

/** The app's side of the handoff, for this platform. */
export function handoffProfileHost(app: string, kind: DeviceKind): HandoffProfileHost {
  return {
    app, kind, staging,
    source: (database) => profileSource(database),
    async storedVersion(database) {
      if (!(await databaseExists(database))) return null;
      const db = await wrap(indexedDB.open(database));
      const version = db.version;
      db.close();
      return version;
    },
  };
}
