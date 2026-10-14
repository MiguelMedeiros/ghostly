import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange, IDBTransaction } from "fake-indexeddb";
import { loadSqlite, openRowFile, rowRecords, type RowFile } from "./rows";
import { handOut, openTreeFile, SqlTree, type TreeFile } from "./sqlTree";

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
 * - at start the snapshot is loaded and the journal replayed. A short journal that is whole stays as it is, and so
 *   does the snapshot; a long one, or one whose last entry was cut short, is folded into a fresh snapshot first;
 * - a close leaves a short journal too, with a mark at its end that says the store was closed: the rows are on disk
 *   already, and writing the whole snapshot again for them cost a second or more of every command on a large profile;
 * - a journal begins by naming the snapshot it follows: one found beside another snapshot is in that snapshot already
 *   (the process died between writing the snapshot and removing the journal), and is not replayed over it;
 * - the engine's messages, and their indexes, are kept in `rows.db` (SQLite: ./sqlTree.ts), not in memory: their
 *   store's tree and its indexes' are SQL trees in place of fake-indexeddb's, and the snapshot (format 3) says only that
 *   they are there. A transaction's writes go to SQLite once the journal has them (each entry is numbered, and SQLite
 *   says which it holds: a replay skips those). A profile's snapshot of format 1 (every value inline) or 2 (values in
 *   rows) is moved at its first open; a Node without `node:sqlite` keeps format 1.
 *
 * Only one process may hold a profile's store: the caller takes the profile lock first (see `profiles.ts`).
 * fake-indexeddb is pinned: this reaches into its raw classes, and `storage.test.ts` checks them.
 */

type Key = unknown;
type Op =
  | { db: string; store: string; kind: "put"; key: Key; value: unknown }
  | { db: string; store: string; kind: "delete"; key: Key }
  | { db: string; store: string; kind: "clear"; seq?: number };

interface RawRecord { key: Key; value: unknown }
interface RawIndex {
  name: string; rawObjectStore: RawStore; initialize(transaction: unknown): void; keyPath: string | string[]; multiEntry: boolean; unique: boolean; initialized: boolean; deleted: boolean;
  records: RawRecordStore; storeRecord(record: RawRecord): void;
}
interface RawNode { record: RawRecord; left: RawNode | undefined; right: RawNode | undefined; parent: RawNode | undefined; deleted: boolean; red: boolean }
interface RawRecordStore {
  values(range?: unknown, direction?: string): Iterable<RawRecord>; clear(): unknown;
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
  getValue(key: Key): unknown;
  getAllValues(range: unknown, count: number | undefined, direction: string | undefined): unknown[];
}
interface RawDatabase { name: string; version: number; rawObjectStores: Map<string, RawStore>; transactions: unknown[] }
type RawTransaction = IDBTransaction & { durability?: string; _rollbackLog: unknown[]; _state: string; db: { _rawDatabase: RawDatabase } };
interface RawClasses {
  Database: new (name: string, version: number) => RawDatabase;
  ObjectStore: new (db: RawDatabase, name: string, keyPath: string | string[] | null, autoIncrement: boolean) => RawStore;
  Index: new (store: RawStore, name: string, keyPath: string | string[], multiEntry: boolean, unique: boolean) => RawIndex;
  RecordStore: new (keysAreUnique: boolean) => RawRecordStore;
  /** fake-indexeddb's ConstraintError, which a tree throws for a key already there. */
  constraintError: new () => Error;
}

interface SnapshotIndex { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }
/**
 * A store kept on disk (format 2): its records' keys in key order, each one's row (-1 for one kept inline: a value with
 * a Blob), the inline values by position, and each index's entries in its own order, as [index key, record position].
 */
interface SnapshotRows { keys: Key[]; ids: number[]; inline: [number, unknown][]; indexes: Record<string, [Key, number][]> }
/** `onDisk`: its records and its indexes' entries are in rows.db (format 3). */
interface SnapshotStore { name: string; keyPath: string | string[] | null; autoIncrement: boolean; keyGenerator: number | null; indexes: SnapshotIndex[]; records: [Key, unknown][]; rows?: SnapshotRows; onDisk?: true }
/**
 * `journal`: the name a journal that follows this snapshot begins with (absent in one an older version wrote).
 * `format`: 1, every value inline; 2, the stores kept on disk have their values in `rows.db`; 3, their records and index
 * entries too. An older ghostly refuses 2 and 3.
 */
interface Snapshot { format: 1 | 2 | 3; journal?: string; databases: { name: string; version: number; stores: SnapshotStore[] }[] }

const SNAPSHOT = "snapshot.bin";
const JOURNAL = "journal.bin";
const ROWS = "rows.db";
/** A journal past this is folded into the snapshot at the next quiet moment. */
const COMPACT_BYTES = 32 * 1024 * 1024;
/** A journal up to this is kept at close and at start: replaying it costs less than writing the snapshot again. */
const KEEP_BYTES = 1024 * 1024;
/**
 * The database a journal's close mark names. No profile has it, so a replay skips the mark (an older version's too:
 * it skips an op whose store it does not find).
 */
const CLOSED = "__ghostly_closed__";
/** The database a journal's first entry names, with the snapshot the journal follows: skipped by a replay as the mark is. */
const FOLLOWS = "__ghostly_journal__";
/** The database an entry's first op names, with the entry's number (`seq`): SQLite's trees hold the entries up to theirs. */
const SEQ = "__ghostly_entry__";
/** How long `close` waits for the transactions still running: one left open for good does not keep the process. */
const CLOSE_WAIT_MS = 5_000;
/** How long a relaxed transaction's entry may wait for a sync when no other transaction brings one. */
const RELAXED_SYNC_MS = 1_000;
const BLOB = "__ghostlyBlob";
const RANGE = "__ghostlyRange";
const PROBE = "__ghostly_storage_probe__";

export interface PersistentIndexedDb {
  readonly factory: IDBFactory;
  /** The journal found at open did not end with a close mark: the process before this one did not close the store (killed, a power cut). */
  readonly recovered: boolean;
  /** Waits for writes that carried a Blob (read asynchronously) to reach the disk. */
  flush(): Promise<void>;
  /** Folds the journal into a fresh snapshot. */
  compact(): Promise<void>;
  /** Flushes, marks the journal closed (or folds it, once it is long), and stops writing: the process is about to leave. */
  close(): Promise<void>;
  /** Bytes of the journal now, for tests and `ghostly status`. */
  journalBytes(): number;
  /**
   * The whole store as one snapshot of format 1 (every value inline, `rows.db` read), written to `path`: a backup's
   * store, which any ghostly can restore.
   */
  exportSnapshot(path: string): Promise<void>;
}

export interface StoreOptions {
  /** The stores kept in `rows.db`, records and indexes: by default the engine's messages. */
  rowsOnDisk?: (db: string, store: string) => boolean;
}

/**
 * Opens the store in `dir` (created 0700; files 0600) and installs it as this process's `indexedDB` and
 * `IDBKeyRange`. Call once, before anything touches IndexedDB.
 */
export async function openPersistentIndexedDb(dir: string, options: StoreOptions = {}): Promise<PersistentIndexedDb> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const factory = new IDBFactory();
  const raw = factory as unknown as { _databases: Map<string, RawDatabase> };
  const classes = await probeClasses(factory);
  dropIndexEntriesByRecord(classes, (a, b) => factory.cmp(a, b));
  readWithoutCopy(classes);
  const order = keyOrder((a, b) => factory.cmp(a, b));

  // Found before it is opened: opening makes it, and a snapshot that names it needs the file it named.
  const rowsPath = join(dir, ROWS);
  const rowsFound = existsSync(rowsPath);
  const sqlite = await loadSqlite();
  const trees: TreeFile | null = sqlite ? openTreeFile(sqlite, rowsPath, classes.constraintError) : null;
  const onDisk = options.rowsOnDisk ?? ((_db: string, store: string) => store === "messages");
  // This store's own databases only: the hooks are on fake-indexeddb's shared classes, and another store opened in the
  // process (a test's) must not move this one's records into its rows.db.
  const disk = (store: RawStore) => trees !== null && raw._databases.get(store.rawDatabase.name) === store.rawDatabase && onDisk(store.rawDatabase.name, store.name);
  /** The number of the last journal entry made: SQLite says which ones its trees hold (`TreeFile.applied`). */
  let seq = trees?.applied() ?? 0;

  let writing = true;
  let restoring = true;
  let journalFd: number | null = null;
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let schemaDirty = false;
  /** A write to the journal or the snapshot failed: what is held is not all on disk, and only a whole snapshot makes it so. */
  let unsaved = false;
  /** Set while the journal holds relaxed entries no sync has covered yet. */
  let relaxed: ReturnType<typeof setTimeout> | null = null;
  const pending = new WeakMap<unknown[], Op[]>();

  const snapshotPath = join(dir, SNAPSHOT);
  const journalPath = join(dir, JOURNAL);

  // Load what the disk holds before any connection opens; a snapshot with no journal after it is already what is held.
  const snapshotFound = existsSync(snapshotPath), journalFound = existsSync(journalPath);
  const saved = snapshotFound ? (deserialize(readFileSync(snapshotPath)) as Snapshot) : null;
  // A snapshot of format 2 reads its values from the rows it names, once: they move into the trees at this open.
  const rows: RowFile | null = sqlite && saved?.format === 2 && rowsFound ? openRowFile(sqlite, rowsPath) : null;
  /** Stores kept on disk that a snapshot of format 1 had inline, written straight into rows.db by `restore`. */
  let restoredToDisk = false;
  try {
    if (saved) restoredToDisk = restore(classes, raw._databases, saved, order, { trees, rows, made: rows ? rowRecords(rows) : null, rowsFound, attach: attachTrees, onDisk });
  } catch (error) {
    rows?.close();
    trees?.db.close();
    // Made by this open: a second one must refuse as this one did, not find an empty file and read nothing.
    if (!rowsFound) for (const file of [rowsPath, `${rowsPath}-wal`, `${rowsPath}-shm`]) rmSync(file, { force: true });
    throw error;
  }
  /** The name of the snapshot on disk, which its journal begins with. */
  let snapshotName = saved?.journal;
  let journal = journalFound ? readFileSync(journalPath) : null;
  const named = journal ? follows(journal) : undefined;
  // A journal that names another snapshot is in this one already: replayed, it would put back rows as they were before
  // what came between (an upgrade that rewrote them). The process that left it died while it folded.
  const folded = named !== undefined && snapshotName !== undefined && named !== snapshotName;
  if (folded) { rmSync(journalPath, { force: true }); journal = null; }
  // Trees just written from a snapshot of format 1 hold that snapshot and nothing after it: the whole journal replays.
  const replayed = journal ? replay(raw._databases, journal, order, { applied: restoredToDisk ? 0 : seq, onTrees }) : { end: 0, closed: !folded, seq: 0 };
  // What the journal had for the trees and SQLite did not: written now, numbered as its last entry.
  seq = Math.max(seq, replayed.seq);
  if (trees) { trees.complete(null, seq); trees.apply(seq); }
  // Stores kept on disk still in memory (a snapshot of format 1 or 2, and the journal replayed over it): moved now.
  let moved = restoredToDisk;
  if (trees) for (const db of raw._databases.values()) for (const store of db.rawObjectStores.values()) if (!store.deleted && disk(store) && !onTrees(store)) { toDisk(store); moved = true; }
  restoring = false;
  /** Whether the journal on disk says the store is closed: nothing was written since its mark, or there is none. */
  let marked = replayed.closed;
  // A journal cut short is never appended to: what came after the torn bytes could not be read back. Nor one that
  // does not name this snapshot (an older version's).
  const kept = !!journal && named !== undefined && named === snapshotName && replayed.end === journal.length && journal.length <= KEEP_BYTES;
  const rewrite = (journal && !kept) || !snapshotFound || moved;
  if (rewrite) await writeSnapshot();
  rows?.close();
  // Format 2's rows: in the trees now, and the snapshot that named them is gone.
  if (rows && rewrite) trees!.db.exec("DROP TABLE IF EXISTS rows");

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
  /**
   * A write to a store kept on disk goes to its trees' layer of this transaction (its rollback log names it): a store
   * made since the open (an upgrade) moves to the trees at its first write.
   */
  function owned<T>(store: RawStore, rollbackLog: unknown[] | undefined, work: () => T): T {
    if (!disk(store)) return work();
    if (!onTrees(store)) toDisk(store);
    if (!rollbackLog) return work();
    trees!.owner = rollbackLog;
    try { return work(); } finally { trees!.owner = null; }
  }
  storeProto.storeRecord = function (this: RawStore, record, noOverwrite, rollbackLog) {
    const key = owned(this, rollbackLog, () => storeRecord.call(this, record, noOverwrite, rollbackLog));
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "put", key, value: record.value });
    return key;
  };
  storeProto.deleteRecord = function (this: RawStore, key, rollbackLog) {
    owned(this, rollbackLog, () => deleteRecord.call(this, key, rollbackLog));
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "delete", key: keyToDisk(key) });
  };
  storeProto.clear = function (this: RawStore, rollbackLog) {
    owned(this, rollbackLog, () => clear.call(this, rollbackLog));
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "clear" });
  };
  // An index made on a store kept on disk (an upgrade) is a tree there too, emptied of what an earlier one of its name left.
  const indexProto = classes.Index.prototype as RawIndex;
  const initialize = indexProto.initialize;
  indexProto.initialize = function (this: RawIndex, transaction: unknown) {
    const store = this.rawObjectStore;
    if (disk(store) && onTrees(store) && !(this.records.records instanceof SqlTree)) {
      const tree = trees!.tree(trees!.treeId(store.rawDatabase.name, store.name, this.name), this.records.keysAreUnique, true);
      tree.clear();
      attachTree(this.records, tree, true);
    }
    return initialize.call(this, transaction);
  };

  // The transaction's `complete` is where it becomes durable: written before the engine hears of it.
  const txProto = IDBTransaction.prototype as unknown as { dispatchEvent(event: Event): boolean };
  const dispatch = txProto.dispatchEvent;
  txProto.dispatchEvent = function (this: RawTransaction, event: Event) {
    if (event.type === "complete" && writing) {
      if (this.mode === "versionchange") {
        schemaDirty = true;
        // A schema change goes to a snapshot, not the journal: what it wrote in the trees (an index filled) goes now.
        if (trees) { trees.complete(this._rollbackLog, ++seq); written(seq); }
      } else {
        const ops = pending.get(this._rollbackLog);
        if (ops?.length) {
          const entry = ++seq;
          trees?.complete(this._rollbackLog, entry);
          append(ops, this.durability === "relaxed", entry);
        }
      }
      pending.delete(this._rollbackLog);
      if (schemaDirty) void enqueue(writeSnapshot);
    } else if (event.type === "abort") {
      pending.delete(this._rollbackLog);
      trees?.abort(this._rollbackLog);
    }
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

  /** A committed transaction's entry, numbered `entry` (its first op says so, where there are trees). */
  function append(ops: Op[], lazy: boolean, entry: number) {
    if (trees) ops = [{ db: SEQ, store: "", kind: "clear", seq: entry }, ...ops];
    if (queued === 0 && !ops.some((op) => op.kind === "put" && hasBlob(op.value))) {
      if (writeEntry(serialize(ops), lazy)) written(entry);
      return;
    }
    void enqueue(async () => { if (writeEntry(serialize(await Promise.all(ops.map(async (op) => (op.kind === "put" ? { ...op, value: await blobsToDisk(op.value) } : op)))), lazy)) written(entry); });
  }

  /**
   * The journal has entry `entry`: the trees' layers up to it go to SQLite. One that fails stays in memory, where reads
   * find it, and goes with the next entry, or before the next snapshot (which fails without it).
   */
  function written(entry: number) {
    if (!trees || !writing) return;
    try { trees.apply(entry); } catch (error) { failed(error); }
  }

  /** Whether a store's records are in the trees already. */
  function onTrees(store: RawStore): boolean {
    return store.records.records instanceof SqlTree;
  }

  /** A tree in place of fake-indexeddb's in a record store; its `clear` and (an index's) `deleteByValue` with it. */
  function attachTree(records: RawRecordStore, tree: SqlTree, index: boolean) {
    (records as unknown as { records: unknown }).records = tree;
    records.clear = () => { const deleted = [...tree.getAllRecords()]; tree.clear(); return deleted; };
    if (index) records.deleteByValue = (key: Key) => tree.deleteByValue((key instanceof IDBKeyRange ? key : IDBKeyRange.only(key)) as never);
  }

  /** A store whose records and index entries are in rows.db already (a snapshot of format 3): its trees attached. */
  function attachTrees(store: RawStore) {
    const db = store.rawDatabase.name;
    attachTree(store.records, trees!.tree(trees!.treeId(db, store.name), true, false), false);
    for (const index of store.rawIndexes.values()) if (!index.deleted) attachTree(index.records, trees!.tree(trees!.treeId(db, store.name, index.name), index.records.keysAreUnique, true), true);
  }

  /** A store kept on disk, held in memory: its records and index entries written to rows.db, its trees in place. */
  function toDisk(store: RawStore) {
    const db = store.rawDatabase.name;
    const indexes = [...store.rawIndexes.values()].filter((index) => !index.deleted);
    const id = trees!.treeId(db, store.name), ids = indexes.map((index) => trees!.treeId(db, store.name, index.name));
    trees!.db.exec("BEGIN");
    try {
      trees!.load(id, store.records.values(), false, true);
      indexes.forEach((index, at) => trees!.load(ids[at]!, index.records.values(), true, index.records.keysAreUnique));
      trees!.db.exec("COMMIT");
    } catch (error) { trees!.db.exec("ROLLBACK"); throw error; }
    attachTree(store.records, trees!.tree(id, true, false), false);
    indexes.forEach((index, at) => attachTree(index.records, trees!.tree(ids[at]!, index.records.keysAreUnique, true), true));
  }

  /** The trees of the stores and indexes the schema has now: the others are swept after a snapshot. */
  function liveTrees(): Set<number> {
    const keep = new Set<number>();
    for (const db of raw._databases.values()) for (const store of db.rawObjectStores.values()) {
      if (store.deleted || !onTrees(store)) continue;
      keep.add((store.records.records as unknown as SqlTree).id);
      for (const index of store.rawIndexes.values()) if (!index.deleted && index.records.records instanceof SqlTree) keep.add((index.records.records as unknown as SqlTree).id);
    }
    return keep;
  }

  function enqueue(work: () => Promise<void> | void): Promise<void> {
    queued++;
    queue = queue.then(work).catch(failed).finally(() => { queued--; });
    return queue;
  }

  function failed(error: unknown) {
    unsaved = true;
    process.stderr.write(`ghostly: storage write failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  /**
   * `lazy`: a relaxed transaction's entry. A sync blocks the whole process for milliseconds, and what such a
   * transaction wrote can be made again (the event set's note of a message it already reported): written, it outlives
   * the process; a power cut may take its last second.
   */
  function writeEntry(entry: Buffer, lazy = false): boolean {
    if (!writing) return false;
    try {
      if (journalFd === null) {
        journalFd = openSync(journalPath, "a", 0o600);
        if (snapshotName !== undefined && fstatSync(journalFd).size === 0) writeAll(journalFd, framed(serialize([{ db: FOLLOWS, store: "", kind: "clear", snapshot: snapshotName }])));
      }
      marked = false;
      writeAll(journalFd, framed(entry));
    } catch (error) {
      // What this entry said is held but not on disk, and what is appended behind a cut entry is not read back.
      unsaved = true;
      throw error;
    }
    if (lazy) relaxed ??= setTimeout(() => { try { sync(); } catch (error) { failed(error); } }, RELAXED_SYNC_MS).unref();
    else sync();
    if (statSync(journalPath).size > COMPACT_BYTES) void enqueue(writeSnapshot);
    return true;
  }

  function sync() {
    if (relaxed) { clearTimeout(relaxed); relaxed = null; }
    if (journalFd !== null) fsyncSync(journalFd);
  }

  async function writeSnapshot() {
    const dirty = schemaDirty;
    schemaDirty = false;
    try { await snapshotToDisk(); } catch (error) {
      schemaDirty ||= dirty;
      throw error;
    }
  }

  /**
   * What is held, as a snapshot. `inline`: every value in it (format 1, `exportSnapshot`); otherwise the stores kept on
   * disk say only that they are (format 3).
   */
  async function capture(journalName: string | undefined, inline: boolean): Promise<Snapshot> {
    const snapshot: Snapshot = { format: 1, ...(journalName !== undefined && { journal: journalName }), databases: [] };
    for (const db of raw._databases.values()) {
      if (db.name === PROBE) continue;
      const stores: SnapshotStore[] = [];
      for (const store of db.rawObjectStores.values()) {
        if (store.deleted) continue;
        const live = [...store.rawIndexes.values()].filter((index) => !index.deleted);
        const meta = {
          name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, keyGenerator: store.keyGenerator?.num ?? null,
          indexes: live.map(({ name, keyPath, multiEntry, unique }) => ({ name, keyPath, multiEntry, unique })),
        };
        if (!inline && disk(store)) {
          if (!onTrees(store)) toDisk(store);
          stores.push({ ...meta, records: [], onDisk: true });
          snapshot.format = 3;
          continue;
        }
        const records: [Key, unknown][] = [];
        for (const record of store.records.values()) records.push([record.key, await blobsToDisk(record.value)]);
        stores.push({ ...meta, records });
      }
      snapshot.databases.push({ name: db.name, version: db.version, stores });
    }
    return snapshot;
  }

  async function snapshotToDisk() {
    const name = randomBytes(8).toString("hex");
    const snapshot = await capture(name, false);
    if (trees) {
      // Every finished transaction goes to the trees, and to the disk, before the snapshot takes the journal's place:
      // also one whose entry waits behind this snapshot in the queue (the snapshot may hold what it did elsewhere). Its
      // entry, written after, is then one SQLite holds, which a replay skips.
      trees.apply(seq);
      trees.sync();
    }
    const temporary = snapshotPath + ".tmp";
    const fd = openSync(temporary, "w", 0o600);
    try { writeAll(fd, serialize(snapshot)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, snapshotPath);
    // Trees of stores and indexes gone from the schema: once no snapshot on disk names them.
    try { trees?.sweep(liveTrees()); } catch (error) { process.stderr.write(`ghostly: storage: old trees not removed: ${error instanceof Error ? error.message : String(error)}\n`); }
    snapshotName = name;
    unsaved = false;
    // The snapshot holds what the journal's entries said, the relaxed ones too.
    if (relaxed) { clearTimeout(relaxed); relaxed = null; }
    if (journalFd !== null) { closeSync(journalFd); journalFd = null; }
    rmSync(journalPath, { force: true });
    marked = true;
  }

  /** What `close` leaves: a short journal with the mark at its end, synced (its relaxed entries too), or a fresh snapshot. */
  async function leave() {
    if (schemaDirty || unsaved || journalBytes() > KEEP_BYTES) return writeSnapshot();
    if (marked) return;
    writeEntry(serialize([{ db: CLOSED, store: "", kind: "clear" }] satisfies Op[]));
    marked = true;
  }

  function journalBytes() {
    return existsSync(journalPath) ? statSync(journalPath).size : 0;
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
      quiet = busy() ? 0 : quiet + 1;
    }
  }

  /** Whether a transaction is running or waiting to. */
  function busy() {
    return [...raw._databases.values()].some((db) => db.transactions.some((transaction) => (transaction as RawTransaction)._state !== "finished"));
  }

  const installed = globalThis as unknown as Record<string, unknown>;
  installed.indexedDB = factory;
  installed.IDBKeyRange = IDBKeyRange;

  return {
    factory,
    recovered: !replayed.closed,
    flush: () => queue,
    async compact() {
      // After the transactions running now: the fold is whole.
      await settled();
      // The caller reads the snapshot next (a backup): a fold that failed is its failure, not a line on stderr.
      let thrown: { error: unknown } | null = null;
      await enqueue(() => writeSnapshot().catch((error: unknown) => { thrown = { error }; throw error; }));
      if (thrown) throw (thrown as { error: unknown }).error;
    },
    async close() {
      // Once: what comes after (a second close) finds the rows closed, and nothing left to write.
      if (!writing) return;
      await settled();
      await enqueue(leave);
      writing = false;
      if (journalFd !== null) { closeSync(journalFd); journalFd = null; }
      trees?.db.close();
    },
    journalBytes,
    async exportSnapshot(path: string) {
      await settled();
      const snapshot = await capture(undefined, true);
      const fd = openSync(path, "w", 0o600);
      try { writeAll(fd, serialize(snapshot)); fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}

/** Writes every byte: one write may take only a part (a disk nearly full). */
function writeAll(fd: number, bytes: Buffer) {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
}

/** A journal entry as it is on disk: its length, then its bytes. */
function framed(entry: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(entry.length);
  return Buffer.concat([header, entry]);
}

/** The snapshot a journal says it follows, in its first entry; none in an older version's journal, or an empty one. */
function follows(journal: Buffer): string | undefined {
  if (journal.length < 4 || 4 + journal.readUInt32BE(0) > journal.length) return undefined;
  try {
    const [op] = deserialize(journal.subarray(4, 4 + journal.readUInt32BE(0))) as (Op & { snapshot?: string })[];
    return op?.db === FOLLOWS ? op.snapshot : undefined;
  } catch { return undefined; }
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
    constraintError: Error,
  };
  // The error a tree throws for a put with no overwrite on a key it has: fake-indexeddb's own (not exported).
  const probe = new classes.RecordStore(true);
  probe.put({ key: 1, value: 1 });
  try { probe.put({ key: 1, value: 2 }, true); } catch (error) { classes.constraintError = (error as Error).constructor as new () => Error; }
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
    return dropEntries(index, gone.records, cmp);
  };
}

/** The classes whose reads of a store kept on disk hand out what rows.db gave: shared by every store opened. */
const uncopied = new WeakSet<object>();

/**
 * fake-indexeddb copies every value a read hands out (`structuredClone`), as it must for its tree, which keeps the
 * values. A store kept on disk read its values from rows.db just now (v8 made them), and copying them again made a
 * whole-chat read 1.6 times the cost of one in memory. Its `get` and `getAll`, and an index's (which read through the
 * store's `getValue`), hand those out as they are (`handOut`).
 */
function readWithoutCopy(classes: RawClasses) {
  const storeProto = classes.ObjectStore.prototype as RawStore;
  if (uncopied.has(storeProto)) return;
  uncopied.add(storeProto);
  const { getValue, getAllValues } = storeProto;
  storeProto.getValue = function (this: RawStore, key) {
    if (!(this.records.records instanceof SqlTree)) return getValue.call(this, key);
    const record = this.records.get(key);
    return record === undefined ? undefined : handOut(record.value);
  };
  storeProto.getAllValues = function (this: RawStore, range, count, direction) {
    if (!(this.records.records instanceof SqlTree)) return getAllValues.call(this, range, count, direction);
    const values: unknown[] = [], most = count || Infinity;
    for (const record of this.records.values(range, direction)) {
      values.push(handOut(record.value));
      if (values.length >= most) break;
    }
    return values;
  };
}

/** Drops from an index the entries of records that left its store, and gives back the ones it dropped. */
function dropEntries(index: RawIndex, records: RawRecord[], cmp: (a: Key, b: Key) => number): RawRecord[] {
  const dropped: RawRecord[] = [];
  for (const entry of indexEntries(index, records, cmp)) {
    // A unique index finds an entry by its key alone: it may be another record's (a put the index refused).
    if (index.records.keysAreUnique) {
      const held = index.records.get(entry.key);
      if (!held || cmp(held.value, entry.value) !== 0) continue;
    }
    index.records.records.delete(entry);
    dropped.push(entry);
  }
  return dropped;
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
interface RestoreDisk {
  trees: TreeFile | null; rows: RowFile | null; made: ReturnType<typeof rowRecords> | null; rowsFound: boolean; attach: (store: RawStore) => void;
  /** The stores kept in rows.db: one a snapshot of format 1 has inline is written there at once, never into memory. */
  onDisk: (db: string, store: string) => boolean;
}

/** Whether it wrote a store of format 1 into rows.db (the snapshot is to be written again, of format 3). */
function restore(classes: RawClasses, databases: Map<string, RawDatabase>, snapshot: Snapshot, cmp: (a: Key, b: Key) => number, disk: RestoreDisk): boolean {
  if (snapshot?.format !== 1 && snapshot?.format !== 2 && snapshot?.format !== 3) throw new Error("This profile was last used by a newer version of ghostly (its store has a format this version does not read). Update ghostly to open it.");
  if (snapshot.format !== 1 && !disk.trees) throw new Error(`This profile keeps its messages in rows.db, which needs Node 22.13 or newer (this is ${process.version}). Update Node to open it.`);
  // Gone, or without what the snapshot names (made empty by an open that failed): the same, and never read as no messages.
  const missing = new Error("This profile's store is missing rows.db (beside snapshot.bin): its messages cannot be read. Restore the profile from a backup.");
  const named = snapshot.format === 2 && snapshot.databases.some((db) => db.stores.some((store) => store.rows?.ids.some((id) => id >= 0)));
  if (snapshot.format === 2 && (!disk.rowsFound || !disk.rows || (named && disk.rows.count() === 0))) throw missing;
  const kept = (db: string, store: SnapshotStore) => disk.trees!.has(db, store.name) && store.indexes.every((index) => disk.trees!.has(db, store.name, index.name));
  if (snapshot.format === 3 && (!disk.rowsFound || snapshot.databases.some((db) => db.stores.some((store) => store.onDisk && !kept(db.name, store))))) throw missing;
  const intern = interner();
  let written = false;
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
      if (s.onDisk) { disk.attach(store); continue; }
      if (s.rows) {
        const kept = s.rows;
        const records: RawRecord[] = kept.keys.map((key, at) => (kept.ids[at] >= 0 ? disk.made!.make(intern(key), kept.ids[at]) : { key: intern(key), value: undefined }));
        for (const [at, value] of kept.inline) records[at] = { key: records[at].key, value: blobsFromDisk(value) };
        fill(store.records, records);
        for (const index of store.rawIndexes.values()) {
          const entries = kept.indexes[index.name];
          fill(index.records, entries ? entries.map(([key, at]): RawRecord => ({ key: intern(key), value: records[at].key })) : indexEntries(index, records, cmp));
        }
        continue;
      }
      const ordered = s.records.every(([key], at) => at === 0 || cmp(s.records[at - 1][0], key) < 0);
      if (ordered && disk.trees && disk.onDisk(saved.name, s.name)) {
        recordsToDisk(disk.trees, saved.name, store, s.records, cmp);
        s.records = [];
        disk.attach(store);
        written = true;
        continue;
      }
      const records = s.records.map(([key, value]): RawRecord => ({ key, value: blobsFromDisk(value) }));
      if (!ordered) {
        for (const record of records) store.storeRecord(record, false);
        continue;
      }
      fill(store.records, records);
      for (const index of store.rawIndexes.values()) fill(index.records, indexEntries(index, records, cmp));
    }
    databases.set(saved.name, db);
  }
  return written;
}

/** How many of a snapshot's records go to rows.db at a time, each with its index entries. */
const MOVE_BATCH = 2048;

/**
 * A store of a snapshot of format 1 that is kept on disk, written into rows.db from the snapshot's records (in key
 * order), a batch at a time with its index entries, in one SQLite transaction: building fake-indexeddb's trees first and
 * copying them out held every message in those trees beside the snapshot at the update's first start (1.1 GB at
 * 175,000, where the released start took 720 MB). Each batch's values are let go of in the snapshot once written.
 */
function recordsToDisk(trees: TreeFile, db: string, store: RawStore, saved: [Key, unknown][], cmp: (a: Key, b: Key) => number) {
  const indexes = [...store.rawIndexes.values()];
  const id = trees.treeId(db, store.name), ids = indexes.map((index) => trees.treeId(db, store.name, index.name));
  trees.db.exec("BEGIN");
  try {
    for (const tree of [id, ...ids]) trees.clearRows(tree);
    for (let from = 0; from < saved.length; from += MOVE_BATCH) {
      const batch = saved.slice(from, from + MOVE_BATCH).map(([key, value]): RawRecord => ({ key, value: blobsFromDisk(value) }));
      saved.fill(undefined as never, from, from + MOVE_BATCH);
      for (const record of batch) trees.row(id, record, false, true);
      indexes.forEach((index, at) => { for (const entry of indexEntries(index, batch, cmp)) trees.row(ids[at]!, entry, true, index.records.keysAreUnique); });
    }
    trees.db.exec("COMMIT");
  } catch (error) { trees.db.exec("ROLLBACK"); throw error; }
}

/**
 * One string for every copy of a chat's id among the keys (a message's key and its index entries each name its chat):
 * a snapshot read back gives each its own.
 */
function interner(): (key: Key) => Key {
  const pool = new Map<string, string>();
  const one = (text: string) => { const held = pool.get(text); if (held !== undefined) return held; pool.set(text, text); return text; };
  return (key) => {
    if (typeof key === "string") return key.length <= 64 ? one(key) : key;
    if (Array.isArray(key) && typeof key[0] === "string" && key[0].length <= 64) key[0] = one(key[0]);
    return key;
  };
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
 * What a journal's replay changed in a store: its indexes, set aside, the records that left it (the ones the indexes
 * know; `null` once it was cleared: all of them) and the records that came and stayed.
 */
interface Touched { indexes: Map<string, RawIndex>; was: Set<RawRecord> | null; now: Set<RawRecord> }

/** Where the journal's whole entries end, whether the last thing in it is a close mark, and its last entry's number. */
interface Replayed { end: number; closed: boolean; seq: number }

/** The trees' part of a replay: entries up to `applied` are in SQLite already, and a store on trees keeps its indexes. */
interface ReplayTrees { applied: number; onTrees: (store: RawStore) => boolean }

/**
 * Replays whole entries; a torn last entry (the process died mid-write) was never acknowledged and is dropped.
 *
 * A store's indexes are set aside while its ops replay and brought in step once at the end: fake-indexeddb drops an
 * overwritten or deleted record from an index by walking every record of it, so a crash after a busy chat took
 * tens of seconds to minutes to start, one write at a time against the whole profile. Only the rows the journal
 * touched change in an index (what each was before goes, what it is now comes in): a journal of one message costs one
 * message, not the profile's history once per index. A store the journal cleared has its indexes built again whole.
 */
function replay(databases: Map<string, RawDatabase>, journal: Buffer, cmp: (a: Key, b: Key) => number, trees: ReplayTrees): Replayed {
  const touched = new Map<RawStore, Touched>();
  try { return replayEntries(databases, journal, touched, trees); } finally {
    for (const [store, { indexes, was, now }] of touched) {
      const records: Partial<RawRecordStore> = store.records;
      delete records.put;
      delete records.delete;
      store.rawIndexes = indexes;
      for (const index of indexes.values()) {
        if (!was) index.records.clear();
        if (!index.initialized) continue;
        if (was) dropEntries(index, [...was], cmp);
        for (const record of was ? now : store.records.values()) if (!absent(index.keyPath, record.value)) index.storeRecord(record);
      }
    }
  }
}

function replayEntries(databases: Map<string, RawDatabase>, journal: Buffer, touched: Map<RawStore, Touched>, trees: ReplayTrees): Replayed {
  let offset = 0, closed = false, last = 0;
  while (offset + 4 <= journal.length) {
    const length = journal.readUInt32BE(offset);
    if (offset + 4 + length > journal.length) break;
    let ops: Op[];
    try { ops = deserialize(journal.subarray(offset + 4, offset + 4 + length)) as Op[]; } catch { break; }
    offset += 4 + length;
    closed = ops.some((op) => op.db === CLOSED);
    const marker = ops.find((op) => op.db === SEQ);
    const entry = marker?.kind === "clear" ? marker.seq : undefined;
    if (entry !== undefined) last = Math.max(last, entry);
    for (const op of ops) {
      const store = databases.get(op.db)?.rawObjectStores.get(op.store);
      if (!store) continue;
      const onTrees = trees.onTrees(store);
      // In SQLite already: the trees took this entry before the process stopped.
      if (onTrees && entry !== undefined && entry <= trees.applied) continue;
      // A store on trees keeps its indexes in step as it goes: each write costs a few rows, never a walk.
      let change = onTrees ? undefined : touched.get(store);
      if (!onTrees && !change) touched.set(store, (change = watch(store)));
      if (op.kind === "put") store.storeRecord({ key: op.key, value: blobsFromDisk(op.value) }, false);
      else if (op.kind === "delete") store.deleteRecord(keyFromDisk(op.key));
      else {
        if (change) change.was = null;
        store.clear();
      }
    }
  }
  return { end: offset, closed: closed && offset === journal.length, seq: last };
}

/**
 * Sets a store's indexes aside and notes, as its records are written over and removed, which ones left and which
 * ones came: the record store hands back what a put replaced and what a delete removed, so a row costs no lookup.
 * A record that came and left again was never in an index.
 */
function watch(store: RawStore): Touched {
  const change: Touched = { indexes: store.rawIndexes, was: store.rawIndexes.size ? new Set() : null, now: new Set() };
  store.rawIndexes = new Map();
  if (!change.was) return change;
  const { put, delete: remove } = store.records;
  const left = (record: RawRecord) => { if (!change.now.delete(record)) change.was?.add(record); };
  store.records.put = (next, keep) => {
    const replaced = put.call(store.records, next, keep);
    if (replaced) left(replaced);
    change.now.add(next);
    return replaced;
  };
  store.records.delete = (key) => {
    const removed = remove.call(store.records, key);
    removed.forEach(left);
    return removed;
  };
  return change;
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
