import { closeSync, openSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * The values of a store kept on disk (`rows.db` in the store's folder, SQLite through `node:sqlite`), by row id: the
 * store's records keep their keys and a row id in memory, and read their value from here when asked for it. A
 * daemon held every message of its history in memory, about 1.3 KB each, for as long as it ran.
 *
 * A row is written once and never changed: a record written over gets a new row, and the old one goes only once a
 * snapshot that no longer names it is on disk (`drop`). Until then an index can still read what the old record held,
 * and the snapshot before it still names it.
 */
export interface RowFile {
  /** A new row for a value (no Blob in it: `storage.ts` keeps those in the snapshot), and its id. */
  add(value: unknown): number;
  /** Runs `work` (its `add`s) as one SQLite transaction: thousands of rows at a snapshot cost one commit. */
  batch(work: () => void): void;
  /** A row's value. Throws for a row that is not there: a value read as missing would be a message read as nothing. */
  get(id: number): unknown;
  /** Removes rows nothing names any more. */
  drop(ids: readonly number[]): void;
  /** Rows up to `upTo` that are not in `keep` go: the old values of what was written over, what a process that died left. */
  sweep(keep: ReadonlySet<number>, upTo?: number): number;
  /** The newest row's id (0 with none). */
  last(): number;
  /** How many rows there are. */
  count(): number;
  /** Everything written so far is on disk (a checkpoint: synced before the snapshot that names the rows replaces the old one). */
  sync(): void;
  close(): void;
}

/** Values read lately, kept as read: a chat's page is read again as soon as the next message comes. */
const CACHED = 256;

/** The warning `node:sqlite` gives as it loads (experimental on Node 22 and 23): said once for every command, it is noise. */
const SQLITE_WARNING = /^SQLite is an experimental feature/;

let loaded: Promise<typeof import("node:sqlite") | null> | undefined;

/**
 * `node:sqlite`, or null where Node has none (before 22.13 it needs a flag): the store then keeps its values in
 * memory and in the snapshot, as before rows.db.
 */
export function loadSqlite(): Promise<typeof import("node:sqlite") | null> {
  loaded ??= (async () => {
    const emit = process.emitWarning;
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      if (SQLITE_WARNING.test(typeof warning === "string" ? warning : warning?.message ?? "")) return;
      return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
    try { return await import("node:sqlite"); } catch { return null; } finally { process.emitWarning = emit; }
  })();
  return loaded;
}

export function openRowFile(sqlite: typeof import("node:sqlite"), path: string): RowFile {
  // Owner-only, as the store's other files: SQLite makes its WAL and shared-memory files with the database's mode.
  closeSync(openSync(path, "a", 0o600));
  const db: DatabaseSync = new sqlite.DatabaseSync(path);
  // WAL with NORMAL: a commit is not synced on its own. The journal (`storage.ts`) is what makes a transaction durable;
  // the rows are synced (`sync`) before a snapshot that names them takes the journal's place.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
  const insert: StatementSync = db.prepare("INSERT INTO rows (value) VALUES (?)");
  const select: StatementSync = db.prepare("SELECT value FROM rows WHERE id = ?");
  const remove: StatementSync = db.prepare("DELETE FROM rows WHERE id = ?");
  const cache = new Map<number, unknown>();
  const inTransaction = (work: () => void) => {
    db.exec("BEGIN");
    try { work(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return {
    add(value) {
      return Number(insert.run(serialize(value)).lastInsertRowid);
    },
    batch(work) {
      if (db.isTransaction) { work(); return; }
      inTransaction(work);
    },
    get(id) {
      if (cache.has(id)) {
        const value = cache.get(id);
        cache.delete(id);
        cache.set(id, value);
        return value;
      }
      const row = select.get(id) as { value: Uint8Array } | undefined;
      if (!row) throw new Error(`The store's rows.db has no row ${id}: the profile's store is damaged`);
      const value = deserialize(row.value);
      cache.set(id, value);
      if (cache.size > CACHED) cache.delete(cache.keys().next().value!);
      return value;
    },
    drop(ids) {
      if (!ids.length) return;
      inTransaction(() => { for (const id of ids) { remove.run(id); cache.delete(id); } });
    },
    sweep(keep, upTo = Number.MAX_SAFE_INTEGER) {
      db.exec("CREATE TEMP TABLE IF NOT EXISTS keep (id INTEGER PRIMARY KEY); DELETE FROM keep");
      const add = db.prepare("INSERT INTO keep (id) VALUES (?)");
      let removed = 0;
      inTransaction(() => {
        for (const id of keep) add.run(id);
        removed = Number(db.prepare("DELETE FROM rows WHERE id <= ? AND id NOT IN (SELECT id FROM keep)").run(upTo).changes);
      });
      db.exec("DELETE FROM keep");
      cache.clear();
      return removed;
    },
    last() {
      return Number((db.prepare("SELECT coalesce(max(id), 0) AS id FROM rows").get() as { id: number }).id);
    },
    count() {
      return Number((db.prepare("SELECT count(*) AS n FROM rows").get() as { n: number }).n);
    },
    sync() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    close() {
      cache.clear();
      db.close();
    },
  };
}

/** Where a record kept on disk has its value. */
export const ROW = Symbol("ghostly.row");
export type RowRecord = { key: unknown; value: unknown; [ROW]?: number };

/**
 * Records whose value is read from `rows` (a getter shared by all of them): restored ones are made with it, and a
 * record written in memory gets it once its row is written (`toRow`).
 */
export function rowRecords(rows: RowFile) {
  const read = function (this: RowRecord) { return rows.get(this[ROW]!); };
  const proto = Object.defineProperty({}, "value", { get: read, enumerable: true, configurable: true });
  return {
    /** A record of a snapshot: its key, its row. */
    make(key: unknown, row: number): RowRecord {
      const record = Object.create(proto) as RowRecord;
      record.key = key;
      record[ROW] = row;
      return record;
    },
    /** A record in memory, its value now in row `row`: the value is read from there from now on. */
    move(record: RowRecord, row: number): void {
      Object.defineProperty(record, "value", { get: read, enumerable: true, configurable: true });
      record[ROW] = row;
    },
  };
}
