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
 *   before the transaction's `complete` event reaches the engine (a Cashu proof saved is a proof on disk); one opened
 *   with `durability: "relaxed"` is appended at once and synced with the next one, or within a second;
 * - a schema change (an upgrade, a deleted database) writes a whole new `snapshot.bin` instead;
 * - at start the snapshot is loaded, the journal replayed, and both folded into a fresh snapshot (with no journal, the
 *   snapshot stays as it is).
 *
 * Only one process may hold a profile's store: the caller takes the profile lock first (see `profiles.ts`).
 * fake-indexeddb is pinned: this reaches into its raw classes, and `storage.test.ts` checks them.
 */

type Key = unknown;
type Op =
  | { db: string; store: string; kind: "put"; key: Key; value: unknown }
  | { db: string; store: string; kind: "delete"; key: Key }
  | { db: string; store: string; kind: "clear" };

interface RawRecord { key: Key; value: unknown }
interface RawIndex {
  name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean; initialized: boolean; deleted: boolean;
  records: RawRecordStore; storeRecord(record: RawRecord): void;
}
interface RawNode { record: RawRecord; left: RawNode | undefined; right: RawNode | undefined; parent: RawNode | undefined; deleted: boolean; red: boolean }
interface RawRecordStore {
  values(): Iterable<RawRecord>; clear(): unknown;
  get(key: Key): RawRecord | undefined;
  put(record: RawRecord, noOverwrite?: boolean): RawRecord | undefined;
  delete(key: Key): RawRecord[];
  deleteByValue(key: Key): RawRecord[];
  records: { _root: RawNode | undefined; _numNodes: number; _numTombstones: number; delete(record: RawRecord): void };
  keysAreUnique: boolean;
}
interface RawStore {
  name: string; keyPath: string | string[] | null; autoIncrement: boolean; deleted: boolean;
  keyGenerator: { num: number } | null; rawIndexes: Map<string, RawIndex>; records: RawRecordStore; rawDatabase: RawDatabase;
  storeRecord(record: { key: Key; value: unknown }, noOverwrite: boolean, rollbackLog?: unknown[]): Key;
  deleteRecord(key: Key, rollbackLog?: unknown[]): void;
  clear(rollbackLog?: unknown[]): void;
}
interface RawDatabase { name: string; version: number; rawObjectStores: Map<string, RawStore>; transactions: unknown[] }
type RawTransaction = IDBTransaction & { durability?: string; _rollbackLog: unknown[]; _state: string; db: { _rawDatabase: RawDatabase } };
interface RawClasses {
  Database: new (name: string, version: number) => RawDatabase;
  ObjectStore: new (db: RawDatabase, name: string, keyPath: string | string[] | null, autoIncrement: boolean) => RawStore;
  Index: new (store: RawStore, name: string, keyPath: string | string[], multiEntry: boolean, unique: boolean) => RawIndex;
  RecordStore: new (keysAreUnique: boolean) => RawRecordStore;
}

interface SnapshotIndex { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }
interface SnapshotStore { name: string; keyPath: string | string[] | null; autoIncrement: boolean; keyGenerator: number | null; indexes: SnapshotIndex[]; records: [Key, unknown][] }
interface Snapshot { format: 1; databases: { name: string; version: number; stores: SnapshotStore[] }[] }

const SNAPSHOT = "snapshot.bin";
const JOURNAL = "journal.bin";
/** A journal past this is folded into the snapshot at the next quiet moment. */
const COMPACT_BYTES = 32 * 1024 * 1024;
/** How long `close` waits for the transactions still running: one left open for good does not keep the process. */
const CLOSE_WAIT_MS = 5_000;
/** How long a relaxed transaction's entry may wait for a sync when no other transaction brings one. */
const RELAXED_SYNC_MS = 1_000;
const BLOB = "__ghostlyBlob";
const RANGE = "__ghostlyRange";
const PROBE = "__ghostly_storage_probe__";

export interface PersistentIndexedDb {
  readonly factory: IDBFactory;
  /** A journal was found at open: the process before this one did not close the store (killed, a power cut). */
  readonly recovered: boolean;
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
  dropIndexEntriesByRecord(classes, (a, b) => factory.cmp(a, b));

  let writing = true;
  let restoring = true;
  let journalFd: number | null = null;
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let schemaDirty = false;
  /** Set while the journal holds relaxed entries no sync has covered yet. */
  let relaxed: ReturnType<typeof setTimeout> | null = null;
  const pending = new WeakMap<unknown[], Op[]>();

  const snapshotPath = join(dir, SNAPSHOT);
  const journalPath = join(dir, JOURNAL);

  // Load what the disk holds before any connection opens; a snapshot with no journal after it is already what is held.
  const snapshotFound = existsSync(snapshotPath), journalFound = existsSync(journalPath);
  if (snapshotFound) restore(classes, raw._databases, deserialize(readFileSync(snapshotPath)) as Snapshot, keyOrder((a, b) => factory.cmp(a, b)));
  if (journalFound) replay(raw._databases, readFileSync(journalPath));
  restoring = false;
  if (journalFound || !snapshotFound) await writeSnapshot();

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
        if (ops?.length) append(ops, this.durability === "relaxed");
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

  function append(ops: Op[], lazy: boolean) {
    if (queued === 0 && !ops.some((op) => op.kind === "put" && hasBlob(op.value))) {
      writeEntry(serialize(ops), lazy);
      return;
    }
    void enqueue(async () => writeEntry(serialize(await Promise.all(ops.map(async (op) => (op.kind === "put" ? { ...op, value: await blobsToDisk(op.value) } : op)))), lazy));
  }

  function enqueue(work: () => Promise<void> | void): Promise<void> {
    queued++;
    queue = queue.then(work).catch(failed).finally(() => { queued--; });
    return queue;
  }

  function failed(error: unknown) {
    process.stderr.write(`ghostly: storage write failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  /**
   * `lazy`: a relaxed transaction's entry. A sync blocks the whole process for milliseconds, and what such a
   * transaction wrote can be made again (the event set's note of a message it already reported): written, it outlives
   * the process; a power cut may take its last second.
   */
  function writeEntry(entry: Buffer, lazy = false) {
    if (!writing) return;
    journalFd ??= openSync(journalPath, "a", 0o600);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(entry.length);
    writeSync(journalFd, Buffer.concat([header, entry]));
    if (lazy) relaxed ??= setTimeout(() => { try { sync(); } catch (error) { failed(error); } }, RELAXED_SYNC_MS).unref();
    else sync();
    if (statSync(journalPath).size > COMPACT_BYTES) void enqueue(writeSnapshot);
  }

  function sync() {
    if (relaxed) { clearTimeout(relaxed); relaxed = null; }
    if (journalFd !== null) fsyncSync(journalFd);
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
    // The snapshot holds what the journal's entries said, the relaxed ones too.
    if (relaxed) { clearTimeout(relaxed); relaxed = null; }
    if (journalFd !== null) { closeSync(journalFd); journalFd = null; }
    rmSync(journalPath, { force: true });
  }

  /**
   * Resolves once no transaction is left to run. The engine does not wait for every write (`void db.deleteLink(…)`),
   * and fake-indexeddb runs a transaction on a later turn of the event loop: a command that closed in the turn it wrote
   * in (no chat to say goodbye to) took its last snapshot before the write, and answered done for what was not on disk.
   * Two quiet turns in a row: a write that begins when another ends (a chat's messages after its row) is seen too.
   */
  async function settled() {
    const until = Date.now() + CLOSE_WAIT_MS;
    for (let quiet = 0; quiet < 2 && Date.now() < until; ) {
      await new Promise((resolve) => setImmediate(resolve));
      const busy = [...raw._databases.values()].some((db) => db.transactions.some((transaction) => (transaction as RawTransaction)._state !== "finished"));
      quiet = busy ? 0 : quiet + 1;
    }
  }

  const installed = globalThis as unknown as Record<string, unknown>;
  installed.indexedDB = factory;
  installed.IDBKeyRange = IDBKeyRange;

  return {
    factory,
    recovered: journalFound,
    flush: () => queue,
    compact: () => enqueue(writeSnapshot),
    async close() {
      await settled();
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
    RecordStore: rawStore.records.constructor as RawClasses["RecordStore"],
  };
  db.close();
  await new Promise<void>((resolve) => { const request = factory.deleteDatabase(PROBE); request.onsuccess = request.onerror = () => resolve(); });
  return classes;
}

/** The classes whose index upkeep is already by record: they are fake-indexeddb's own, shared by every store opened. */
const byRecord = new WeakSet<object>();

/**
 * fake-indexeddb drops an overwritten or deleted record from an index by walking every entry of it (an index is in
 * its own key's order, not the record's): each delivery mark, edit or reaction cost time with every message of the
 * profile, 170 ms at 10,000, and a long chat slowed every other one. The store has the records it just replaced or
 * removed in hand, and they say which entries to drop; a call that comes any other way still walks.
 */
function dropIndexEntriesByRecord(classes: RawClasses, cmp: (a: Key, b: Key) => number) {
  const storeProto = classes.ObjectStore.prototype as RawStore;
  const recordsProto = classes.RecordStore.prototype as RawRecordStore;
  if (byRecord.has(storeProto)) return;
  byRecord.add(storeProto);
  const { storeRecord, deleteRecord } = storeProto;
  const { put, delete: remove, deleteByValue } = recordsProto;
  let gone: { indexes: Map<string, RawIndex>; records: RawRecord[] } | null = null;

  storeProto.storeRecord = function (this: RawStore, record, noOverwrite, rollbackLog) {
    if (!this.rawIndexes.size) return storeRecord.call(this, record, noOverwrite, rollbackLog);
    const records: Partial<RawRecordStore> = this.records, indexes = this.rawIndexes, outer = gone;
    records.put = (next, keep) => {
      const replaced = put.call(this.records, next, keep);
      gone = { indexes, records: replaced ? [replaced] : [] };
      return replaced;
    };
    try { return storeRecord.call(this, record, noOverwrite, rollbackLog); } finally { delete records.put; gone = outer; }
  };
  storeProto.deleteRecord = function (this: RawStore, key, rollbackLog) {
    if (!this.rawIndexes.size) return deleteRecord.call(this, key, rollbackLog);
    const records: Partial<RawRecordStore> = this.records, indexes = this.rawIndexes, outer = gone;
    records.delete = (range) => {
      const removed = remove.call(this.records, range);
      gone = { indexes, records: removed };
      return removed;
    };
    try { deleteRecord.call(this, key, rollbackLog); } finally { delete records.delete; gone = outer; }
  };
  recordsProto.deleteByValue = function (this: RawRecordStore, key) {
    let index: RawIndex | undefined;
    if (gone) for (const candidate of gone.indexes.values()) if (candidate.records === this) index = candidate;
    if (!gone || !index) return deleteByValue.call(this, key);
    const dropped: RawRecord[] = [];
    for (const entry of indexEntries(index, gone.records, cmp)) {
      // A unique index finds an entry by its key alone: it may be another record's (a put the index refused).
      if (this.keysAreUnique) {
        const held = this.get(entry.key);
        if (!held || cmp(held.value, entry.value) !== 0) continue;
      }
      this.records.delete(entry);
      dropped.push(entry);
    }
    return dropped;
  };
}

/**
 * `cmp` for keys that are stored already (a record's, an index entry's): numbers, strings and arrays of them are
 * ordered here, as IndexedDB orders them (a number before a string before an array; strings by code unit; arrays item
 * by item, then the shorter first). Anything else (a date, bytes, a value that is no key) is left to `cmp`, which
 * checks and copies both keys at every call: on the way back from a snapshot that was a third of a large store's time.
 */
export function keyOrder(cmp: (a: Key, b: Key) => number): (a: Key, b: Key) => number {
  const order = (a: Key, b: Key): number => {
    const first = typeof a, second = typeof b;
    if (first === "number" && second === "number") return a === b ? 0 : (a as number) > (b as number) ? 1 : (a as number) < (b as number) ? -1 : cmp(a, b);
    if (first === "string" && second === "string") return a === b ? 0 : (a as string) > (b as string) ? 1 : -1;
    if (first === "number" && second === "string") return -1;
    if (first === "string" && second === "number") return 1;
    if (Array.isArray(a)) {
      if (second === "number" || second === "string") return 1;
      if (!Array.isArray(b)) return cmp(a, b);
      const length = Math.min(a.length, b.length);
      for (let at = 0; at < length; at++) {
        const item = order(a[at], b[at]);
        if (item !== 0) return item;
      }
      return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
    }
    if (Array.isArray(b) && (first === "number" || first === "string")) return -1;
    return cmp(a, b);
  };
  return order;
}

/**
 * The snapshot's records come in key order (as `writeSnapshot` walks them), so each store's tree and each index's are
 * built whole from sorted arrays: storing record by record compared every key down the tree, a 70,000-message profile
 * took seconds. A snapshot not in order (never written so) is stored record by record.
 */
function restore(classes: RawClasses, databases: Map<string, RawDatabase>, snapshot: Snapshot, cmp: (a: Key, b: Key) => number) {
  if (snapshot?.format !== 1) throw new Error("This profile was last used by a newer version of ghostly (its store has a format this version does not read). Update ghostly to open it.");
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
      const records = s.records.map(([key, value]): RawRecord => ({ key, value: blobsFromDisk(value) }));
      if (records.some((record, at) => at > 0 && cmp(records[at - 1].key, record.key) >= 0)) {
        for (const record of records) store.storeRecord(record, false);
        continue;
      }
      fill(store.records, records);
      for (const index of store.rawIndexes.values()) fill(index.records, indexEntries(index, records, cmp));
    }
    databases.set(saved.name, db);
  }
}

/**
 * An index's entries for records in key order, sorted by the index's key: the index derives them itself (key path,
 * multi-entry, invalid keys skipped) into a list instead of its tree. A stable sort keeps equal index keys in the
 * records' key order, the tree's own tie-break.
 */
function indexEntries(index: RawIndex, records: RawRecord[], cmp: (a: Key, b: Key) => number): RawRecord[] {
  const entries: RawRecord[] = [];
  const tree = index.records;
  index.records = { get: () => undefined, put: (entry: RawRecord) => { entries.push(entry); } } as unknown as RawRecordStore;
  try {
    for (const record of records) if (!absent(index.keyPath, record.value)) index.storeRecord(record);
  } finally { index.records = tree; }
  return entries.sort((a, b) => cmp(a.key, b.key));
}

/**
 * Whether a key path surely finds nothing in a value: a plain object along it lacks the step (most messages have no
 * `card` for the card index). The index would throw and catch a DataError for each of those; anything else it judges.
 */
function absent(keyPath: string | string[], value: unknown): boolean {
  if (typeof keyPath !== "string" || keyPath === "") return false;
  let object = value;
  for (const step of keyPath.split(".")) {
    if (object === null || typeof object !== "object" || Array.isArray(object) || object instanceof Blob) return false;
    if (!Object.hasOwn(object, step)) return true;
    object = (object as Record<string, unknown>)[step];
  }
  return false;
}

/**
 * fake-indexeddb's red-black tree, built balanced from sorted records: every level full but the last, whose nodes
 * are red, so each path holds the same number of black nodes and later inserts rebalance as usual.
 */
function fill(store: RawRecordStore, sorted: RawRecord[]) {
  const deepest = sorted.length ? Math.floor(Math.log2(sorted.length)) : 0;
  const build = (low: number, high: number, parent: RawNode | undefined, depth: number): RawNode | undefined => {
    if (low > high) return undefined;
    const middle = (low + high) >>> 1;
    const node: RawNode = { record: sorted[middle], left: undefined, right: undefined, parent, deleted: false, red: depth > 0 && depth === deepest };
    node.left = build(low, middle - 1, node, depth + 1);
    node.right = build(middle + 1, high, node, depth + 1);
    return node;
  };
  store.records._root = build(0, sorted.length - 1, undefined, 0);
  store.records._numNodes = sorted.length;
  store.records._numTombstones = 0;
}

/**
 * Replays whole entries; a torn last entry (the process died mid-write) was never acknowledged and is dropped.
 *
 * A store's indexes are set aside while its ops replay and rebuilt once at the end: fake-indexeddb drops an
 * overwritten or deleted record from an index by walking every record of it, so a crash after a busy chat took
 * tens of seconds to minutes to start, one write at a time against the whole profile.
 */
function replay(databases: Map<string, RawDatabase>, journal: Buffer) {
  const touched = new Map<RawStore, Map<string, RawIndex>>();
  try { replayEntries(databases, journal, touched); } finally {
    for (const [store, indexes] of touched) {
      store.rawIndexes = indexes;
      for (const index of indexes.values()) {
        index.records.clear();
        if (!index.initialized) continue;
        for (const record of store.records.values()) index.storeRecord(record);
      }
    }
  }
}

function replayEntries(databases: Map<string, RawDatabase>, journal: Buffer, touched: Map<RawStore, Map<string, RawIndex>>) {
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
      if (!touched.has(store)) { touched.set(store, store.rawIndexes); store.rawIndexes = new Map(); }
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
