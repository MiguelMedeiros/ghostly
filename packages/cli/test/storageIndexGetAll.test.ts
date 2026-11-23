import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "../src/runtime/storage";
import { SqlTree, TreeFile } from "../src/runtime/sqlTree";
// covers: headless.storage

/**
 * An index's `getAll` on a store kept on disk takes the record keys off the index, then reads the records in a few
 * rows.db reads (`SqlTree.getMany`), not one each. The same random puts, deletes, clears and queries run here against
 * fake-indexeddb as it ships (its CommonJS build: classes this store does not hook) and against the store on disk; every
 * answer must be the same, inside a transaction (its own writes and deletes) and across them, an aborted one included.
 */
const pristine = createRequire(import.meta.url)("fake-indexeddb") as { IDBFactory: new () => IDBFactory; IDBKeyRange: typeof IDBKeyRange };

let dir: string, store: PersistentIndexedDb;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-index-getall-"));
  store = await openPersistentIndexedDb(dir, { rowsOnDisk: (_db, name) => name === "s" || name === "messages" });
});
afterAll(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** mulberry32: the same script from the same seed. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]): T => xs[int(xs.length)]! };
}

type RangeSpec =
  | { kind: "key"; key: unknown }
  | { kind: "only"; key: unknown }
  | { kind: "bound"; lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean }
  | { kind: "lower"; key: unknown; open: boolean }
  | { kind: "upper"; key: unknown; open: boolean };
type Op =
  | { t: "put"; value: Record<string, unknown> }
  | { t: "delete"; key: number }
  | { t: "deleteRange"; lower: number; upper: number }
  | { t: "clear" }
  | { t: "getAll"; index: string; query?: RangeSpec; count?: number; direction?: IDBCursorDirection; options: boolean }
  | { t: "storeGetAll"; query?: RangeSpec; count?: number }
  | { t: "get"; index: string; key: unknown };
interface Tx { write: boolean; ops: Op[]; abort: boolean; fold: boolean }

const INDEXES = ["byA", "byTags", "byU", "byPair"] as const;
const TAGS = ["w", "x", "y", "z"];
const DIRECTIONS: (IDBCursorDirection | undefined)[] = [undefined, "next", "prev", "nextunique", "prevunique"];

function script(seed: number): Tx[] {
  const r = random(seed), cmp = new pristine.IDBFactory().cmp.bind(new pristine.IDBFactory());
  let n = 0;
  const value = (): Record<string, unknown> => {
    const v: Record<string, unknown> = { id: r.int(60), b: r.int(3), n: n++, text: "t".repeat(r.int(40)) };
    if (r.next() < 0.8) v.a = r.int(5);
    // multiEntry: an array (duplicates and a non-key among its items), a lone key, or nothing.
    const tags = r.next();
    if (tags < 0.6) v.tags = Array.from({ length: r.int(4) }, () => (r.next() < 0.1 ? { not: "a key" } : r.pick(TAGS)));
    else if (tags < 0.8) v.tags = r.pick(TAGS);
    // unique: a few values, so that a put now and then is refused.
    if (r.next() < 0.5) v.u = r.int(30);
    return v;
  };
  const key = (index: string): unknown => {
    switch (index) {
      case "byA": return r.int(7) - 1;
      case "byTags": return r.pick([...TAGS, "a", "zz"]);
      case "byU": return r.int(32) - 1;
      default: return [r.int(6) - 1, r.int(4) - 1];
    }
  };
  const range = (index: string): RangeSpec | undefined => {
    const kind = r.int(6);
    if (kind === 0) return undefined;
    if (kind === 1) return { kind: "key", key: key(index) };
    if (kind === 2) return { kind: "only", key: key(index) };
    if (kind === 3) {
      let [lower, upper] = [key(index), key(index)];
      if (cmp(lower, upper) > 0) [lower, upper] = [upper, lower];
      const same = cmp(lower, upper) === 0;
      return { kind: "bound", lower, upper, lowerOpen: !same && r.next() < 0.5, upperOpen: !same && r.next() < 0.5 };
    }
    return { kind: kind === 4 ? "lower" : "upper", key: key(index), open: r.next() < 0.5 };
  };
  const query = (): Op => {
    const roll = r.next();
    if (roll < 0.1) return { t: "storeGetAll", query: r.next() < 0.5 ? undefined : { kind: "bound", lower: r.int(30), upper: 30 + r.int(30), lowerOpen: false, upperOpen: r.next() < 0.5 }, count: r.next() < 0.5 ? undefined : r.int(8) };
    const index = r.pick(INDEXES);
    if (roll < 0.2) return { t: "get", index, key: key(index) };
    const options = r.next() < 0.5;
    return { t: "getAll", index, query: range(index), count: r.next() < 0.4 ? undefined : r.int(10), direction: options ? r.pick(DIRECTIONS) : undefined, options };
  };
  const txs: Tx[] = [];
  for (let i = 0; i < 70; i++) {
    const write = r.next() < 0.75, ops: Op[] = [];
    for (let k = 1 + r.int(14); k > 0; k--) {
      const roll = r.next();
      if (!write || roll < 0.45) ops.push(query());
      else if (roll < 0.85) ops.push({ t: "put", value: value() });
      else if (roll < 0.93) ops.push({ t: "delete", key: r.int(60) });
      else if (roll < 0.99) { const lower = r.int(60); ops.push({ t: "deleteRange", lower, upper: lower + r.int(10) }); }
      else ops.push({ t: "clear" });
    }
    // Queries after the writes too: what the transaction wrote, as it reads it back.
    if (write) ops.push(query(), query());
    txs.push({ write, ops, abort: write && r.next() < 0.15, fold: r.next() < 0.12 });
  }
  return txs;
}

function toRange(KeyRange: typeof IDBKeyRange, spec: RangeSpec | undefined): unknown {
  if (!spec) return undefined;
  switch (spec.kind) {
    case "key": return spec.key;
    case "only": return KeyRange.only(spec.key);
    case "bound": return KeyRange.bound(spec.lower, spec.upper, spec.lowerOpen, spec.upperOpen);
    case "lower": return KeyRange.lowerBound(spec.key, spec.open);
    case "upper": return KeyRange.upperBound(spec.key, spec.open);
  }
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const s = request.result.createObjectStore("s", { keyPath: "id" });
      s.createIndex("byA", "a");
      s.createIndex("byTags", "tags", { multiEntry: true });
      s.createIndex("byU", "u", { unique: true });
      s.createIndex("byPair", ["a", "b"]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** What each op answered, as text; the objects a read handed out are written over after, as a caller may. */
async function run(factory: IDBFactory, KeyRange: typeof IDBKeyRange, name: string, txs: Tx[], fold: () => Promise<void>): Promise<string[]> {
  const d = await openDb(factory, name), log: string[] = [];
  for (const [at, t] of txs.entries()) {
    const tx = d.transaction("s", t.write ? "readwrite" : "readonly"), s = tx.objectStore("s");
    const done = new Promise<string>((resolve) => { tx.oncomplete = () => resolve("complete"); tx.onabort = () => resolve(`abort ${tx.error?.name ?? ""}`); });
    await new Promise<void>((resolve) => {
      const step = (i: number) => {
        if (i === t.ops.length) { if (t.abort) tx.abort(); return resolve(); }
        const op = t.ops[i]!, tag = `${at}.${i} ${op.t}`;
        let request: IDBRequest;
        switch (op.t) {
          case "put": request = s.put(op.value); break;
          case "delete": request = s.delete(op.key); break;
          case "deleteRange": request = s.delete(KeyRange.bound(op.lower, op.upper)); break;
          case "clear": request = s.clear(); break;
          case "get": request = s.index(op.index).get(toRange(KeyRange, { kind: "key", key: op.key }) as IDBValidKey); break;
          case "storeGetAll": request = s.getAll(toRange(KeyRange, op.query) as IDBKeyRange, op.count); break;
          case "getAll": {
            const index = s.index(op.index), query = toRange(KeyRange, op.query) as IDBKeyRange | undefined;
            request = op.options
              ? (index.getAll as unknown as (options: object) => IDBRequest)({ query, count: op.count, direction: op.direction })
              : op.count === undefined ? index.getAll(query) : index.getAll(query, op.count);
          }
        }
        request.onsuccess = () => {
          const result = request.result as unknown;
          const rows = Array.isArray(result) ? result : [result];
          const objects = rows.filter((row) => row && typeof row === "object");
          log.push(`${tag} ${JSON.stringify(result)} distinct ${new Set(objects).size}/${objects.length}`);
          // A caller's own copy: writing over it changes no later answer.
          for (const row of objects as Record<string, unknown>[]) { row.n = -1; if (Array.isArray(row.tags)) row.tags.push("x"); }
          step(i + 1);
        };
        request.onerror = (event) => { event.preventDefault(); log.push(`${tag} error ${request.error?.name}`); step(i + 1); };
      };
      step(0);
    });
    log.push(`${at} ${await done}`);
    if (t.fold) await fold();
  }
  d.close();
  return log;
}

describe("an index's getAll on a store kept on disk", () => {
  it("answers as fake-indexeddb does: order, count, direction, multiEntry, unique, a transaction's own writes, an abort", async () => {
    const getMany = vi.spyOn(SqlTree.prototype, "getMany"), readMany = vi.spyOn(TreeFile.prototype, "readMany");
    try {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const txs = script(seed);
        const expected = await run(new pristine.IDBFactory(), pristine.IDBKeyRange, `diff-${seed}`, txs, async () => {});
        const got = await run(store.factory, IDBKeyRange, `diff-${seed}`, txs, () => store.compact());
        const first = got.findIndex((line, at) => line !== expected[at]);
        expect({ seed, at: first, got: got[first], expected: expected[first] }).toEqual({ seed, at: -1, got: undefined, expected: undefined });
        expect(got.length).toBe(expected.length);
      }
      // The new path ran, on rows.db's rows and on a transaction's layer both.
      expect(getMany).toHaveBeenCalled();
      expect(readMany.mock.calls.some(([, ids]) => ids.length > 1)).toBe(true);
    } finally {
      getMany.mockRestore();
      readMany.mockRestore();
    }
  }, 60_000);

  it.each([200, 1600])("reads %i files of a chat in a few rows.db reads, not one each", async (files) => {
    const d = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = store.factory.open(`files-${files}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("messages", { keyPath: ["linkId", "id"] }).createIndex("byLinkFile", ["linkId", "file.id"]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("messages", "readwrite"), s = tx.objectStore("messages");
      for (let i = 0; i < files; i++) {
        s.put({ linkId: "chat", id: `m${String(i).padStart(5, "0")}`, text: "", timestamp: i, file: { id: `chat-in-${files - i}`, name: `f${i}.pdf`, size: 2048 } });
        s.put({ linkId: "chat", id: `t${i}`, text: `text ${i}`, timestamp: i });
        s.put({ linkId: "other", id: `m${i}`, text: "", timestamp: i, file: { id: `other-in-${i}`, name: "x", size: 1 } });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // In rows.db, not in the transaction's layer: what a daemon reads.
    await store.compact();
    const read = vi.spyOn(TreeFile.prototype, "read"), readMany = vi.spyOn(TreeFile.prototype, "readMany");
    try {
      const index = d.transaction("messages").objectStore("messages").index("byLinkFile");
      const rows = await new Promise<{ id: string; file: { id: string } }[]>((resolve, reject) => {
        const request = index.getAll(IDBKeyRange.bound(["chat"], ["chat", []]));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(rows.length).toBe(files);
      // In the index's order: by file id.
      expect(rows.map((row) => row.file.id)).toEqual(rows.map((row) => row.file.id).sort());
      expect(read).not.toHaveBeenCalled();
      expect(readMany).toHaveBeenCalledTimes(1);
      expect(readMany.mock.calls[0]![1]).toHaveLength(files);
    } finally {
      read.mockRestore();
      readMany.mockRestore();
      d.close();
    }
  });
});
