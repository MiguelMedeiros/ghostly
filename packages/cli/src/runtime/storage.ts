import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange, IDBTransaction } from "fake-indexeddb";
import { loadSqlite, openRowFile, ROW, rowRecords, type RowFile, type RowRecord } from "./rows";

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
 * - the engine's messages keep their values in `rows.db` (./rows.ts), not in memory: their records hold a key and a row
 *   id, the snapshot (format 2) their keys, row ids and index entries. A committed message's value goes to its row
 *   right after the journal has it; a row goes once a snapshot that no longer names it is on disk. A profile's snapshot
 *   of format 1 (values inline) is written as format 2 at its first open; a Node without `node:sqlite` keeps format 1.
 *
 * Only one process may hold a profile's store: the caller takes the profile lock first (see `profiles.ts`).
 * fake-indexeddb is pinned: this reaches into its raw classes, and `storage.test.ts` checks them.
 */

type Key = unknown;
/**
 * What a transaction did to a store kept on disk, besides what the journal gets: the store, the record a put left in
 * it, and the rows of the records it wrote over or removed (`dead`).
 */
interface OnDisk { target?: RawStore; record?: RawRecord; dead?: number[] }
type Op = (
  | { db: string; store: string; kind: "put"; key: Key; value: unknown }
  | { db: string; store: string; kind: "delete"; key: Key }
  | { db: string; store: string; kind: "clear" }
) & OnDisk;

interface RawRecord { key: Key; value: unknown }
interface RawIndex {
  name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean; initialized: boolean; deleted: boolean;
  records: RawRecordStore; storeRecord(record: RawRecord): void;
}
interface RawNode { record: RawRecord; left: RawNode | undefined; right: RawNode | undefined; parent: RawNode | undefined; deleted: boolean; red: boolean }
interface RawRecordStore {
  values(range?: unknown): Iterable<RawRecord>; clear(): unknown;
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
/**
 * A store kept on disk (format 2): its records' keys in key order, each one's row (-1 for one kept inline: a value with
 * a Blob), the inline values by position, and each index's entries in its own order, as [index key, record position].
 */
interface SnapshotRows { keys: Key[]; ids: number[]; inline: [number, unknown][]; indexes: Record<string, [Key, number][]> }
interface SnapshotStore { name: string; keyPath: string | string[] | null; autoIncrement: boolean; keyGenerator: number | null; indexes: SnapshotIndex[]; records: [Key, unknown][]; rows?: SnapshotRows }
/**
 * `journal`: the name a journal that follows this snapshot begins with (absent in one an older version wrote).
 * `format`: 1, every value inline; 2, the stores kept on disk have theirs in `rows.db`. An older ghostly refuses 2.
 */
interface Snapshot { format: 1 | 2; journal?: string; databases: { name: string; version: number; stores: SnapshotStore[] }[] }

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
  /** The stores whose values are kept in `rows.db`: by default the engine's messages. */
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
  const order = keyOrder((a, b) => factory.cmp(a, b));

  // Found before it is opened: opening makes it, and a snapshot that names rows needs the file it named.
  const rowsPath = join(dir, ROWS);
  const rowsFound = existsSync(rowsPath);
  const sqlite = await loadSqlite();
  const rows: RowFile | null = sqlite ? openRowFile(sqlite, rowsPath) : null;
  const made = rows ? rowRecords(rows) : null;
  const onDisk = options.rowsOnDisk ?? ((_db: string, store: string) => store === "messages");
  // This store's own databases only: the hooks are on fake-indexeddb's shared classes, and another store opened in the
  // process (a test's) must not move this one's records into its rows.db.
  const disk = (store: RawStore) => rows !== null && raw._databases.get(store.rawDatabase.name) === store.rawDatabase && onDisk(store.rawDatabase.name, store.name);
  /** Rows of records written over or removed by committed transactions, dropped once a snapshot without them is on disk. */
  const dead: number[] = [];

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
  try {
    if (saved) restore(classes, raw._databases, saved, order, { rows, made, rowsFound, onDisk });
  } catch (error) {
    rows?.close();
    // Made by this open: a second one must refuse as this one did, not find an empty file and read nothing.
    if (!rowsFound) for (const file of [rowsPath, `${rowsPath}-wal`, `${rowsPath}-shm`]) rmSync(file, { force: true });
    throw error;
  }
  // A snapshot of format 1 whose messages are to be kept on disk: written as format 2 at this open.
  const moving = !!rows && saved?.format === 1 && saved.databases.some((db) => db.stores.some((store) => store.records.length > 0 && onDisk(db.name, store.name)));
  /** The name of the snapshot on disk, which its journal begins with. */
  let snapshotName = saved?.journal;
  let journal = journalFound ? readFileSync(journalPath) : null;
  const named = journal ? follows(journal) : undefined;
  // A journal that names another snapshot is in this one already: replayed, it would put back rows as they were before
  // what came between (an upgrade that rewrote them). The process that left it died while it folded.
  const folded = named !== undefined && snapshotName !== undefined && named !== snapshotName;
  if (folded) { rmSync(journalPath, { force: true }); journal = null; }
  const replayed = journal ? replay(raw._databases, journal, order) : { end: 0, closed: !folded };
  restoring = false;
  /** Whether the journal on disk says the store is closed: nothing was written since its mark, or there is none. */
  let marked = replayed.closed;
  // A journal cut short is never appended to: what came after the torn bytes could not be read back. Nor one that
  // does not name this snapshot (an older version's).
  const kept = !!journal && named !== undefined && named === snapshotName && replayed.end === journal.length && journal.length <= KEEP_BYTES;
  const rewrite = (journal && !kept) || !snapshotFound || moving;
  if (rewrite) await writeSnapshot();
  if (rows) {
    // Rows nothing names (a process that died between writing a row and the snapshot after it, a database deleted):
    // gone once they are many. The snapshot on disk names its rows still, when this open did not write it.
    const keep = new Set<number>();
    for (const db of raw._databases.values()) for (const store of db.rawObjectStores.values()) {
      if (disk(store)) for (const record of store.records.values()) { const id = (record as RowRecord)[ROW]; if (id !== undefined) keep.add(id); }
    }
    if (!rewrite) for (const db of saved?.databases ?? []) for (const store of db.stores) for (const id of store.rows?.ids ?? []) if (id >= 0) keep.add(id);
    if (rows.count() > keep.size * 1.1 + 1000) rows.sweep(keep);
  }

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
  // A store kept on disk: the records a write replaces or removes are found first, for their rows.
  const rowsOf = (records: Iterable<RawRecord | undefined>) => { const ids: number[] = []; for (const record of records) { const id = (record as RowRecord | undefined)?.[ROW]; if (id !== undefined) ids.push(id); } return ids; };
  storeProto.storeRecord = function (this: RawStore, record, noOverwrite, rollbackLog) {
    const kept = !!rollbackLog && !restoring && disk(this);
    const before = kept && record.key !== undefined ? this.records.get(record.key) : undefined;
    const key = storeRecord.call(this, record, noOverwrite, rollbackLog);
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "put", key, value: record.value, ...(kept && { target: this, record, dead: rowsOf([before]) }) });
    return key;
  };
  storeProto.deleteRecord = function (this: RawStore, key, rollbackLog) {
    const kept = !!rollbackLog && !restoring && disk(this);
    const gone = kept ? rowsOf(key instanceof IDBKeyRange ? this.records.values(key) : [this.records.get(key)]) : [];
    deleteRecord.call(this, key, rollbackLog);
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "delete", key: keyToDisk(key), ...(kept && { dead: gone }) });
  };
  storeProto.clear = function (this: RawStore, rollbackLog) {
    const kept = !!rollbackLog && !restoring && disk(this);
    const gone = kept ? rowsOf(this.records.values()) : [];
    clear.call(this, rollbackLog);
    if (rollbackLog && !restoring) opsOf(rollbackLog).push({ db: this.rawDatabase.name, store: this.name, kind: "clear", ...(kept && { dead: gone }) });
  };

  // The transaction's `complete` is where it becomes durable: written before the engine hears of it.
  const txProto = IDBTransaction.prototype as unknown as { dispatchEvent(event: Event): boolean };
  const dispatch = txProto.dispatchEvent;
  txProto.dispatchEvent = function (this: RawTransaction, event: Event) {
    if (event.type === "complete" && writing) {
      if (this.mode === "versionchange") schemaDirty = true;
      else {
        const ops = pending.get(this._rollbackLog);
        if (ops?.length) { append(ops, this.durability === "relaxed"); toRows(ops); }
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

  function append(all: Op[], lazy: boolean) {
    const ops = all.map(journalOp);
    if (queued === 0 && !ops.some((op) => op.kind === "put" && hasBlob(op.value))) {
      writeEntry(serialize(ops), lazy);
      return;
    }
    void enqueue(async () => writeEntry(serialize(await Promise.all(ops.map(async (op) => (op.kind === "put" ? { ...op, value: await blobsToDisk(op.value) } : op)))), lazy));
  }

  /**
   * After the journal has a committed transaction: each message it left in a store kept on disk gets its row, and its
   * value is read from there; the rows of what it wrote over or removed are dead. A record the same transaction wrote
   * over again, or a value with a Blob, stays in memory until a snapshot. A row that cannot be written leaves the value
   * in memory: the journal has it, and the next snapshot tries again.
   */
  function toRows(ops: Op[]) {
    if (!rows || !made || !writing) return;
    for (const op of ops) if (op.dead?.length) dead.push(...op.dead);
    // Rows first, records after: a batch that fails is rolled back whole, and no record may name a row it took back.
    const moved: [RawRecord, number][] = [];
    try {
      rows.batch(() => {
        for (const op of ops) {
          if (op.kind !== "put" || !op.record || !op.target) continue;
          if (op.target.records.get(op.key) !== op.record || (op.record as RowRecord)[ROW] !== undefined || hasBlob(op.value)) continue;
          moved.push([op.record, rows.add(op.value)]);
        }
      });
    } catch (error) { failed(error); return; }
    for (const [record, id] of moved) made.move(record as RowRecord, id);
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
  function writeEntry(entry: Buffer, lazy = false) {
    if (!writing) return;
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
   * disk give their keys, rows and index entries (format 2), and a record with no row yet gets one here.
   */
  async function capture(journalName: string | undefined, inline: boolean): Promise<Snapshot> {
    const snapshot: Snapshot = { format: 1, ...(journalName !== undefined && { journal: journalName }), databases: [] };
    // The stores kept on disk first, in one pass with no turn in between: what the rows sweep keeps is what this holds.
    const onRows = new Map<RawStore, SnapshotRows>();
    if (!inline) for (const db of raw._databases.values()) for (const store of db.rawObjectStores.values()) if (!store.deleted && db.name !== PROBE && disk(store)) onRows.set(store, rowsOfStore(store));
    if (onRows.size) snapshot.format = 2;
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
        const kept = onRows.get(store);
        if (kept) {
          for (const item of kept.inline) item[1] = await blobsToDisk(item[1]);
          stores.push({ ...meta, records: [], rows: kept });
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

  /** A store kept on disk, as format 2 has it (its Blob values still to be made bytes): taken with no turn in the middle. */
  function rowsOfStore(store: RawStore): SnapshotRows {
    const indexes = [...store.rawIndexes.values()].filter((index) => !index.deleted);
    const keys: Key[] = [], ids: number[] = [], inline: [number, unknown][] = [], at = new Map<unknown, number>();
    // Rows first, records after (as `toRows`): a batch that fails takes back every row it wrote, and the snapshot with it.
    const records = [...store.records.values()], moved: [RawRecord, number][] = [];
    rows!.batch(() => {
      for (const record of records) {
        let id = (record as RowRecord)[ROW];
        if (id === undefined && !hasBlob(record.value)) moved.push([record, (id = rows!.add(record.value))]);
        at.set(record.key, keys.length);
        if (id === undefined) inline.push([keys.length, record.value]);
        keys.push(record.key);
        ids.push(id ?? -1);
      }
    });
    for (const [record, id] of moved) made!.move(record as RowRecord, id);
    const entries: Record<string, [Key, number][]> = {};
    for (const index of indexes) {
      // An entry holds its record's key itself (`value: record.key`): found by identity, else by order.
      entries[index.name] = [...index.records.values()].map((entry): [Key, number] => [entry.key, at.get(entry.value) ?? position(keys, entry.value, order)]);
    }
    return { keys, ids, inline, indexes: entries };
  }

  async function snapshotToDisk() {
    const name = randomBytes(8).toString("hex");
    // Rows dead before this snapshot is taken are in neither it nor what is held: they go once it is on disk. Taken
    // while no transaction runs (`compact`, a close that folds, a quiet moment), the snapshot names every row anything
    // can still read (an open transaction's rollback puts back records it replaced): every older row it does not name
    // goes too.
    const quiet = !!rows && !busy();
    const upTo = quiet ? rows!.last() : 0;
    const dropping = dead.splice(0);
    let snapshot: Snapshot;
    try {
      snapshot = await capture(name, false);
      // The rows it names reach the disk before it takes the place of the snapshot (and journal) that had their values.
      rows?.sync();
      const temporary = snapshotPath + ".tmp";
      const fd = openSync(temporary, "w", 0o600);
      try { writeAll(fd, serialize(snapshot)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, snapshotPath);
    } catch (error) {
      dead.unshift(...dropping);
      throw error;
    }
    try {
      rows?.drop(dropping);
      if (quiet) {
        const keep = new Set<number>();
        for (const db of snapshot.databases) for (const store of db.stores) for (const id of store.rows?.ids ?? []) if (id >= 0) keep.add(id);
        rows!.sweep(keep, upTo);
      }
    } catch (error) { process.stderr.write(`ghostly: storage: old rows not removed: ${error instanceof Error ? error.message : String(error)}\n`); }
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
      // After the transactions running now: the fold is whole, and rows.db is swept with it.
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
      rows?.close();
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

/** An op as the journal keeps it: what the store kept on disk needs in memory stays out. */
function journalOp(op: Op): Op {
  if (op.kind === "put") return { db: op.db, store: op.store, kind: op.kind, key: op.key, value: op.value };
  if (op.kind === "delete") return { db: op.db, store: op.store, kind: op.kind, key: op.key };
  return { db: op.db, store: op.store, kind: op.kind };
}

/** Where a key is among keys in order (an index entry whose record key is not the record's own object). */
export function position(keys: Key[], key: Key, cmp: (a: Key, b: Key) => number): number {
  for (let low = 0, high = keys.length - 1; low <= high;) {
    const middle = (low + high) >>> 1, side = cmp(keys[middle], key);
    if (side === 0) return middle;
    if (side < 0) low = middle + 1; else high = middle - 1;
  }
  throw new Error("An index names a record its store does not hold");
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
    return dropEntries(index, gone.records, cmp);
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
interface RestoreRows { rows: RowFile | null; made: ReturnType<typeof rowRecords> | null; rowsFound: boolean; onDisk: (db: string, store: string) => boolean }

function restore(classes: RawClasses, databases: Map<string, RawDatabase>, snapshot: Snapshot, cmp: (a: Key, b: Key) => number, disk: RestoreRows) {
  if (snapshot?.format !== 1 && snapshot?.format !== 2) throw new Error("This profile was last used by a newer version of ghostly (its store has a format this version does not read). Update ghostly to open it.");
  if (snapshot.format === 2 && !disk.rows) throw new Error(`This profile keeps its messages in rows.db, which needs Node 22.13 or newer (this is ${process.version}). Update Node to open it.`);
  // Gone, or empty while the snapshot names rows (made by an open that failed): the same, and never read as no messages.
  const named = snapshot.format === 2 && snapshot.databases.some((db) => db.stores.some((store) => store.rows?.ids.some((id) => id >= 0)));
  if (snapshot.format === 2 && (!disk.rowsFound || (named && disk.rows!.count() === 0))) throw new Error("This profile's store is missing rows.db (beside snapshot.bin): its messages cannot be read. Restore the profile from a backup.");
  const intern = interner();
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
      const records = s.records.map(([key, value]): RawRecord => ({ key: disk.rows && disk.onDisk(saved.name, s.name) ? intern(key) : key, value: blobsFromDisk(value) }));
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

/** Where the journal's whole entries end, and whether the last thing in it is a close mark. */
interface Replayed { end: number; closed: boolean }

/**
 * Replays whole entries; a torn last entry (the process died mid-write) was never acknowledged and is dropped.
 *
 * A store's indexes are set aside while its ops replay and brought in step once at the end: fake-indexeddb drops an
 * overwritten or deleted record from an index by walking every record of it, so a crash after a busy chat took
 * tens of seconds to minutes to start, one write at a time against the whole profile. Only the rows the journal
 * touched change in an index (what each was before goes, what it is now comes in): a journal of one message costs one
 * message, not the profile's history once per index. A store the journal cleared has its indexes built again whole.
 */
function replay(databases: Map<string, RawDatabase>, journal: Buffer, cmp: (a: Key, b: Key) => number): Replayed {
  const touched = new Map<RawStore, Touched>();
  try { return replayEntries(databases, journal, touched); } finally {
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

function replayEntries(databases: Map<string, RawDatabase>, journal: Buffer, touched: Map<RawStore, Touched>): Replayed {
  let offset = 0, closed = false;
  while (offset + 4 <= journal.length) {
    const length = journal.readUInt32BE(offset);
    if (offset + 4 + length > journal.length) break;
    let ops: Op[];
    try { ops = deserialize(journal.subarray(offset + 4, offset + 4 + length)) as Op[]; } catch { break; }
    offset += 4 + length;
    closed = ops.some((op) => op.db === CLOSED);
    for (const op of ops) {
      const store = databases.get(op.db)?.rawObjectStores.get(op.store);
      if (!store) continue;
      let change = touched.get(store);
      if (!change) touched.set(store, (change = watch(store)));
      if (op.kind === "put") store.storeRecord({ key: op.key, value: blobsFromDisk(op.value) }, false);
      else if (op.kind === "delete") store.deleteRecord(keyFromDisk(op.key));
      else {
        change.was = null;
        store.clear();
      }
    }
  }
  return { end: offset, closed: closed && offset === journal.length };
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
