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

it("finds an index's entries by their record key through entries_by_value, not by walking the whole tree", async () => {
  const sqlite = (await loadSqlite())!;
  const file = new TreeFile(new sqlite.DatabaseSync(":memory:"), Error);
  const id = file.treeId("db", "messages", "byChat");
  const tree = file.tree(id, false, true);
  for (let n = 0; n < 2000; n++) tree.put({ key: ["chat", n % 7], value: ["msg", n] });
  file.complete(null, 1);
  file.apply(1);
  // The statement withValue runs: planned on the primary key's `tree = ?` alone, it would read every entry of the index.
  const byValue = (file as unknown as { byValue: { sourceSQL: string } }).byValue;
  const plan = (file.db.prepare(`EXPLAIN QUERY PLAN ${byValue.sourceSQL}`).all(id, Buffer.alloc(1)) as { detail: string }[]).map((row) => row.detail);
  expect(plan.join("\n")).toMatch(/USING INDEX entries_by_value \(tree=\? AND pv=\?\)/);
  expect(file.withValue(id, ["msg", 42])).toEqual([{ key: ["chat", 0], value: ["msg", 42] }]);
});

it("refuses a Blob in a tree at once, rather than when its transaction goes to SQLite", async () => {
  const sqlite = (await loadSqlite())!;
  const file = new TreeFile(new sqlite.DatabaseSync(":memory:"), Error);
  const tree = file.tree(file.treeId("db", "messages"), true, false);
  expect(() => tree.put({ key: 1, value: { picture: new Blob(["x"]) } })).toThrow(/takes no Blob/);
  expect(tree.size()).toBe(0);
});
