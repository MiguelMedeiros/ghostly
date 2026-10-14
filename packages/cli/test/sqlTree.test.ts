import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { expect, it } from "vitest";
import { TreeFile } from "../src/runtime/sqlTree";
import { loadSqlite } from "../src/runtime/rows";
// covers: headless.storage

interface Entry { key: unknown; value: unknown }
interface Tree {
  size(): number; get(record: Entry): Entry | undefined; put(record: Entry, noOverwrite?: boolean): Entry | undefined; delete(record: Entry): void;
  getRecords(range: unknown, descending?: boolean): Iterable<Entry>; getAllRecords(descending?: boolean): Iterable<Entry>;
  deleteByValue?(range: unknown): Entry[];
}

/** fake-indexeddb's own red-black tree, the oracle: from a store of a throwaway database (the class is not exported). */
async function oracleClass(): Promise<new (unique: boolean) => Tree> {
  const factory = new IDBFactory();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("oracle", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("s");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const raw = (db as unknown as { _rawDatabase: { rawObjectStores: Map<string, { records: { records: object } }> } })._rawDatabase;
  return raw.rawObjectStores.get("s")!.records.records.constructor as new (unique: boolean) => Tree;
}

it("reads as fake-indexeddb's own tree through puts, overwrites, deletes, clears, commits and aborts, unique or not", async () => {
  const sqlite = (await loadSqlite())!;
  const Oracle = await oracleClass();
  const file = new TreeFile(new sqlite.DatabaseSync(join(mkdtempSync(join(tmpdir(), "ghostly-tree-")), "rows.db")), class extends Error { override name = "ConstraintError"; });
  let seed = 11;
  const random = (below: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % below; };
  const KEYS = [1, 2, 3, -1, 0.5, "a", "b", "ab", "", ["c", 1], ["c", 2], ["c"], ["d", "x"], new Date(5)];
  const key = () => KEYS[random(KEYS.length)];
  const range = () => {
    const [a, b] = [key(), key()].sort((x, y) => new IDBFactory().cmp(x, y));
    switch (random(5)) {
      case 0: return undefined;
      case 1: return IDBKeyRange.only(a);
      case 2: return IDBKeyRange.lowerBound(a, random(2) === 0);
      case 3: return IDBKeyRange.upperBound(b, random(2) === 0);
      default: return new IDBFactory().cmp(a, b) === 0 ? IDBKeyRange.only(a) : IDBKeyRange.bound(a, b, random(2) === 0, random(2) === 0);
    }
  };
  let seq = 0, wroteLast = 0;
  for (const unique of [true, false]) {
    // A store's tree (unique keys, any value) and an index's (non-unique: key then record key, the value a key too).
    const tree = file.tree(file.treeId("db", unique ? "store" : "store", unique ? "" : "index"), unique, !unique) as unknown as Tree;
    let oracle = new Oracle(unique);
    /** The oracle as it was when the last transaction committed: an abort goes back to it. */
    let committed = new Oracle(unique);
    const copy = (from: Tree) => { const to = new Oracle(unique); for (const entry of from.getAllRecords()) to.put(entry); return to; };
    for (let round = 0; round < 400; round++) {
      const owner = {};
      file.owner = owner;
      let wrote = false;
      for (let op = 0; op < 1 + random(6); op++) {
        const entry = { key: key(), value: unique ? { n: random(100) } : key() };
        const kind = random(10);
        if (kind < 5) {
          const noOverwrite = random(4) === 0;
          let a: unknown, b: unknown;
          try { a = oracle.put(entry, noOverwrite); } catch (error) { a = error instanceof Error ? error.name : error; }
          try { b = (tree as Tree).put(entry, noOverwrite); wrote = true; } catch (error) { b = error instanceof Error ? error.name : error; }
          expect(b, `put ${JSON.stringify(entry)}`).toEqual(a);
        } else if (kind < 8) { if (tree.get(entry) !== undefined) wrote = true; oracle.delete(entry); tree.delete(entry); }
        else if (kind === 8 && random(5) === 0) { oracle = new Oracle(unique); (tree as unknown as { clear(): void }).clear(); wrote = true; }
        else if (kind === 9 && !unique && random(2) === 0) {
          // An index's entries by their record key (the value here), in a range: what the oracle holds there goes.
          const r = range() ?? IDBKeyRange.lowerBound(-Infinity);
          const gone = [...oracle.getAllRecords()].filter((e) => r.includes(e.value));
          for (const e of gone) oracle.delete(e);
          const dropped = tree.deleteByValue!(r);
          if (dropped.length) wrote = true;
          const order = (list: Entry[]) => list.map((e) => JSON.stringify([e.key, e.value])).sort();
          expect(order(dropped), `deleteByValue ${JSON.stringify(r)}`).toEqual(order(gone));
        }
        else {
          const r = range(), down = random(2) === 0;
          expect([...tree.getRecords(r, down)]).toEqual(r === undefined ? [...oracle.getAllRecords(down)] : [...oracle.getRecords(r, down)]);
        }
      }
      file.owner = null;
      if (random(6) === 0) { file.abort(owner); oracle = copy(committed); }
      else {
        file.complete(owner, ++seq);
        if (wrote) wroteLast = seq;
        committed = copy(oracle);
        // The journal has it now, or a while later: SQLite takes it then.
        if (random(3) > 0) file.apply(seq);
      }
      expect(tree.size()).toBe(oracle.size());
      expect([...tree.getAllRecords()]).toEqual([...oracle.getAllRecords()]);
      expect([...tree.getAllRecords(true)]).toEqual([...oracle.getAllRecords(true)]);
      const probe = { key: key(), value: unique ? { n: 0 } : key() };
      // The oracle's own `get` finds records it deleted (fake-indexeddb never calls it): what it holds is the answer.
      const cmp = (a: unknown, b: unknown) => new IDBFactory().cmp(a, b);
      expect(tree.get(probe)).toEqual([...oracle.getAllRecords()].find((e) => cmp(e.key, probe.key) === 0 && (unique || cmp(e.value, probe.value) === 0)));
    }
    file.apply(seq);
    expect([...tree.getAllRecords()]).toEqual([...oracle.getAllRecords()]);
    // SQLite says the last entry that wrote a tree (one that wrote nothing here costs no SQLite write).
    expect(file.applied()).toBe(wroteLast);
  }
});

it("finds an index's entries by their record key, one or a range of them, through entries_by_value, not by walking the whole tree", async () => {
  const sqlite = (await loadSqlite())!;
  const file = new TreeFile(new sqlite.DatabaseSync(":memory:"), Error);
  const id = file.treeId("db", "messages", "byChat");
  const tree = file.tree(id, false, true);
  // A long chat's messages, then a short one's: their keys are [chat, n], as the engine's.
  for (let n = 0; n < 2000; n++) tree.put({ key: ["long", n], value: ["long", n] });
  for (let n = 0; n < 20; n++) tree.put({ key: ["short", n], value: ["short", n] });
  file.complete(null, 1);
  file.apply(1);
  // Planned on the primary key's `tree = ?` alone, a lookup would read every entry of the index.
  const statements: string[] = [];
  const prepare = file.db.prepare.bind(file.db);
  (file.db as { prepare: typeof prepare }).prepare = (sql: string) => { statements.push(sql); return prepare(sql); };
  // A message's delivery mark, by its key; then the short chat removed (the engine's [chat]..[chat, []]), with one of
  // its messages written in a transaction SQLite does not have yet.
  file.owner = {};
  tree.put({ key: ["mark", 0], value: ["short", 3] });
  expect(tree.deleteByValue!(IDBKeyRange.only(["short", 3])).length).toBe(2);
  tree.put({ key: ["short", 99], value: ["short", 99] });
  const dropped = tree.deleteByValue!(IDBKeyRange.bound(["short"], ["short", []]));
  expect(dropped.map((e) => e.value)).toEqual(expect.arrayContaining([["short", 0], ["short", 19], ["short", 99]]));
  expect(dropped).toHaveLength(20);
  (file.db as { prepare: typeof prepare }).prepare = prepare;
  // Each statement those ran, the only ones: no walk of the tree's entries in key order (`range`).
  expect(statements.length).toBeGreaterThan(0);
  for (const sql of statements) {
    const args = (sql.match(/\?/g) ?? []).map((_, at) => (at === 0 ? id : Buffer.alloc(1)));
    const plan = (file.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((row) => row.detail).join("\n");
    expect(plan, sql).toMatch(/USING INDEX entries_by_value \(tree=\? AND pv>\? AND pv<\?\)/);
  }
  expect([...tree.getAllRecords()]).toHaveLength(2000);
});

it("writes over many records in one transaction looking each one up by key, never walking what the transaction wrote", async () => {
  const sqlite = (await loadSqlite())!;
  const file = new TreeFile(new sqlite.DatabaseSync(":memory:"), Error);
  const store = file.tree(file.treeId("db", "messages"), true, false);
  const index = file.tree(file.treeId("db", "messages", "byTime"), false, true);
  const K = 400;
  for (let n = 0; n < K; n++) { store.put({ key: ["c", n], value: { t: n } }); index.put({ key: ["c", n], value: ["c", n] }); }
  file.complete(null, 1);
  file.apply(1);

  // Every entry read off a layer's maps by walking them (a lookup by key reads none).
  let walked = 0;
  class Walked<K, V> extends Map<K, V> {
    override *[Symbol.iterator](): MapIterator<[K, V]> { for (const entry of super.entries()) { walked++; yield entry; } }
  }
  const counted = (tree: object) => {
    const layer = (tree as { active: { puts: Map<string, unknown>; byValue: Map<string, unknown> } }).active;
    layer.puts = new Walked(layer.puts);
    layer.byValue = new Walked(layer.byValue);
  };
  // What fake-indexeddb does for each `put` over a stored record, as `db.patchMessages` moves a catch-up's messages:
  // the record got, written over, and its old entry in each index found by its key and replaced.
  file.owner = {};
  const overwrite = (n: number) => {
    const old = store.getRecords(IDBKeyRange.only(["c", n])).next().value as Entry;
    store.put({ key: ["c", n], value: { t: (old.value as { t: number }).t + K } });
    expect(index.deleteByValue!(IDBKeyRange.only(["c", n]))).toHaveLength(1);
    index.put({ key: ["c", n + K], value: ["c", n] });
  };
  overwrite(0);
  counted(store);
  counted(index);
  for (let n = 1; n < K; n++) overwrite(n);
  // Before, each one walked every entry the transaction had written: K² / 2 of them in all, 128 million at 16,000.
  expect(walked).toBe(0);
  file.owner = null;
  file.complete(null, 2);
  file.apply(2);
  expect([...store.getAllRecords()].map((e) => (e.value as { t: number }).t)).toEqual(Array.from({ length: K }, (_, n) => n + K));
  expect([...index.getAllRecords()].map((e) => e.key)).toEqual(Array.from({ length: K }, (_, n) => ["c", n + K]));
});

it("refuses a Blob in a tree at once, rather than when its transaction goes to SQLite", async () => {
  const sqlite = (await loadSqlite())!;
  const file = new TreeFile(new sqlite.DatabaseSync(":memory:"), Error);
  const tree = file.tree(file.treeId("db", "messages"), true, false);
  expect(() => tree.put({ key: 1, value: { picture: new Blob(["x"]) } })).toThrow(/takes no Blob/);
  expect(tree.size()).toBe(0);
});
