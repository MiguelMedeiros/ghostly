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
import { databaseOfSpace, newSpace, pointProfile, profileOfDatabase, recoverProfilePointer } from "./profiles";
import { dropWalletStorageOf, keyOfSpace } from "./profileData";
import { MEDIA_DEVICES_SUFFIX } from "./mediaDevices";

/*
 * What the handoff needs of the app (WISP 06 § The handoff): a profile's storage as the app keeps it. The giver reads
 * its files and, for pass 2, the rest of the profile in the backup format of WISP 05 (one part, `db/peer`); the taker
 * writes into a staging namespace that no profile names yet, and installs it by pointing the profile at it in one
 * write of the registry (`pointProfile`).
 *
 * A staging namespace notes which files it holds whole and checked in a database of its own outside every profile's
 * (`ghostly-staging`, one record per file keyed by namespace and file id), so a pull that stopped goes on without
 * sending them again. They go when the namespace is installed or dropped. One record per file: a file that begins or
 * finishes writes its own few bytes. As one list, read and written whole twice per file, the n-th file moved about
 * 400 × n characters through the page's storage: 0.77 GB for a profile of 2,000 files. As one localStorage key per
 * file, 124 characters each filled the origin's fixed localStorage cap (about 2.6M characters on WebKit) at about 20k
 * files, and the move failed as "Not enough space" with gigabytes of quota free (bug hunt, 2026-11-06).
 */

const DIGEST = /^[A-Za-z0-9_-]{43}$/;
/** Where earlier builds kept the notes: one list under `ghostly-staging:<ns>`, then one key per file under it. */
const stagingKey = (ns: string) => `ghostly-staging:${ns}`;
/** A namespace and a file id hold no colon, so no key of one namespace begins as another's does. */
const stagedKeys = (ns: string): string[] => {
  const prefix = `${stagingKey(ns)}:`;
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(prefix));
};
/** A staged file left as a Blob on a record of the frozen copy: that database, and the record's id. */
type HeldBlob = { database: string; id: string };
type Note = { ns: string; id: string; size: number; sha256: string; held?: HeldBlob };

const NOTES_DB = "ghostly-staging", NOTES = "files";
/** Every note of a namespace: an array key sorts after every string, so `[ns, []]` closes the range. */
const notesOf = (ns: string) => IDBKeyRange.bound([ns], [ns, []]);
let notesDb: Promise<IDBDatabase> | null = null;

function openNotes(): Promise<IDBDatabase> {
  notesDb ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(NOTES_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(NOTES, { keyPath: ["ns", "id"] }); };
    request.onsuccess = () => {
      const db = request.result;
      // Deleted or changed by another page: let it, and open again on the next use.
      db.onversionchange = () => { db.close(); notesDb = null; };
      db.onclose = () => { notesDb = null; };
      resolve(db);
    };
    request.onerror = (event) => { event.preventDefault?.(); reject(request.error ?? new Error("The staged files' notes did not open")); };
  }).catch((error: unknown) => { notesDb = null; throw error; });
  return notesDb;
}

/** One transaction on the notes; resolves once it is written, with what `use`'s request read. */
async function inNotes<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openNotes();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(NOTES, mode);
    const request = use(tx.objectStore(NOTES));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The staged files' notes could not be written"));
  });
}

/** A namespace's notes of its staged files, those an earlier build kept in localStorage included. Never makes the database. */
async function dropNotes(ns: string): Promise<void> {
  try { localStorage.removeItem(stagingKey(ns)); for (const key of stagedKeys(ns)) localStorage.removeItem(key); } catch { /* nothing kept */ }
  try { if (notesDb || (await databaseExists(NOTES_DB))) await inNotes("readwrite", (store) => { store.delete(notesOf(ns)); }); } catch { /* nothing kept */ }
}
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
      // The stored digest when there is one (checked when the file was received or staged), else read and hashed once. A
      // group file's digest is its author's from the announcement on, before any byte came: until its bytes passed it
      // (`done`), what is stored under it can be another file a member served whole, so it is read and hashed.
      const checked = !file.group || file.direction === "out" || file.transfer?.state === "done";
      let sha = digests.get(file.id) ?? (checked && typeof file.digest === "string" && DIGEST.test(file.digest) ? file.digest : undefined);
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

/** Copies `from` under `file.id`, hashing the bytes as they go by: the copy is kept only when it is the file. */
async function copyFrom(from: FileSource, to: FileBytes, file: HandoffFile): Promise<void> {
  if (from.size !== file.size) throw new Error("The file is not the size it should be");
  await to.remove(file.id).catch(() => {});
  const hash = sha256.create();
  for (let done = 0; done < from.size;) {
    const part = await from.read(done, Math.min(FILE_BYTES_STEP, from.size - done));
    if (!part.length) throw new Error("The file is shorter than it says");
    await to.append(file.id, done, part);
    hash.update(part);
    done += part.length;
  }
  await to.close(file.id);
  if (digestText(hash.digest()) !== file.sha256 || (await to.size(file.id)) !== file.size) { await to.remove(file.id).catch(() => {}); throw new Error("The copy is not the file"); }
}

/**
 * Copies a file of the frozen copy this page holds (the profile it runs, its database shut, `db` opened as stored) from
 * where the profile keeps it: a file up to `SMALL_FILE_BYTES` is a Blob on its record (a move restores it so), a larger
 * one is in file storage. A Blob whose record's checked digest is the file's is not copied (WISP 06 § Installing the
 * staged state: "Files `B` already held are linked into it, not copied"): `restore` puts that Blob on the staged record.
 * Copied, every file was written twice and read back once at each move back, the device's whole media history (bug hunt,
 * 2026-11-04). Resolves to whether it was left where it is.
 */
async function copyHeldFile(db: IDBDatabase, id: string, to: FileBytes, file: HandoffFile): Promise<boolean> {
  const tx = db.transaction(["files", "fileState"], "readonly");
  const [row, state] = await Promise.all([wrap(tx.objectStore("files").get(id)), wrap(tx.objectStore("fileState").get(id))]) as [StoredFile | undefined, Partial<StoredFile> | undefined];
  const stored = row ? { ...row, ...state } as StoredFile : null;
  // As `profileSource` takes a stored digest: a group file's is its author's until its bytes passed it.
  const checked = !!stored && (!stored.group || stored.direction === "out" || stored.transfer?.state === "done");
  if (stored?.blob && checked && stored.digest === file.sha256 && stored.blob.size === file.size) {
    await to.remove(file.id).catch(() => {});
    return true;
  }
  const source = stored ? await fileSource(stored, db.name, false, async () => db) : null;
  if (!source) throw new Error("The file is not on this device");
  await copyFrom(source, to, file);
  return false;
}

function dropDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); } catch { resolve(); }
  });
}

/**
 * Every local key of a namespace (`keyOfSpace`). Never the registry of profiles: in a Desktop space of its own
 * (GHOSTLY_PROFILE=<base>) the first profile's namespace is the base, and the registry `ghostly_<base>_profiles` has its
 * prefix. Deleting the old namespace after a handoff took the registry with it, so the app opened the empty old
 * namespace and listed no other profile (Linux bug hunt, 2026-10-03). The first profile's original namespace, whose
 * prefix every other one shares, is dropped only once no profile runs on it: a take of it left its chats with their keys,
 * drafts and invites, and the first profile listed them again once removed here.
 */
function dropKeys(ns: string): void {
  if (!ns && profileOfDatabase(databaseOfSpace(ns))) return;
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key && keyOfSpace(ns, key));
  for (const key of keys) { try { localStorage.removeItem(key); } catch { /* nothing more to do */ } }
}

class Staging implements HandoffStaging {
  readonly database: string;
  constructor(private readonly ns: string) {
    this.database = databaseOfSpace(ns);
  }

  private adopted: Promise<void> | null = null;

  /**
   * The notes an earlier build kept in localStorage (a pull that stopped before an update): the one list under
   * `ghostly-staging:<ns>`, then one key per file under it, the later winning. Each becomes a record, once, and the keys go.
   */
  private adopt(): Promise<void> {
    this.adopted ??= (async () => {
      const notes = new Map<string, Note>();
      const take = (id: unknown, file: Partial<Note> | null) => {
        const held = file?.held;
        if (typeof id !== "string" || !file || !isStaged(file)) return;
        notes.set(id, { ns: this.ns, id, size: file.size, sha256: file.sha256, ...(typeof held?.database === "string" && typeof held.id === "string" ? { held: { database: held.database, id: held.id } } : {}) });
      };
      const parse = (text: string | null): unknown => { try { return JSON.parse(text ?? "null"); } catch { return null; } };
      const list = parse(localStorage.getItem(stagingKey(this.ns)));
      for (const file of Array.isArray(list) ? list as (Partial<HandoffFile> | null)[] : []) take(file?.id, file);
      const keys = stagedKeys(this.ns), prefix = `${stagingKey(this.ns)}:`;
      for (const key of keys) take(key.slice(prefix.length), parse(localStorage.getItem(key)) as Partial<Note> | null);
      if (notes.size) await inNotes("readwrite", (store) => { for (const note of notes.values()) store.put(note); });
      for (const key of [stagingKey(this.ns), ...keys]) localStorage.removeItem(key);
    })().catch((error: unknown) => { this.adopted = null; throw error; });
    return this.adopted;
  }
  private async notes(): Promise<Note[]> {
    await this.adopt();
    return (await inNotes("readonly", (store) => store.getAll(notesOf(this.ns))) ?? []) as Note[];
  }
  /** `held`: the file is not in this namespace's storage but a Blob on that record of the frozen copy. */
  private async note(file: HandoffFile, held?: HeldBlob): Promise<void> {
    await this.adopt();
    const note: Note = { ns: this.ns, id: file.id, size: file.size, sha256: file.sha256, ...(held ? { held } : {}) };
    await inNotes("readwrite", (store) => { store.put(note); });
  }
  private async heldBlob(id: string): Promise<HeldBlob | null> {
    try {
      await this.adopt();
      return ((await inNotes("readonly", (store) => store.get([this.ns, id]))) as Note | undefined)?.held ?? null;
    } catch { return null; }
  }
  private async forget(id: string): Promise<void> {
    await this.adopt();
    await inNotes("readwrite", (store) => { store.delete([this.ns, id]); });
  }

  async held(): Promise<HandoffFile[]> {
    try {
      return (await this.notes()).filter(isStaged).map(({ id, size, sha256 }) => ({ id, size, sha256 }));
    } catch { return []; }
  }

  async begin(id: string): Promise<void> {
    await this.forget(id);
    await (await spaceFiles(this.database)).remove(id).catch(() => {});
  }

  async append(id: string, offset: number, bytes: Uint8Array): Promise<void> {
    await (await spaceFiles(this.database)).append(id, offset, bytes);
  }

  async finish(file: HandoffFile): Promise<void> {
    const store = await spaceFiles(this.database);
    await store.close(file.id);
    if ((await store.size(file.id)) !== file.size) throw new Error("The file was not written whole");
    await this.note(file);
  }

  async discard(id: string): Promise<void> {
    await this.forget(id);
    await (await spaceFiles(this.database)).remove(id).catch(() => {});
  }

  /** From this device's frozen copy: the profile this page runs, whose database stays shut (opened once, read only). */
  async copyHeld(copies: { fromId: string; file: HandoffFile }[]): Promise<void> {
    if (!copies.length) return;
    const to = await spaceFiles(this.database);
    const db = await openAsStored(databaseName());
    try {
      for (const { fromId, file } of copies) {
        let kept: boolean;
        try { kept = await copyHeldFile(db, fromId, to, file); } catch { continue; }
        await this.note(file, kept ? { database: db.name, id: fromId } : undefined);
      }
    } finally { db.close(); }
  }

  async copyStaged(fromId: string, file: HandoffFile): Promise<void> {
    const held = await this.heldBlob(fromId);
    if (held) { await this.note(file, held); return; }
    const store = await spaceFiles(this.database);
    await copyFile(store, fromId, store, file);
    await this.note(file);
  }

  async restore(bundle: Uint8Array, files: HandoffFile[]): Promise<void> {
    await this.dropRest();
    await restoreHandoffBundle(bundle, this.ns);
    // Each file's record points at the bytes staged for it: a small one holds them whole, a large one in file storage.
    const store = await spaceFiles(this.database);
    const kind = (await fileBytes()).kind;
    const db = await wrap(indexedDB.open(this.database));
    // The frozen copies files are left on as Blobs (`copyHeld`), opened as stored once each.
    const frozen = new Map<string, IDBDatabase>();
    const notes = new Map((await this.notes()).map((note) => [note.id, note.held]));
    const kept = new Map(files.map((file) => [file.id, notes.get(file.id) ?? null]));
    try {
      for (let at = 0; at < files.length;) {
        // The small files' bytes are read before the transaction opens: one left with nothing asked of it commits. All of
        // a transaction's at once: each read is a round trip to the file storage's worker, which serves other files
        // meanwhile. One after the other, 8,000 files took 7.2 s of the stretch both devices are frozen (bug hunt, 2026-11-07).
        const small = new Map<string, Uint8Array | Blob>();
        const blobs = new Map<string, { file: HandoffFile; id: string }[]>();
        const reads: Promise<void>[] = [];
        let end = at;
        for (let held = 0; end < files.length && end - at < RESTORE_FILES && held < RESTORE_BYTES; end++) {
          const file = files[end];
          if (file.size > SMALL_FILE_BYTES) continue;
          const from = kept.get(file.id);
          // The frozen copy's own Blob, not its bytes: nothing read or written here but its record.
          if (from) { blobs.set(from.database, blobs.get(from.database) ?? []).get(from.database)!.push({ file, id: from.id }); continue; }
          reads.push((async () => {
            const bytes = new Uint8Array(file.size);
            for (let done = 0; done < file.size;) {
              const part = await store.read(file.id, done, Math.min(FILE_BYTES_STEP, file.size - done));
              if (!part.length) throw new Error("The file is shorter than it says");
              bytes.set(part, done);
              done += part.length;
            }
            small.set(file.id, bytes);
          })());
          held += file.size;
        }
        await Promise.all(reads);
        for (const [database, list] of blobs) {
          if (!frozen.has(database)) frozen.set(database, await openAsStored(database));
          const rows = frozen.get(database)!.transaction("files", "readonly").objectStore("files");
          const found = await Promise.all(list.map(({ id }) => wrap(rows.get(id)) as Promise<StoredFile | undefined>));
          list.forEach(({ file }, i) => {
            const blob = found[i]?.blob;
            if (!blob || blob.size !== file.size) throw new Error("The file is not on this device");
            small.set(file.id, blob);
          });
        }
        const tx = db.transaction("files", "readwrite"), records = tx.objectStore("files");
        for (const file of files.slice(at, end)) {
          const read = records.get(file.id);
          read.onsuccess = () => {
            const row = read.result as StoredFile | undefined;
            if (!row) return;
            const { blob: _blob, bytes: _bytes, ...rest } = row;
            const bytes = small.get(file.id), type = row.metadata?.mime ?? "";
            records.put(bytes
              ? { ...rest, blob: bytes instanceof Uint8Array ? new Blob([bytes as BlobPart], { type }) : bytes.slice(0, bytes.size, type), digest: row.digest ?? file.sha256 }
              : { ...rest, bytes: kind, digest: row.digest ?? file.sha256 });
          };
        }
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The files' records could not be written")); });
        at = end;
      }
    } finally {
      db.close();
      for (const opened of frozen.values()) opened.close();
    }
    // Their bytes are on their records now; the staged copies go a transaction's worth at a time, as they were read.
    const copies = files.filter((file) => file.size <= SMALL_FILE_BYTES && !kept.get(file.id));
    for (let at = 0; at < copies.length; at += RESTORE_FILES) {
      await Promise.all(copies.slice(at, at + RESTORE_FILES).map((file) => store.remove(file.id).catch(() => {})));
    }
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

/**
 * The microphone, camera and speaker this device chose for the profile, from the namespace it ran before onto the one
 * staged: a move never carries the giver's (`writeProfileBackup`), whose ids name that browser's devices. Taking the
 * profile back, a device uses its own headset again; a device the profile never ran on uses the system's defaults.
 */
function keepOwnDevices(old: string, staged: string): void {
  const prefix = (ns: string) => (ns ? `ghostly_${ns}_` : "ghostly_");
  try {
    const own = localStorage.getItem(`${prefix(spaceOf(old))}${MEDIA_DEVICES_SUFFIX}`);
    if (own !== null) localStorage.setItem(`${prefix(spaceOf(staged))}${MEDIA_DEVICES_SUFFIX}`, own);
  } catch { /* the defaults, as on a device the profile never ran on */ }
}

const staging: HandoffStagingHost = {
  async open(database) {
    return new Staging(database ? spaceOf(database) : newSpace());
  },
  // Installed, the staged namespace is the profile's own: its notes only served a pull that had not finished, and one
  // key per file would stay outside every profile's prefix for as long as this copy lives (bug hunt, 2026-11-04).
  async install(old, staged) { keepOwnDevices(old, staged); pointProfile(old, staged); await dropNotes(spaceOf(staged)); },
  async revert(old, staged) { pointProfile(staged, old); },
  async drop(database) {
    const ns = spaceOf(database);
    // The wallets' own storage its records name goes first, while they can still be read (WISP 06 § Installing the
    // staged state): never what a listed profile, this one's current state included, still names.
    await dropWalletStorageOf(database).catch(() => {});
    if (await databaseExists(database)) await dropDatabase(database);
    const files = await dropFileSpace(database).then(() => null, (error: unknown) => error);
    dropKeys(ns);
    await dropNotes(ns);
    // Files that stayed are said: whoever names this namespace keeps naming it, and drops it again later.
    if (files) throw files;
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
