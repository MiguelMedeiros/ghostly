import { deserialize } from "node:v8";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * `node:sqlite`, and what is left of the store's format 2 (values in a `rows` table of rows.db, keys in the snapshot):
 * read once, at the open that moves such a profile into rows.db's trees (./sqlTree.ts).
 */
export interface RowFile {
  /** A row's value. Throws for a row that is not there: a value read as missing would be a message read as nothing. */
  get(id: number): unknown;
  /** How many rows there are. */
  count(): number;
  close(): void;
}

/** The warning `node:sqlite` gives as it loads (experimental on Node 22 and 23): said once for every command, it is noise. */
const SQLITE_WARNING = /^SQLite is an experimental feature/;

let loaded: Promise<typeof import("node:sqlite") | null> | undefined;

/**
 * `node:sqlite`, or null where Node has none (before 22.13 it needs a flag): the store then keeps every value in
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

/** Format 2's rows, read. */
export function openRowFile(sqlite: typeof import("node:sqlite"), path: string): RowFile {
  const db: DatabaseSync = new sqlite.DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
  const select: StatementSync = db.prepare("SELECT value FROM rows WHERE id = ?");
  return {
    get(id) {
      const row = select.get(id) as { value: Uint8Array } | undefined;
      if (!row) throw new Error(`The store's rows.db has no row ${id}: the profile's store is damaged`);
      return deserialize(row.value);
    },
    count() {
      return Number((db.prepare("SELECT count(*) AS n FROM rows").get() as { n: number }).n);
    },
    close() {
      db.close();
    },
  };
}

/** Where a record of format 2 has its value. */
const ROW = Symbol("ghostly.row");
type RowRecord = { key: unknown; value: unknown; [ROW]?: number };

/** Records of a snapshot of format 2, whose value is read from `rows` (a getter shared by all of them). */
export function rowRecords(rows: RowFile) {
  const read = function (this: RowRecord) { return rows.get(this[ROW]!); };
  const proto = Object.defineProperty({}, "value", { get: read, enumerable: true, configurable: true });
  return {
    make(key: unknown, row: number): RowRecord {
      const record = Object.create(proto) as RowRecord;
      record.key = key;
      record[ROW] = row;
      return record;
    },
  };
}
