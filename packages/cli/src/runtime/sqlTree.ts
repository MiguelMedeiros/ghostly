import { closeSync, openSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { AFTER, keyBytes } from "./keyBytes";

/**
 * fake-indexeddb keeps an object store's records, and an index's entries, in a red-black tree in memory. A store kept
 * on disk has a `SqlTree` in its place instead, with the tree's methods (`get`, `put`, `delete`, `getRecords`,
 * `getAllRecords`, `size`): its records are rows of `entries` in rows.db, by their key's bytes in IndexedDB's order
 * (./keyBytes.ts), and nothing of them stays in memory. fake-indexeddb's own code (transactions, cursors, ranges,
 * unique indexes, rollbacks) runs on it unchanged.
 *
 * What a transaction writes stays in a layer in memory until the journal has the transaction (`storage.ts`): then the
 * layer goes to SQLite in one SQLite transaction (`TreeFile.apply`). A transaction that aborts drops its layer. Reads
 * see SQLite with the layers on it. fake-indexeddb never runs a transaction that writes a store beside another one
 * that reads or writes it (`Database.processTransactions`), so the layer of a store is one transaction's.
 */

interface Entry { key: unknown; value: unknown }
interface Range { lower?: unknown; upper?: unknown; lowerOpen: boolean; upperOpen: boolean; includes(key: unknown): boolean }

/**
 * A transaction's writes to one tree: an entry by its id, null for one removed; `cleared`: nothing under it counts. An
 * index's layer also finds its ids by their record key's bytes (`byValue`): a record written over drops its entries by it.
 */
interface Layer { owner: object | null; seq: number; cleared: boolean; puts: Map<string, Entry | null>; byValue: Map<string, Set<string>> }

const buffer = (bytes: string) => Buffer.from(bytes, "latin1");

/**
 * Values just read from rows.db, which nothing else holds: fake-indexeddb copies each value it hands out, and for these
 * the copy is a second one (v8 made the first), 7.6 s of a 30 s profile of sends in a chat of 15,000. A value that goes
 * into a layer leaves the set: from then on the store holds it.
 */
const fresh = new WeakSet<object>();

function thaw(bytes: Uint8Array): unknown {
  const value = deserialize(bytes);
  if (value && typeof value === "object") fresh.add(value);
  return value;
}

/** A value to hand out: one just read from rows.db as it is, once; any other a copy, as fake-indexeddb makes. */
export function handOut(value: unknown): unknown {
  return value && typeof value === "object" && fresh.delete(value) ? value : structuredClone(value);
}

/** rows.db's trees: the stores kept on disk and their indexes, each a tree id in `entries`. */
export class TreeFile {
  /** The transaction whose writes come now (its rollback log), set by `storage.ts` around each; null for one without. */
  owner: object | null = null;
  private readonly live = new Set<SqlTree>();
  private readonly get: StatementSync;
  private readonly count: StatementSync;
  private readonly put: StatementSync;
  private readonly remove: StatementSync;
  private readonly empty: StatementSync;
  /** `range`'s page reads by their SQL: a few shapes (direction, bounds), each prepared once. */
  private readonly pages = new Map<string, StatementSync>();

  constructor(readonly db: DatabaseSync, readonly constraintError: new () => Error) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trees (id INTEGER PRIMARY KEY, db TEXT NOT NULL, store TEXT NOT NULL, idx TEXT NOT NULL, UNIQUE (db, store, idx));
      CREATE TABLE IF NOT EXISTS entries (tree INTEGER NOT NULL, id BLOB NOT NULL, pv BLOB, key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY (tree, id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS entries_by_value ON entries (tree, pv) WHERE pv IS NOT NULL;
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value) WITHOUT ROWID;
    `);
    this.get = db.prepare("SELECT key, value FROM entries WHERE tree = ? AND id = ?");
    this.count = db.prepare("SELECT count(*) AS n FROM entries WHERE tree = ?");
    this.put = db.prepare("INSERT OR REPLACE INTO entries (tree, id, pv, key, value) VALUES (?, ?, ?, ?, ?)");
    this.remove = db.prepare("DELETE FROM entries WHERE tree = ? AND id = ?");
    this.empty = db.prepare("DELETE FROM entries WHERE tree = ?");
  }

  /** The tree of a store (`index` "") or of one of its indexes, made when it is new. */
  treeId(db: string, store: string, index = ""): number {
    const found = this.db.prepare("SELECT id FROM trees WHERE db = ? AND store = ? AND idx = ?").get(db, store, index) as { id: number } | undefined;
    if (found) return Number(found.id);
    return Number(this.db.prepare("INSERT INTO trees (db, store, idx) VALUES (?, ?, ?)").run(db, store, index).lastInsertRowid);
  }

  tree(id: number, keysAreUnique: boolean, index: boolean): SqlTree {
    const tree = new SqlTree(this, id, keysAreUnique, index);
    this.live.add(tree);
    return tree;
  }

  /** The last journal entry whose writes SQLite holds. */
  applied(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE name = 'applied'").get() as { value: number } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** A finished transaction's layers, numbered as its journal entry: they wait for `apply`. */
  complete(owner: object | null, seq: number): void {
    for (const tree of this.live) tree.complete(owner, seq);
  }

  /** An aborted transaction's layers go, and what it wrote with them. */
  abort(owner: object | null): void {
    for (const tree of this.live) tree.abort(owner);
  }

  /** The layers of the journal's entries up to `upTo` into SQLite, in one transaction that says so (`applied`). */
  apply(upTo: number): void {
    // An entry that wrote no tree (settings, the event set's notes) has nothing to take: no SQLite write for it.
    const due = [...this.live].filter((tree) => tree.due(upTo));
    if (!due.length) return;
    this.db.exec("BEGIN");
    try {
      // The number of the last entry that wrote here: a replay skips what wrote trees up to it.
      let top = 0;
      for (const tree of due) top = Math.max(top, tree.write(upTo));
      this.db.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('applied', max(?, coalesce((SELECT value FROM meta WHERE name = 'applied'), 0)))").run(top);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    // Only once SQLite has them: a write that failed leaves the layers where reads still find them, for the next try.
    for (const tree of due) tree.settle(upTo);
  }

  /** Whether a store (`index` "") or one of its indexes has its tree here (a snapshot of format 3 names ones that must). */
  has(db: string, store: string, index = ""): boolean {
    return this.db.prepare("SELECT 1 FROM trees WHERE db = ? AND store = ? AND idx = ?").get(db, store, index) !== undefined;
  }

  /** Everything SQLite holds is on disk: before a snapshot takes the place of the journal that had it. */
  sync(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** Trees whose store or index is gone from the schema (deleted, a database removed) go, with their entries. */
  sweep(keep: ReadonlySet<number>): void {
    const ids = (this.db.prepare("SELECT id FROM trees").all() as { id: number }[]).map((row) => Number(row.id)).filter((id) => !keep.has(id));
    if (!ids.length) return;
    this.db.exec("BEGIN");
    try {
      for (const id of ids) { this.empty.run(id); this.db.prepare("DELETE FROM trees WHERE id = ?").run(id); }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    for (const tree of this.live) if (!keep.has(tree.id)) this.live.delete(tree);
  }

  /** Writes a tree's entries as they are, outside any transaction's layer (moving a store from memory). */
  load(id: number, entries: Iterable<Entry>, index: boolean, keysAreUnique: boolean): void {
    this.empty.run(id);
    for (const entry of entries) this.row(id, entry, index, keysAreUnique);
  }

  /** @internal */
  row(id: number, entry: Entry, index: boolean, keysAreUnique: boolean): void {
    const key = keyBytes(entry.key);
    const bytes = keysAreUnique ? key : key + keyBytes(entry.value);
    this.put.run(id, buffer(bytes), index ? buffer(keyBytes(entry.value)) : null, serialize(entry.key), serialize(entry.value));
  }
  /** @internal */
  read(id: number, bytes: string): Entry | undefined {
    const row = this.get.get(id, buffer(bytes)) as { key: Uint8Array; value: Uint8Array } | undefined;
    return row && { key: deserialize(row.key), value: thaw(row.value) };
  }
  /** @internal */
  size(id: number): number { return Number((this.count.get(id) as { n: number }).n); }
  /** @internal */
  drop(id: number, bytes: string): void { this.remove.run(id, buffer(bytes)); }
  /** @internal */
  clearRows(id: number): void { this.empty.run(id); }
  /** @internal The index entries whose record key's bytes are from `lower` up to (not with) `upper`, either one open. */
  withValue(id: number, lower: string | undefined, upper: string | undefined): Entry[] {
    const where = ["tree = ?", "pv IS NOT NULL"], args: (number | Buffer)[] = [id];
    if (lower !== undefined) { where.push("pv >= ?"); args.push(buffer(lower)); }
    if (upper !== undefined) { where.push("pv < ?"); args.push(buffer(upper)); }
    // Named: with no ANALYZE, SQLite plans this on the primary key's `tree = ?` and reads every entry of the index.
    return (this.db.prepare(`SELECT key, value FROM entries INDEXED BY entries_by_value WHERE ${where.join(" AND ")}`).all(...args) as { key: Uint8Array; value: Uint8Array }[])
      .map((row) => ({ key: deserialize(row.key), value: thaw(row.value) }));
  }
  /** @internal */
  /**
   * The entries between two ids, a page at a time: no statement stays open between pages, so a read that takes the
   * first entry and stops (fake-indexeddb's `get`) leaves nothing that would lock the table for a later write.
   */
  *range(id: number, lower: string | undefined, upper: string | undefined, descending: boolean): Generator<[string, Entry]> {
    let from = descending ? upper : lower, first = true, size = 8;
    for (;;) {
      const where = ["tree = ?"], args: (number | Buffer)[] = [id];
      const low = descending ? lower : from, high = descending ? from : upper;
      if (low !== undefined) { where.push(!descending && !first ? "id > ?" : "id >= ?"); args.push(buffer(low)); }
      if (high !== undefined) { where.push("id < ?"); args.push(buffer(high)); }
      args.push(size);
      const sql = `SELECT id, key, value FROM entries WHERE ${where.join(" AND ")} ORDER BY id ${descending ? "DESC" : "ASC"} LIMIT ?`;
      let statement = this.pages.get(sql);
      if (!statement) this.pages.set(sql, (statement = this.db.prepare(sql)));
      const rows = statement.all(...args) as { id: Uint8Array; key: Uint8Array; value: Uint8Array }[];
      for (const row of rows) yield [Buffer.from(row.id).toString("latin1"), { key: deserialize(row.key), value: thaw(row.value) }];
      if (rows.length < size) return;
      from = Buffer.from(rows.at(-1)!.id).toString("latin1");
      first = false;
      size = Math.min(size * 4, 512);
    }
  }
}

export class SqlTree {
  private pending: Layer[] = [];
  private active: Layer | null = null;

  constructor(private readonly file: TreeFile, readonly id: number, readonly _keysAreUnique: boolean, private readonly index: boolean) {}

  private idOf(entry: Entry): string {
    const key = keyBytes(entry.key);
    return this._keysAreUnique ? key : key + keyBytes(entry.value);
  }

  private layer(): Layer {
    const owner = this.file.owner;
    if (this.active) {
      if (owner && this.active.owner && this.active.owner !== owner) throw new Error("Two transactions wrote one store kept on disk at once");
      if (owner && !this.active.owner) this.active.owner = owner;
      return this.active;
    }
    return (this.active = { owner, seq: 0, cleared: false, puts: new Map(), byValue: new Map() });
  }

  /** An entry (or its removal, `entry` null) in this transaction's layer; an index's by its record key too. */
  private set(bytes: string, record: Entry, entry: Entry | null): void {
    if (entry?.value && typeof entry.value === "object") fresh.delete(entry.value);
    const layer = this.layer();
    layer.puts.set(bytes, entry);
    if (!this.index) return;
    const value = keyBytes(record.value);
    let ids = layer.byValue.get(value);
    if (!ids) layer.byValue.set(value, (ids = new Set()));
    ids.add(bytes);
  }

  /** Newest first: the layer that has the entry says what it is; one cleared hides everything older. */
  private lookup(bytes: string): Entry | null | undefined {
    const layers = this.active ? [...this.pending, this.active] : this.pending;
    for (let at = layers.length - 1; at >= 0; at--) {
      const layer = layers[at]!;
      if (layer.puts.has(bytes)) return layer.puts.get(bytes) ?? null;
      if (layer.cleared) return null;
    }
    return undefined;
  }

  size(): number {
    let hidden = false;
    const map = new Map<string, Entry | null>();
    for (const layer of this.active ? [...this.pending, this.active] : this.pending) {
      if (layer.cleared) { hidden = true; map.clear(); }
      for (const [bytes, entry] of layer.puts) map.set(bytes, entry);
    }
    let size = hidden ? 0 : this.file.size(this.id);
    for (const [bytes, entry] of map) {
      const below = !hidden && this.file.read(this.id, bytes) !== undefined;
      if (entry && !below) size++;
      else if (!entry && below) size--;
    }
    return size;
  }

  get(record: Entry): Entry | undefined {
    const bytes = this.idOf(record);
    const found = this.lookup(bytes);
    if (found !== undefined) return found ?? undefined;
    return this.file.read(this.id, bytes);
  }

  contains(record: Entry): boolean { return this.get(record) !== undefined; }

  put(record: Entry, noOverwrite = false): Entry | undefined {
    // A Blob cannot go to SQLite as it is (no message holds one): refused here, at once, not when the layer goes there.
    if (holdsBlob(record.value)) throw new Error("A store kept in rows.db takes no Blob");
    const existing = this.get(record);
    if (existing !== undefined && noOverwrite) throw new this.file.constraintError();
    this.set(this.idOf(record), record, record);
    return existing;
  }

  delete(record: Entry): void {
    if (this.get(record) === undefined) return;
    this.set(this.idOf(record), record, null);
  }

  clear(): void {
    const layer = this.layer();
    layer.puts.clear();
    layer.byValue.clear();
    layer.cleared = true;
  }

  *getAllRecords(descending = false): Generator<Entry> { yield* this.getRecords(undefined, descending); }

  *getRecords(range: Range | undefined, descending = false): Generator<Entry> {
    const [lower, upper] = bounds(range);
    let hidden = false;
    const map = new Map<string, Entry | null>();
    for (const layer of this.active ? [...this.pending, this.active] : this.pending) {
      if (layer.cleared) { hidden = true; map.clear(); }
      for (const [bytes, entry] of layer.puts) map.set(bytes, entry);
    }
    const over = [...map].filter(([bytes]) => (lower === undefined || bytes >= lower) && (upper === undefined || bytes < upper)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (descending) over.reverse();
    const base = hidden ? undefined : this.file.range(this.id, lower, upper, descending);
    let next = base?.next();
    let at = 0;
    for (;;) {
      const below = next && !next.done ? next.value : undefined;
      const above = over[at];
      if (!below && !above) return;
      const first = above && (!below || (descending ? above[0] >= below[0] : above[0] <= below[0]));
      if (first) {
        if (below && above[0] === below[0]) next = base!.next();
        at++;
        if (above[1]) yield above[1];
      } else {
        yield below![1];
        next = base!.next();
      }
    }
  }

  /**
   * The index entries whose record key (`value`) is in `range`, looked up by its bytes, not walked: removing a chat
   * (its messages' keys from [chat] to [chat, []]) read every message of the profile, 1.5 s at 100,000.
   */
  deleteByValue(range: Range): Entry[] {
    const [lower, upper] = bounds(range);
    const candidates = this.index
      ? [...this.file.withValue(this.id, lower, upper), ...this.overlayWithValue(lower, upper)]
      : [...this.getAllRecords()];
    const deleted: Entry[] = [], seen = new Set<string>();
    for (const candidate of candidates) {
      const bytes = this.idOf(candidate);
      if (seen.has(bytes) || !range.includes(candidate.value)) continue;
      seen.add(bytes);
      const current = this.get(candidate);
      if (!current) continue;
      this.set(bytes, current, null);
      deleted.push(current);
    }
    return deleted;
  }

  /** The entries of the layers whose record key's bytes are between these (as `withValue`). */
  private overlayWithValue(lower: string | undefined, upper: string | undefined): Entry[] {
    const out: Entry[] = [];
    for (const layer of this.active ? [...this.pending, this.active] : this.pending) {
      for (const [value, ids] of layer.byValue) {
        if ((lower !== undefined && value < lower) || (upper !== undefined && value >= upper)) continue;
        for (const bytes of ids) { const entry = layer.puts.get(bytes); if (entry) out.push(entry); }
      }
    }
    return out;
  }

  /** @internal */
  complete(owner: object | null, seq: number): void {
    if (!this.active || (this.active.owner !== owner && this.active.owner !== null)) return;
    this.active.seq = seq;
    this.pending.push(this.active);
    this.active = null;
  }
  /** @internal */
  abort(owner: object | null): void {
    if (this.active && (this.active.owner === owner || this.active.owner === null)) this.active = null;
  }
  /** @internal */
  due(upTo: number): boolean { return this.pending.length > 0 && this.pending[0]!.seq <= upTo; }
  /** @internal */
  write(upTo: number): number {
    let top = 0;
    for (const layer of this.pending) {
      if (layer.seq > upTo) break;
      top = layer.seq;
      if (layer.cleared) this.file.clearRows(this.id);
      for (const [bytes, entry] of layer.puts) {
        if (entry) this.file.row(this.id, entry, this.index, this._keysAreUnique);
        else this.file.drop(this.id, bytes);
      }
    }
    return top;
  }
  /** @internal */
  settle(upTo: number): void {
    while (this.pending.length && this.pending[0]!.seq <= upTo) this.pending.shift();
  }
  /** Whether a transaction's writes are still waiting here (a snapshot then waits for them). */
  get busy(): boolean { return this.active !== null || this.pending.length > 0; }
}

/**
 * rows.db, owner-only (SQLite makes its WAL files with the database's mode), in WAL with NORMAL: the journal makes a
 * transaction durable, and `sync` runs before a snapshot takes the journal's place. With `secure_delete` SQLite zeroes
 * what a delete frees: a message or chat deleted is not left readable in the file's free pages after the fold.
 */
export function openTreeFile(sqlite: typeof import("node:sqlite"), path: string, constraintError: new () => Error): TreeFile {
  closeSync(openSync(path, "a", 0o600));
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON");
  return new TreeFile(db, constraintError);
}

/** A range's keys as bytes: from the first (in) up to the second (out), undefined where it is open. */
function bounds(range: Range | undefined): [string | undefined, string | undefined] {
  return [
    range?.lower === undefined ? undefined : keyBytes(range.lower) + (range.lowerOpen ? AFTER : ""),
    range?.upper === undefined ? undefined : keyBytes(range.upper) + (range.upperOpen ? "" : AFTER),
  ];
}

function holdsBlob(value: unknown, depth = 0): boolean {
  if (value instanceof Blob) return true;
  if (!value || typeof value !== "object" || depth > 32 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (value instanceof Map) { for (const [k, v] of value) if (holdsBlob(k, depth + 1) || holdsBlob(v, depth + 1)) return true; return false; }
  for (const item of Object.values(value)) if (holdsBlob(item, depth + 1)) return true;
  return false;
}
