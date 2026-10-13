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

/** A transaction's writes to one tree: an entry by its id, null for one removed; `cleared`: nothing under it counts. */
interface Layer { owner: object | null; seq: number; cleared: boolean; puts: Map<string, Entry | null> }

const buffer = (bytes: string) => Buffer.from(bytes, "latin1");

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
  private readonly byValue: StatementSync;

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
    this.byValue = db.prepare("SELECT key, value FROM entries WHERE tree = ? AND pv = ?");
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
    const due = [...this.live].filter((tree) => tree.due(upTo));
    if (!due.length && upTo <= this.applied()) return;
    this.db.exec("BEGIN");
    try {
      for (const tree of due) tree.write(upTo);
      this.db.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('applied', max(?, coalesce((SELECT value FROM meta WHERE name = 'applied'), 0)))").run(upTo);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
    return row && { key: deserialize(row.key), value: deserialize(row.value) };
  }
  /** @internal */
  size(id: number): number { return Number((this.count.get(id) as { n: number }).n); }
  /** @internal */
  drop(id: number, bytes: string): void { this.remove.run(id, buffer(bytes)); }
  /** @internal */
  clearRows(id: number): void { this.empty.run(id); }
  /** @internal */
  withValue(id: number, value: unknown): Entry[] {
    return (this.byValue.all(id, buffer(keyBytes(value))) as { key: Uint8Array; value: Uint8Array }[]).map((row) => ({ key: deserialize(row.key), value: deserialize(row.value) }));
  }
  /** @internal */
  *range(id: number, lower: string | undefined, upper: string | undefined, descending: boolean): Generator<[string, Entry]> {
    const where = ["tree = ?"], args: (number | Buffer)[] = [id];
    if (lower !== undefined) { where.push("id >= ?"); args.push(buffer(lower)); }
    if (upper !== undefined) { where.push("id < ?"); args.push(buffer(upper)); }
    // A statement of its own: a cursor's read may run while another one of the same shape is still being walked.
    const statement = this.db.prepare(`SELECT id, key, value FROM entries WHERE ${where.join(" AND ")} ORDER BY id ${descending ? "DESC" : "ASC"}`);
    for (const row of statement.iterate(...args) as Iterable<{ id: Uint8Array; key: Uint8Array; value: Uint8Array }>) {
      yield [Buffer.from(row.id).toString("latin1"), { key: deserialize(row.key), value: deserialize(row.value) }];
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
    return (this.active = { owner, seq: 0, cleared: false, puts: new Map() });
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
    const existing = this.get(record);
    if (existing !== undefined && noOverwrite) throw new this.file.constraintError();
    this.layer().puts.set(this.idOf(record), record);
    return existing;
  }

  delete(record: Entry): void {
    if (this.get(record) === undefined) return;
    this.layer().puts.set(this.idOf(record), null);
  }

  clear(): void {
    const layer = this.layer();
    layer.puts.clear();
    layer.cleared = true;
  }

  *getAllRecords(descending = false): Generator<Entry> { yield* this.getRecords(undefined, descending); }

  *getRecords(range: Range | undefined, descending = false): Generator<Entry> {
    const lower = range?.lower === undefined ? undefined : keyBytes(range.lower) + (range.lowerOpen ? AFTER : "");
    const upper = range?.upper === undefined ? undefined : keyBytes(range.upper) + (range.upperOpen ? "" : AFTER);
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

  /** The index entries whose record key (`value`) is in `range`: one key is looked up by its bytes, not walked. */
  deleteByValue(range: Range, single: unknown): Entry[] {
    const candidates = single !== undefined && this.index
      ? [...this.file.withValue(this.id, single), ...this.overlayEntries()]
      : [...this.getAllRecords()];
    const deleted: Entry[] = [], seen = new Set<string>();
    for (const candidate of candidates) {
      const bytes = this.idOf(candidate);
      if (seen.has(bytes) || !range.includes(candidate.value)) continue;
      seen.add(bytes);
      const current = this.get(candidate);
      if (!current) continue;
      this.layer().puts.set(bytes, null);
      deleted.push(current);
    }
    return deleted;
  }

  private overlayEntries(): Entry[] {
    const out: Entry[] = [];
    for (const layer of this.active ? [...this.pending, this.active] : this.pending) for (const entry of layer.puts.values()) if (entry) out.push(entry);
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
  write(upTo: number): void {
    while (this.pending.length && this.pending[0]!.seq <= upTo) {
      const layer = this.pending.shift()!;
      if (layer.cleared) this.file.clearRows(this.id);
      for (const [bytes, entry] of layer.puts) {
        if (entry) this.file.row(this.id, entry, this.index, this._keysAreUnique);
        else this.file.drop(this.id, bytes);
      }
    }
  }
  /** Whether a transaction's writes are still waiting here (a snapshot then waits for them). */
  get busy(): boolean { return this.active !== null || this.pending.length > 0; }
}
