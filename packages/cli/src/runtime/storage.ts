import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange, IDBTransaction } from "fake-indexeddb";

/**
 * IndexedDB for the engine on Node, kept on disk.
 *
 * The engine (and the wallet SDKs under it) speak IndexedDB. fake-indexeddb gives the exact semantics in memory;
 * this module makes it durable with a snapshot and an append-only journal in the profile's folder:
 *
 * - every committed read-write transaction appends its puts, deletes and clears to `journal.bin` and is fsynced
 *   before the transaction's `complete` event reaches the engine (a Cashu proof saved is a proof on disk);
 * - a schema change (an upgrade, a deleted database) writes a whole new `snapshot.bin` instead;
 * - at start the snapshot is loaded, the journal replayed, and both folded into a fresh snapshot.
 *
 * Only one process may hold a profile's store: the caller takes the profile lock first (see `profiles.ts`).
 * fake-indexeddb is pinned: this reaches into its raw classes, and `storage.test.ts` checks them.
 */

type Key = unknown;
type Op =
  | { db: string; store: string; kind: "put"; key: Key; value: unknown }
  | { db: string; store: string; kind: "delete"; key: Key }
  | { db: string; store: string; kind: "clear" };

interface RawIndex { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean; initialized: boolean; deleted: boolean }
interface RawRecordStore { values(): Iterable<{ key: Key; value: unknown }> }
interface RawStore {
  name: string; keyPath: string | string[] | null; autoIncrement: boolean; deleted: boolean;
  keyGenerator: { num: number } | null; rawIndexes: Map<string, RawIndex>; records: RawRecordStore; rawDatabase: RawDatabase;
  storeRecord(record: { key: Key; value: unknown }, noOverwrite: boolean, rollbackLog?: unknown[]): Key;
  deleteRecord(key: Key, rollbackLog?: unknown[]): void;
  clear(rollbackLog?: unknown[]): void;
}
interface RawDatabase { name: string; version: number; rawObjectStores: Map<string, RawStore>; transactions: unknown[] }
type RawTransaction = IDBTransaction & { _rollbackLog: unknown[]; _state: string; db: { _rawDatabase: RawDatabase } };
interface RawClasses {
  Database: new (name: string, version: number) => RawDatabase;
  ObjectStore: new (db: RawDatabase, name: string, keyPath: string | string[] | null, autoIncrement: boolean) => RawStore;
  Index: new (store: RawStore, name: string, keyPath: string | string[], multiEntry: boolean, unique: boolean) => RawIndex;
}

interface SnapshotIndex { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }
interface SnapshotStore { name: string; keyPath: string | string[] | null; autoIncrement: boolean; keyGenerator: number | null; indexes: SnapshotIndex[]; records: [Key, unknown][] }
interface Snapshot { format: 1; databases: { name: string; version: number; stores: SnapshotStore[] }[] }

const SNAPSHOT = "snapshot.bin";
const JOURNAL = "journal.bin";
/** A journal past this is folded into the snapshot at the next quiet moment. */
const COMPACT_BYTES = 32 * 1024 * 1024;
const BLOB = "__ghostlyBlob";
const RANGE = "__ghostlyRange";
const PROBE = "__ghostly_storage_probe__";

export interface PersistentIndexedDb {
  readonly factory: IDBFactory;
  /** Waits for writes that carried a Blob (read asynchronously) to reach the disk. */
  flush(): Promise<void>;
  /** Folds the journal into a fresh snapshot. */
  compact(): Promise<void>;
  /** Flushes, compacts, and stops writing: the process is about to leave. */
  close(): Promise<void>;
  /** Bytes of the journal now, for tests and `ghostly status`. */
  journalBytes(): number;
}

/**
 * Opens the store in `dir` (created 0700; files 0600) and installs it as this process's `indexedDB` and
 * `IDBKeyRange`. Call once, before anything touches IndexedDB.
 */
export async function openPersistentIndexedDb(dir: string): Promise<PersistentIndexedDb> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const factory = new IDBFactory();
  const raw = factory as unknown as { _databases: Map<string, RawDatabase> };
  const classes = await probeClasses(factory);

  let writing = true;
  let restoring = true;
  let journalFd: number | null = null;
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let schemaDirty = false;
  const pending = new WeakMap<unknown[], Op[]>();

  const snapshotPath = join(dir, SNAPSHOT);
  const journalPath = join(dir, JOURNAL);

  // Load what the disk holds before any connection opens.
  if (existsSync(snapshotPath)) restore(classes, raw._databases, deserialize(readFileSync(snapshotPath)) as Snapshot);
  if (existsSync(journalPath)) replay(raw._databases, readFileSync(journalPath));
  restoring = false;
  await writeSnapshot();

  // Record what each read-write transaction does, keyed by its rollback log (one array per transaction).
  const storeProto = classes.ObjectStore.prototype as RawStore;
  const storeRecord = storeProto.storeRecord;
  const deleteRecord = storeProto.deleteRecord;
  const clear = storeProto.clear;
  const opsOf = (log: unknown[]) => {
    let ops = pending.get(log);
    if (!ops) pending.set(log, (ops = []));
    return ops;
  };
  storeProto.storeRecord = function (this: RawStore, record, noOverwrite, rollbackLog) {
    const key = storeRecord.call(this, record, noOverwrite, rollbackLog);
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "put", key, value: record.value });
    return key;
  };
  storeProto.deleteRecord = function (this: RawStore, key, rollbackLog) {
    deleteRecord.call(this, key, rollbackLog);
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "delete", key: keyToDisk(key) });
  };
  storeProto.clear = function (this: RawStore, rollbackLog) {
    clear.call(this, rollbackLog);
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "clear" });
  };

  // The transaction's `complete` is where it becomes durable: written before the engine hears of it.
  const txProto = IDBTransaction.prototype as unknown as { dispatchEvent(event: Event): boolean };
  const dispatch = txProto.dispatchEvent;
  txProto.dispatchEvent = function (this: RawTransaction, event: Event) {
    if (event.type === "complete" && writing) {
      if (this.mode === "versionchange") schemaDirty = true;
      else {
        const ops = pending.get(this._rollbackLog);
        if (ops?.length) append(ops);
      }
      pending.delete(this._rollbackLog);
      if (schemaDirty) void enqueue(writeSnapshot);
    } else if (event.type === "abort") pending.delete(this._rollbackLog);
    const dispatched = dispatch.call(this, event);
    // fake-indexeddb keeps every transaction a database ever ran in its list (its scheduler only skips the finished
    // ones), each with its requests, results and rollback log: a daemon's heap grew by about 100 KB a message, without
    // end. Nothing looks for a finished one there again, so it goes once its last event is out.
    if ((event.type === "complete" || event.type === "abort") && this._state === "finished") {
      const list = this.db._rawDatabase.transactions;
      const at = list.indexOf(this);
      if (at >= 0) list.splice(at, 1);
    }
    return dispatched;
  };
  const deleteDatabase = factory.deleteDatabase.bind(factory);
  factory.deleteDatabase = (name: string) => {
    const request = deleteDatabase(name);
    request.addEventListener("success", () => { schemaDirty = true; void enqueue(writeSnapshot); });
    return request;
  };

  function append(ops: Op[]) {
    if (queued === 0 && !ops.some((op) => op.kind === "put" && hasBlob(op.value))) {
      writeEntry(serialize(ops));
      return;
    }
    void enqueue(async () => writeEntry(serialize(await Promise.all(ops.map(async (op) => (op.kind === "put" ? { ...op, value: await blobsToDisk(op.value) } : op))))));
  }

  function enqueue(work: () => Promise<void> | void): Promise<void> {
    queued++;
    queue = queue.then(work).catch((error) => {
      process.stderr.write(`ghostly: storage write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => { queued--; });
    return queue;
  }

  function writeEntry(entry: Buffer) {
    if (!writing) return;
    journalFd ??= openSync(journalPath, "a", 0o600);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(entry.length);
    writeSync(journalFd, Buffer.concat([header, entry]));
    fsyncSync(journalFd);
    if (statSync(journalPath).size > COMPACT_BYTES) void enqueue(writeSnapshot);
  }

  async function writeSnapshot() {
    schemaDirty = false;
    const snapshot: Snapshot = { format: 1, databases: [] };
    for (const db of raw._databases.values()) {
      if (db.name === PROBE) continue;
      const stores: SnapshotStore[] = [];
      for (const store of db.rawObjectStores.values()) {
        if (store.deleted) continue;
        const records: [Key, unknown][] = [];
        for (const record of store.records.values()) records.push([record.key, await blobsToDisk(record.value)]);
        stores.push({
          name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, keyGenerator: store.keyGenerator?.num ?? null,
          indexes: [...store.rawIndexes.values()].filter((index) => !index.deleted).map(({ name, keyPath, multiEntry, unique }) => ({ name, keyPath, multiEntry, unique })),
          records,
        });
      }
      snapshot.databases.push({ name: db.name, version: db.version, stores });
    }
    const temporary = snapshotPath + ".tmp";
    const fd = openSync(temporary, "w", 0o600);
    try { writeSync(fd, serialize(snapshot)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, snapshotPath);
    if (journalFd !== null) { closeSync(journalFd); journalFd = null; }
    rmSync(journalPath, { force: true });
  }

  const installed = globalThis as unknown as Record<string, unknown>;
  installed.indexedDB = factory;
  installed.IDBKeyRange = IDBKeyRange;

  return {
    factory,
    flush: () => queue,
    compact: () => enqueue(writeSnapshot),
    async close() {
      await enqueue(writeSnapshot);
      writing = false;
      if (journalFd !== null) { closeSync(journalFd); journalFd = null; }
    },
    journalBytes: () => (existsSync(journalPath) ? statSync(journalPath).size : 0),
  };
}

/** fake-indexeddb's raw classes, from a throwaway database (they are not exported). */
async function probeClasses(factory: IDBFactory): Promise<RawClasses> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(PROBE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("s", { autoIncrement: true }).createIndex("i", "x");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const rawDb = (db as unknown as { _rawDatabase: RawDatabase })._rawDatabase;
  const rawStore = rawDb.rawObjectStores.get("s")!;
  const classes: RawClasses = {
    Database: rawDb.constructor as RawClasses["Database"],
    ObjectStore: rawStore.constructor as RawClasses["ObjectStore"],
    Index: rawStore.rawIndexes.get("i")!.constructor as RawClasses["Index"],
  };
  db.close();
  await new Promise<void>((resolve) => { const request = factory.deleteDatabase(PROBE); request.onsuccess = request.onerror = () => resolve(); });
  return classes;
}

function restore(classes: RawClasses, databases: Map<string, RawDatabase>, snapshot: Snapshot) {
  if (snapshot?.format !== 1) throw new Error("This profile's store was written by a newer ghostly");
  for (const saved of snapshot.databases) {
    const db = new classes.Database(saved.name, saved.version);
    for (const s of saved.stores) {
      const store = new classes.ObjectStore(db, s.name, s.keyPath, s.autoIncrement);
      if (store.keyGenerator && s.keyGenerator !== null) store.keyGenerator.num = s.keyGenerator;
      for (const i of s.indexes) {
        const index = new classes.Index(store, i.name, i.keyPath, i.multiEntry, i.unique);
        index.initialized = true;
        store.rawIndexes.set(i.name, index);
      }
      db.rawObjectStores.set(s.name, store);
      for (const [key, value] of s.records) store.storeRecord({ key, value: blobsFromDisk(value) }, false);
    }
    databases.set(saved.name, db);
  }
}

/** Replays whole entries; a torn last entry (the process died mid-write) was never acknowledged and is dropped. */
function replay(databases: Map<string, RawDatabase>, journal: Buffer) {
  let offset = 0;
  while (offset + 4 <= journal.length) {
    const length = journal.readUInt32BE(offset);
    if (offset + 4 + length > journal.length) break;
    let ops: Op[];
    try { ops = deserialize(journal.subarray(offset + 4, offset + 4 + length)) as Op[]; } catch { break; }
    offset += 4 + length;
    for (const op of ops) {
      const store = databases.get(op.db)?.rawObjectStores.get(op.store);
      if (!store) continue;
      if (op.kind === "put") store.storeRecord({ key: op.key, value: blobsFromDisk(op.value) }, false);
      else if (op.kind === "delete") store.deleteRecord(keyFromDisk(op.key));
      else store.clear();
    }
  }
}

function keyToDisk(key: Key): Key {
  if (key instanceof IDBKeyRange) return { [RANGE]: { lower: key.lower, upper: key.upper, lowerOpen: key.lowerOpen, upperOpen: key.upperOpen } };
  return key;
}
function keyFromDisk(key: Key): Key {
  const range = (key as Record<string, { lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean }> | null)?.[RANGE];
  if (!range) return key;
  if (range.lower === undefined) return IDBKeyRange.upperBound(range.upper, range.upperOpen);
  if (range.upper === undefined) return IDBKeyRange.lowerBound(range.lower, range.lowerOpen);
  return IDBKeyRange.bound(range.lower, range.upper, range.lowerOpen, range.upperOpen);
}

function hasBlob(value: unknown, depth = 0): boolean {
  if (value instanceof Blob) return true;
  if (!value || typeof value !== "object" || depth > 32 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (value instanceof Map) { for (const [k, v] of value) if (hasBlob(k, depth + 1) || hasBlob(v, depth + 1)) return true; return false; }
  for (const item of Object.values(value)) if (hasBlob(item, depth + 1)) return true;
  return false;
}

/** v8 cannot serialize a Blob: it goes to disk as its bytes and type, and comes back a Blob. */
async function blobsToDisk(value: unknown, depth = 0): Promise<unknown> {
  if (!hasBlob(value, depth)) return value;
  if (value instanceof Blob) return { [BLOB]: { type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) } };
  if (Array.isArray(value)) return Promise.all(value.map((item) => blobsToDisk(item, depth + 1)));
  if (value instanceof Map) return new Map(await Promise.all([...value].map(async ([k, v]) => [k, await blobsToDisk(v, depth + 1)] as const)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as object)) out[k] = await blobsToDisk(v, depth + 1);
  return out;
}
function blobsFromDisk(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 32 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  const blob = (value as Record<string, { type: string; bytes: Uint8Array }>)[BLOB];
  if (blob) return new Blob([blob.bytes as BlobPart], { type: blob.type });
  if (Array.isArray(value)) return value.map((item) => blobsFromDisk(item, depth + 1));
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, blobsFromDisk(v, depth + 1)]));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = blobsFromDisk(v, depth + 1);
  return out;
}
