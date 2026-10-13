import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyOrder, openPersistentIndexedDb, type PersistentIndexedDb } from "../src/runtime/storage";
import { TreeFile } from "../src/runtime/sqlTree";
// covers: headless.storage

/** Every disk sync the store asks for. */
const syncs = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync: (fd: number) => { syncs.count++; fs.fsyncSync(fd); },
    renameSync: (from: string, to: string) => { if (faults.rename) throw new Error("ENOSPC: no space left on device"); fs.renameSync(from, to); },
    writeSync: (fd: number, bytes: Buffer, at = 0) => {
      if (!faults.short || bytes.length - at < 2) return fs.writeSync(fd, bytes, at);
      faults.short = false;
      return fs.writeSync(fd, bytes, at, (bytes.length - at) >> 1);
    },
  };
});

/** What the disk does wrong when a test asks: a rename that fails, one write that takes only half of its bytes. */
const faults = vi.hoisted(() => ({ rename: false, short: false }));

const opened: PersistentIndexedDb[] = [];
// A store left open keeps journaling every later test's transactions (the classes it hooks are shared): close them.
afterEach(async () => { await Promise.all(opened.splice(0).map((store) => store.close())); });

async function open(dir: string) {
  const store = await openPersistentIndexedDb(dir);
  opened.push(store);
  return store.factory;
}

function db(factory: IDBFactory, name = "ghostly", version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("messages")) d.createObjectStore("messages", { keyPath: ["linkId", "id"] }).createIndex("byLink", "linkId");
      if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings");
      if (!d.objectStoreNames.contains("log")) d.createObjectStore("log", { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(d: IDBDatabase, stores: string[], work: (s: Record<string, IDBObjectStore>) => void): Promise<void> {
  const t = d.transaction(stores, "readwrite");
  work(Object.fromEntries(stores.map((n) => [n, t.objectStore(n)])));
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onabort = t.onerror = () => reject(t.error); });
}

const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

const folder = () => mkdtempSync(join(tmpdir(), "ghostly-storage-"));

describe("persistent IndexedDB", () => {
  it("keeps what a committed transaction wrote, across a crash (no close), with its indexes", async () => {
    const dir = folder();
    const first = await db(await open(dir));
    await tx(first, ["messages", "settings"], (s) => {
      s.messages.put({ linkId: "a", id: "1", text: "one" });
      s.messages.put({ linkId: "b", id: "2", text: "two" });
      s.messages.put({ linkId: "a", id: "3", text: "three", bytes: new Uint8Array([1, 2, 3]) });
      s.settings.put({ online: true, relays: ["http://127.0.0.1:1"] }, "settings");
    });
    await tx(first, ["messages"], (s) => { s.messages.delete(["b", "2"]); });

    const second = await db(await open(dir));
    const byLink = await read(second.transaction("messages").objectStore("messages").index("byLink").getAll("a"));
    expect(byLink.map((m: { text: string }) => m.text)).toEqual(["one", "three"]);
    expect((byLink[1] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(await read(second.transaction("messages").objectStore("messages").count())).toBe(2);
    expect(await read(second.transaction("settings").objectStore("settings").get("settings"))).toEqual({ online: true, relays: ["http://127.0.0.1:1"] });
  });

  it("leaves a relaxed transaction's sync to the next transaction, or to a second later: it is on disk either way", async () => {
    const dir = folder();
    const d = await db(await open(dir));
    const relaxed = (value: string, key: string) => {
      const t = d.transaction("settings", "readwrite", { durability: "relaxed" });
      t.objectStore("settings").put(value, key);
      return new Promise<void>((resolve) => { t.oncomplete = () => resolve(); });
    };
    let before = syncs.count;
    await relaxed("sending", "seen:m1");
    await relaxed("sent", "seen:m1");
    expect(syncs.count - before).toBe(0);
    // Written all the same: a process that dies now has lost neither.
    const journal = readFileSync(join(dir, "journal.bin"));
    expect(journal.includes("sent")).toBe(true);

    // The next transaction syncs before it says `complete`, as every one did: the relaxed entries go with it.
    await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "m1", text: "hello" }); });
    expect(syncs.count - before).toBe(1);

    // With no transaction after it, a relaxed one is synced within a second, once.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      before = syncs.count;
      await relaxed("delivered", "seen:m1");
      await relaxed("yes", "seen:m2");
      expect(syncs.count - before).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(syncs.count - before).toBe(1);
      vi.advanceTimersByTime(5_000);
      expect(syncs.count - before).toBe(1);
    } finally { vi.useRealTimers(); }

    // Crash: all of it is there.
    const again = await db(await open(dir));
    expect(await read(again.transaction("settings").objectStore("settings").get("seen:m1"))).toBe("delivered");
    expect(await read(again.transaction("settings").objectStore("settings").get("seen:m2"))).toBe("yes");
    expect(await read(again.transaction("messages").objectStore("messages").get(["a", "m1"]))).toMatchObject({ text: "hello" });
  });

  it("drops an aborted transaction", async () => {
    const dir = folder();
    const first = await db(await open(dir));
    const t = first.transaction(["messages"], "readwrite");
    t.objectStore("messages").put({ linkId: "a", id: "1", text: "never" });
    await new Promise<void>((resolve) => { t.onabort = () => resolve(); t.abort(); });
    const second = await db(await open(dir));
    expect(await read(second.transaction("messages").objectStore("messages").count())).toBe(0);
  });

  it("lets go of a transaction once it ended: a daemon does not keep every transaction it ran", async () => {
    const d = await db(await open(folder()));
    for (let i = 0; i < 40; i++) await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: String(i), text: "x".repeat(1000) }); });
    for (let i = 0; i < 20; i++) await read(d.transaction("messages").objectStore("messages").count());
    const aborted = d.transaction(["messages"], "readwrite");
    aborted.objectStore("messages").put({ linkId: "a", id: "never", text: "never" });
    await new Promise<void>((resolve) => { aborted.onabort = () => resolve(); aborted.abort(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // fake-indexeddb's own list of the database's transactions: each one kept holds its requests and rollback log.
    expect((d as unknown as { _rawDatabase: { transactions: unknown[] } })._rawDatabase.transactions).toHaveLength(0);
    expect(await read(d.transaction("messages").objectStore("messages").count())).toBe(40);
  });

  it("replays clears and range deletes, and keeps the key generator", async () => {
    const dir = folder();
    const first = await db(await open(dir));
    await tx(first, ["log", "messages"], (s) => {
      for (let i = 0; i < 5; i++) s.log.add({ i });
      s.messages.put({ linkId: "a", id: "1" });
      s.messages.put({ linkId: "a", id: "2" });
      s.messages.put({ linkId: "c", id: "9" });
    });
    await tx(first, ["log", "messages"], (s) => {
      s.log.delete(IDBKeyRange.bound(2, 4));
      s.messages.delete(IDBKeyRange.bound(["a", ""], ["a", "￿"]));
    });
    const second = await db(await open(dir));
    expect(await read(second.transaction("log").objectStore("log").getAllKeys())).toEqual([1, 5]);
    await tx(second, ["log", "settings"], (s) => { s.log.add({ i: 6 }); s.settings.clear(); });
    expect(await read(second.transaction("log").objectStore("log").getAllKeys())).toEqual([1, 5, 6]);
    expect(await read(second.transaction("messages").objectStore("messages").getAllKeys())).toEqual([["c", "9"]]);
  });

  it("replays a long journal after a crash in about the time of a normal start, indexes right", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    (await db(store.factory)).close();
    await store.close();
    // What a daemon killed mid-chat leaves: every message written, then each one written again (a status, a receipt).
    const { serialize } = await import("node:v8");
    const n = 2000;
    const entry = (ops: unknown[]) => { const body = serialize(ops); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); };
    const put = (linkId: string, id: number) => ({ db: "ghostly", store: "messages", kind: "put", key: [linkId, String(id)], value: { linkId, id: String(id), text: "x".repeat(200) } });
    const journal: Buffer[] = [];
    for (let i = 0; i < n; i++) journal.push(entry([put("a", i)]));
    for (let i = 0; i < n; i++) journal.push(entry([put("a", i)]));
    journal.push(entry([{ db: "ghostly", store: "messages", kind: "delete", key: ["a", "0"] }, put("b", 1)]));
    writeFileSync(join(dir, "journal.bin"), Buffer.concat(journal));

    const started = performance.now();
    const factory = await open(dir);
    const took = performance.now() - started;
    const second = await db(factory);
    const messages = second.transaction("messages").objectStore("messages");
    expect(await read(messages.count())).toBe(n);
    expect(await read(messages.index("byLink").count("a"))).toBe(n - 1);
    expect(await read(messages.index("byLink").getAllKeys("b"))).toEqual([["b", "1"]]);
    expect(took).toBeLessThan(1500);
  });

  it("ignores a torn last journal entry (the process died mid-write)", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await db(store.factory);
    await tx(first, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    const header = Buffer.alloc(4); header.writeUInt32BE(1000);
    appendFileSync(join(dir, "journal.bin"), Buffer.concat([header, Buffer.from("partial")]));
    const second = await db(await open(dir));
    expect(await read(second.transaction("messages").objectStore("messages").count())).toBe(1);
  });

  it("stores Blobs as their bytes and gives them back as Blobs", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await db(store.factory);
    await tx(first, ["settings"], (s) => { s.settings.put({ blob: new Blob(["hello"], { type: "text/plain" }) }, "file"); });
    await store.flush();
    const second = await db(await open(dir));
    const value = await read(second.transaction("settings").objectStore("settings").get("file")) as { blob: Blob };
    expect(value.blob).toBeInstanceOf(Blob);
    expect(value.blob.type).toBe("text/plain");
    expect(await value.blob.text()).toBe("hello");
  });

  it("keeps an upgrade and a deleted database", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await db(store.factory, "ghostly", 1);
    first.close();
    const upgraded = await new Promise<IDBDatabase>((resolve) => {
      const request = store.factory.open("ghostly", 2);
      request.onupgradeneeded = () => request.result.createObjectStore("groups", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
    });
    await tx(upgraded, ["groups"], (s) => { s.groups.put({ id: "g" }); });
    const other = await db(store.factory, "sdk-db");
    other.close();
    await new Promise<void>((resolve) => { const r = store.factory.deleteDatabase("sdk-db"); r.onsuccess = () => resolve(); });
    await store.flush();
    const factory = await open(dir);
    expect((await factory.databases()).map((d) => [d.name, d.version]).sort()).toEqual([["ghostly", 2]]);
    const again = await db(factory, "ghostly", 2);
    expect(await read(again.transaction("groups").objectStore("groups").get("g"))).toEqual({ id: "g" });
  });

  it("folds the journal into the snapshot when asked, owner-only files", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await db(store.factory);
    await tx(first, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    expect(store.journalBytes()).toBeGreaterThan(0);
    expect(statSync(join(dir, "journal.bin")).mode & 0o777).toBe(0o600);
    await store.compact();
    expect(store.journalBytes()).toBe(0);
    expect(statSync(join(dir, "snapshot.bin")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await store.close();
  });

  it("keeps on close a write nobody waited for: the transaction made in the turn the process leaves", async () => {
    // The engine writes a removed chat, a new name or a service with `void db.…`. fake-indexeddb runs a transaction on
    // a later turn of the event loop: a one-shot command closed in the same turn, and its answer was never on disk.
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await db(store.factory);
    await tx(first, ["settings"], (s) => { s.settings.put("bob", "name"); s.settings.put("a secret", "history"); });
    first.transaction(["settings"], "readwrite").objectStore("settings").put("Alice", "name");
    // One that begins when another ends, as a chat's messages go after its row.
    void tx(first, ["settings"], (s) => { s.settings.delete("history"); }).then(() => { first.transaction(["settings"], "readwrite").objectStore("settings").put(true, "gone"); });
    await store.close();

    const second = await db(await open(dir));
    const settings = () => second.transaction("settings").objectStore("settings");
    expect(await read(settings().get("name"))).toBe("Alice");
    expect(await read(settings().get("history"))).toBeUndefined();
    expect(await read(settings().get("gone"))).toBe(true);
  });

  it("brings a large store back from its snapshot in bulk, not record by record, and keeps it usable", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await db(store.factory);
    first.close();
    const upgraded = await new Promise<IDBDatabase>((resolve) => {
      const request = store.factory.open("ghostly", 2);
      request.onupgradeneeded = () => {
        const messages = request.transaction!.objectStore("messages");
        messages.createIndex("byLinkTime", ["linkId", "timestamp"]);
        messages.createIndex("byCard", "card.kind");
        request.result.createObjectStore("proofs", { keyPath: "secret" }).createIndex("byAmount", "amount", { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
    });
    // Ids out of time order, as random ids are: the time index is not in the store's own order.
    await tx(upgraded, ["messages", "proofs", "log"], (s) => {
      for (let i = 0; i < 3000; i++) s.messages.put({ linkId: `chat-${i % 7}`, id: `m${(i * 7919) % 3000}`, timestamp: (i * 104729) % 100_000, ...(i % 500 ? {} : { card: { kind: "task" } }) });
      for (let i = 0; i < 50; i++) s.proofs.put({ secret: `s${i}`, amount: 50 - i });
      for (let i = 0; i < 3; i++) s.log.add({ i });
    });
    await store.compact();
    await store.close();

    const probe = await db(new (await import("fake-indexeddb")).IDBFactory());
    const rawStore = (probe.transaction("messages").objectStore("messages") as unknown as { _rawObjectStore: object })._rawObjectStore;
    const storeRecord = vi.spyOn(Object.getPrototypeOf(rawStore) as { storeRecord(...args: unknown[]): unknown }, "storeRecord");
    // Nor one checked `cmp` per key compared: these are strings, numbers and arrays of them, ordered directly.
    const cmp = vi.spyOn((await import("fake-indexeddb")).IDBFactory.prototype, "cmp");
    let again: IDBDatabase;
    try {
      const factory = await open(dir);
      expect(storeRecord.mock.calls.length).toBe(0);
      expect(cmp.mock.calls.length).toBe(0);
      cmp.mockRestore();
      again = await new Promise<IDBDatabase>((resolve) => { const request = factory.open("ghostly", 2); request.onsuccess = () => resolve(request.result); });
    } finally { storeRecord.mockRestore(); cmp.mockRestore(); }

    const messages = () => again.transaction("messages").objectStore("messages");
    expect(await read(messages().count())).toBe(3000);
    const chat3 = await read(messages().index("byLinkTime").getAll(IDBKeyRange.bound(["chat-3", -Infinity], ["chat-3", Infinity]))) as { timestamp: number }[];
    expect(chat3.map((m) => m.timestamp)).toEqual(chat3.map((m) => m.timestamp).sort((a, b) => a - b));
    expect(chat3).toHaveLength(Array.from({ length: 3000 }, (_, i) => i).filter((i) => i % 7 === 3).length);
    expect(await read(messages().index("byLink").getAllKeys("chat-0"))).toHaveLength(429);
    expect(await read(messages().index("byCard").count())).toBe(6);
    expect(await read(again.transaction("proofs").objectStore("proofs").index("byAmount").getAllKeys())).toEqual(Array.from({ length: 50 }, (_, i) => `s${49 - i}`));

    // Still a working tree: writes, deletes and a unique index's refusal after it.
    await tx(again, ["messages", "log"], (s) => {
      for (let i = 0; i < 500; i++) s.messages.delete([`chat-${i % 7}`, `m${(i * 7919) % 3000}`]);
      s.messages.put({ linkId: "chat-0", id: "new", timestamp: -1 });
      s.log.add({ i: 3 });
    });
    expect(await read(messages().count())).toBe(2501);
    expect((await read(messages().index("byLinkTime").get(IDBKeyRange.bound(["chat-0", -Infinity], ["chat-0", Infinity]))) as { id: string }).id).toBe("new");
    expect(await read(again.transaction("log").objectStore("log").getAllKeys())).toEqual([1, 2, 3, 4]);
    await expect(tx(again, ["proofs"], (s) => { s.proofs.put({ secret: "dup", amount: 7 }); })).rejects.toThrow();
  });

  it("orders stored keys as IndexedDB does, and leaves what it does not order itself to cmp", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const factory = new IDBFactory(), cmp = vi.fn((a: unknown, b: unknown) => factory.cmp(a, b)), order = keyOrder(cmp);
    const plain: unknown[] = [-Infinity, -1, -0, 0, 0.5, 2, 10, Infinity, "", "10", "2", "a", "a\u0000", "ab", "b", "\ud83d\ude00", "\uffff",
      [], [0], [0, 0], [0, "a"], [1], ["a"], ["a", 1], ["a", "b"], ["a", [1]], ["a", [1, 2]], ["b"], [[]], [[], 1], [["a"]]];
    for (const a of plain) for (const b of plain) expect(order(a, b), `${JSON.stringify(a)} against ${JSON.stringify(b)}`).toBe(factory.cmp(a, b));
    expect(cmp).not.toHaveBeenCalled();
    // A date, bytes, and an array that holds one: cmp's, with the same answer.
    const other: unknown[] = [new Date(5), new Date(7), new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer, ["a", new Date(5)], ["a", new Date(7)], [new Uint8Array([9]).buffer]];
    for (const a of [...plain, ...other]) for (const b of other) {
      expect(order(a, b), `${String(a)} against ${String(b)}`).toBe(factory.cmp(a, b));
      expect(order(b, a), `${String(b)} against ${String(a)}`).toBe(factory.cmp(b, a));
    }
    expect(cmp).toHaveBeenCalled();
    // Not a key: refused as cmp refuses it.
    expect(() => order(NaN, 1)).toThrow();
    expect(() => order({}, "a")).toThrow();
  });

  it("leaves the snapshot as it is at open when no journal follows it", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    await tx(await db(store.factory), ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    await store.close();
    const written = statSync(join(dir, "snapshot.bin")).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await db(await open(dir));
    expect(statSync(join(dir, "snapshot.bin")).mtimeMs).toBe(written);
    expect(await read(again.transaction("messages").objectStore("messages").count())).toBe(1);
  });

  it("still restores a snapshot whose records are not in key order", async () => {
    const dir = folder();
    const { serialize } = await import("node:v8");
    writeFileSync(join(dir, "snapshot.bin"), serialize({ format: 1, databases: [{ name: "ghostly", version: 1, stores: [
      { name: "messages", keyPath: ["linkId", "id"], autoIncrement: false, keyGenerator: null, indexes: [{ name: "byLink", keyPath: "linkId", multiEntry: false, unique: false }],
        records: [[["b", "1"], { linkId: "b", id: "1" }], [["a", "2"], { linkId: "a", id: "2" }], [["a", "1"], { linkId: "a", id: "1" }]] },
      { name: "settings", keyPath: null, autoIncrement: false, keyGenerator: null, indexes: [], records: [] },
      { name: "log", keyPath: null, autoIncrement: true, keyGenerator: 1, indexes: [], records: [] },
    ] }] }));
    const d = await db(await open(dir));
    expect(await read(d.transaction("messages").objectStore("messages").getAllKeys())).toEqual([["a", "1"], ["a", "2"], ["b", "1"]]);
    expect(await read(d.transaction("messages").objectStore("messages").index("byLink").getAllKeys("a"))).toEqual([["a", "1"], ["a", "2"]]);
  });

  it("refuses a snapshot from a newer format instead of starting empty", async () => {
    const dir = folder();
    const { serialize } = await import("node:v8");
    writeFileSync(join(dir, "snapshot.bin"), serialize({ format: 4, databases: [] }));
    await expect(openPersistentIndexedDb(dir)).rejects.toThrow(/newer/);
    expect(readFileSync(join(dir, "snapshot.bin")).length).toBeGreaterThan(0);
  });

  /** A database with every shape of index the engine and the wallets use: compound, nested, unique, multi-entry. */
  async function indexed(factory: IDBFactory): Promise<IDBDatabase> {
    (await db(factory)).close();
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("ghostly", 2);
      request.onupgradeneeded = () => {
        const messages = request.transaction!.objectStore("messages");
        messages.createIndex("byLinkTime", ["linkId", "timestamp"]);
        messages.createIndex("byCard", "card.kind");
        request.result.createObjectStore("proofs", { keyPath: "secret" }).createIndex("byAmount", "amount", { unique: true });
        const notes = request.result.createObjectStore("notes", { autoIncrement: true });
        notes.createIndex("byTag", "tags", { multiEntry: true });
        notes.createIndex("byOwner", "owner");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  it("keeps every index in step with its store through overwrites, deletes, refused puts and aborted transactions", async () => {
    const factory = await open(folder());
    const d = await indexed(factory);
    let seed = 69;
    const random = (below: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % below; };
    const schema: Record<string, { name: string; path: string | string[]; multiEntry?: boolean }[]> = {
      messages: [{ name: "byLink", path: "linkId" }, { name: "byLinkTime", path: ["linkId", "timestamp"] }, { name: "byCard", path: "card.kind" }],
      proofs: [{ name: "byAmount", path: "amount" }],
      notes: [{ name: "byTag", path: "tags", multiEntry: true }, { name: "byOwner", path: "owner" }],
    };
    const at = (value: unknown, path: string) => path.split(".").reduce<unknown>((object, step) => (object as Record<string, unknown> | undefined)?.[step], value);
    /** What an index must hold for a store's records: [index key, primary key] in the index's order. */
    const expected = (index: { path: string | string[]; multiEntry?: boolean }, keys: IDBValidKey[], values: unknown[]) => {
      const entries: [IDBValidKey, IDBValidKey][] = [];
      values.forEach((value, i) => {
        const key = Array.isArray(index.path) ? index.path.map((path) => at(value, path)) : at(value, index.path);
        if (key === undefined || (Array.isArray(key) && !index.multiEntry && key.includes(undefined))) return;
        for (const one of index.multiEntry && Array.isArray(key) ? [...new Set(key)] : [key]) entries.push([one as IDBValidKey, keys[i]]);
      });
      return entries.sort((a, b) => factory.cmp(a[0], b[0]) || factory.cmp(a[1], b[1]));
    };
    const held = async (store: IDBObjectStore, name: string) => {
      const entries: [IDBValidKey, IDBValidKey][] = [];
      await new Promise<void>((resolve, reject) => {
        const request = store.index(name).openKeyCursor();
        request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve(); entries.push([cursor.key, cursor.primaryKey]); cursor.continue(); };
        request.onerror = () => reject(request.error);
      });
      return entries;
    };
    const check = async () => {
      for (const [name, indexes] of Object.entries(schema)) {
        const store = d.transaction(name).objectStore(name);
        const [keys, values] = [await read(store.getAllKeys()), await read(store.getAll())];
        for (const index of indexes) expect(await held(d.transaction(name).objectStore(name), index.name), `${name}.${index.name}`).toEqual(expected(index, keys, values));
      }
    };
    const message = () => ({ linkId: `chat-${random(4)}`, id: `m${random(60)}`, ...(random(5) ? { timestamp: random(1000) } : {}), ...(random(3) ? {} : { card: { kind: ["task", "usage"][random(2)] } }) });
    const tags = () => Array.from({ length: random(4) }, () => `t${random(5)}`);

    let aborted = 0, refused = 0;
    for (let round = 0; round < 120; round++) {
      const abort = random(6) === 0;
      const t = d.transaction(["messages", "proofs", "notes"], "readwrite");
      const done = new Promise<boolean>((resolve) => { t.oncomplete = () => resolve(true); t.onabort = () => resolve(false); });
      for (let op = 0; op < 12; op++) {
        const kind = random(10);
        if (kind < 4) t.objectStore("messages").put(message());
        else if (kind === 4) t.objectStore("messages").delete([`chat-${random(4)}`, `m${random(60)}`]);
        else if (kind === 5 && random(4) === 0) { const chat = `chat-${random(4)}`; t.objectStore("messages").delete(IDBKeyRange.bound([chat, "m1"], [chat, "m3"])); }
        else if (kind === 6) {
          // Amounts collide: the unique index refuses some, and the request's handler keeps the transaction going.
          const request = t.objectStore("proofs").put({ secret: `s${random(30)}`, amount: random(40) });
          request.onerror = (event) => { refused++; event.preventDefault(); event.stopPropagation(); };
        } else if (kind === 7) t.objectStore("proofs").delete(`s${random(30)}`);
        else if (kind === 8) t.objectStore("notes").put({ owner: `o${random(3)}`, tags: tags() }, random(3) ? 1 + random(40) : undefined);
        else t.objectStore("notes").delete(random(4) ? 1 + random(40) : IDBKeyRange.bound(1 + random(20), 25 + random(20)));
      }
      if (abort) t.abort();
      if (!(await done)) aborted++;
      if (round % 10 === 9) await check();
    }
    await check();
    expect(aborted).toBeGreaterThan(5);
    expect(refused).toBeGreaterThan(5);
    expect(await read(d.transaction("messages").objectStore("messages").count())).toBeGreaterThan(10);
  });

  it("writes over a message in the time of a new one, however many messages the profile's other chats hold", async () => {
    const d = await indexed(await open(folder()));
    for (let from = 0; from < 20_000; from += 5000) {
      await tx(d, ["messages"], (s) => {
        for (let i = from; i < from + 5000; i++) s.messages.put({ linkId: `chat-${i % 10}`, id: `m${i}`, timestamp: i, text: "x".repeat(40) });
      });
    }
    // A sent message is written again for each step of its delivery; a walk of the indexes took about 70 ms each here.
    await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "new", id: "only", timestamp: 1, status: "sending" }); });
    const started = performance.now();
    await tx(d, ["messages"], (s) => {
      for (let i = 0; i < 60; i++) s.messages.put({ linkId: "new", id: "only", timestamp: 1, status: `step-${i}` });
      for (let i = 0; i < 20; i++) s.messages.delete(["chat-3", `m${3 + 10 * i}`]);
    });
    const took = performance.now() - started;
    const messages = () => d.transaction("messages").objectStore("messages");
    expect(await read(messages().index("byLink").getAll("new"))).toEqual([{ linkId: "new", id: "only", timestamp: 1, status: "step-59" }]);
    expect(await read(messages().index("byLinkTime").count(IDBKeyRange.bound(["chat-3", -Infinity], ["chat-3", Infinity])))).toBe(1980);
    expect(await read(messages().count())).toBe(19_981);
    expect(took).toBeLessThan(1500);
  }, 60_000);
  /** A journal as a killed process leaves it: one entry per transaction, each a list of ops. */
  function journalOf(...entries: unknown[][]): Buffer {
    return Buffer.concat(entries.map((ops) => { const body = serialize(ops); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); }));
  }

  it("brings the indexes in step with what a journal changed: overwrites, deletes, a range, a clear, a unique key that moved", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await indexed(store.factory);
    await tx(first, ["messages", "proofs", "notes"], (s) => {
      for (let i = 0; i < 40; i++) s.messages.put({ linkId: `chat-${i % 4}`, id: `m${i}`, timestamp: i, ...(i % 5 === 0 && { card: { kind: "task" } }) });
      for (let i = 1; i <= 4; i++) s.proofs.put({ secret: `s${i}`, amount: i });
      s.notes.put({ owner: "ana", tags: ["a", "b"] });
      s.notes.put({ owner: "bob", tags: ["b"] });
    });
    first.close();
    await store.compact();
    await store.close();

    const put = (storeName: string, key: unknown, value: unknown) => ({ db: "ghostly", store: storeName, kind: "put", key, value });
    const gone = (storeName: string, key: unknown) => ({ db: "ghostly", store: storeName, kind: "delete", key });
    writeFileSync(join(dir, "journal.bin"), journalOf(
      // A message written again with another time and a card, twice; one removed; one removed and written back.
      [put("messages", ["chat-1", "m1"], { linkId: "chat-1", id: "m1", timestamp: 500, card: { kind: "poll" } })],
      [put("messages", ["chat-1", "m1"], { linkId: "chat-1", id: "m1", timestamp: 600, card: { kind: "poll" } }), gone("messages", ["chat-0", "m0"])],
      [gone("messages", ["chat-2", "m2"]), put("messages", ["chat-2", "m2"], { linkId: "chat-2", id: "m2", timestamp: 2, text: "back" })],
      // A whole chat removed by range, then one new message in it; a key that was never there removed.
      [gone("messages", { __ghostlyRange: { lower: ["chat-3", ""], upper: ["chat-3", "\uffff"], lowerOpen: false, upperOpen: false } }), gone("messages", ["nobody", "x"])],
      [put("messages", ["chat-3", "new"], { linkId: "chat-3", id: "new", timestamp: 9 })],
      // A unique key that moves from one proof to another, and a store cleared and filled again.
      [gone("proofs", "s1"), put("proofs", "s9", { secret: "s9", amount: 1 }), put("proofs", "s2", { secret: "s2", amount: 20 })],
      [{ db: "ghostly", store: "notes", kind: "clear" }, put("notes", 7, { owner: "cid", tags: ["c", "a"] })],
    ));

    const second = await db(await open(dir), "ghostly", 2);
    const messages = () => second.transaction("messages").objectStore("messages");
    const all = await read(messages().getAll()) as { linkId: string; id: string; timestamp: number; card?: { kind: string } }[];
    expect(all).toHaveLength(40 - 1 - 10 + 1);
    // Every index says what a walk of the store says, and nothing else.
    for (const chat of ["chat-0", "chat-1", "chat-2", "chat-3", "nobody"]) {
      const held = all.filter((m) => m.linkId === chat);
      expect(await read(messages().index("byLink").getAll(chat))).toEqual(held);
      expect(await read(messages().index("byLinkTime").getAll(IDBKeyRange.bound([chat, -Infinity], [chat, Infinity])))).toEqual([...held].sort((a, b) => a.timestamp - b.timestamp));
    }
    expect(await read(messages().index("byLink").count())).toBe(all.length);
    expect(await read(messages().index("byLinkTime").count())).toBe(all.length);
    expect(await read(messages().index("byCard").getAllKeys("poll"))).toEqual([["chat-1", "m1"]]);
    expect(await read(messages().index("byCard").count())).toBe(all.filter((m) => m.card).length);
    const proofs = () => second.transaction("proofs").objectStore("proofs").index("byAmount");
    expect(await read(proofs().getAllKeys())).toEqual(["s9", "s3", "s4", "s2"]);
    expect(((await read(proofs().get(1))) as { secret: string }).secret).toBe("s9");
    const notes = () => second.transaction("notes").objectStore("notes");
    expect(await read(notes().index("byTag").getAllKeys())).toEqual([7, 7]);
    expect(await read(notes().index("byTag").count("b"))).toBe(0);
    expect(await read(notes().index("byOwner").getAllKeys())).toEqual([7]);
    // And the store takes writes as before: the unique key is free where it left, taken where it went.
    await tx(second, ["proofs"], (s) => { s.proofs.put({ secret: "s10", amount: 2 }); });
    await expect(tx(second, ["proofs"], (s) => { s.proofs.add({ secret: "s11", amount: 1 }); })).rejects.toBeDefined();
  });

  it("replays a journal the snapshot already holds (killed between the two): rows that are there, a unique key that moved", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await indexed(store.factory);
    await tx(first, ["proofs", "messages"], (s) => {
      s.proofs.put({ secret: "s9", amount: 1 });
      s.messages.put({ linkId: "a", id: "2", timestamp: 2 });
    });
    first.close();
    await store.compact();
    await store.close();
    // The snapshot is the state after these: s1 held the amount, then s9 took it; a message came and went.
    writeFileSync(join(dir, "journal.bin"), journalOf(
      [{ db: "ghostly", store: "proofs", kind: "put", key: "s1", value: { secret: "s1", amount: 1 } }, { db: "ghostly", store: "messages", kind: "put", key: ["a", "1"], value: { linkId: "a", id: "1", timestamp: 1 } }],
      [{ db: "ghostly", store: "proofs", kind: "delete", key: "s1" }, { db: "ghostly", store: "proofs", kind: "put", key: "s9", value: { secret: "s9", amount: 1 } }],
      [{ db: "ghostly", store: "messages", kind: "delete", key: ["a", "1"] }, { db: "ghostly", store: "messages", kind: "put", key: ["a", "2"], value: { linkId: "a", id: "2", timestamp: 2 } }],
    ));
    const second = await db(await open(dir), "ghostly", 2);
    expect(await read(second.transaction("proofs").objectStore("proofs").index("byAmount").getAllKeys())).toEqual(["s9"]);
    expect(await read(second.transaction("messages").objectStore("messages").index("byLinkTime").getAllKeys())).toEqual([["a", "2"]]);
    expect(await read(second.transaction("messages").objectStore("messages").index("byLink").count())).toBe(1);
  });

  it("replays a journal of one message at the cost of one message, however many the store holds", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await indexed(store.factory);
    for (let from = 0; from < 20_000; from += 5000) {
      await tx(first, ["messages"], (s) => {
        for (let i = from; i < from + 5000; i++) s.messages.put({ linkId: `chat-${i % 10}`, id: `m${i}`, timestamp: i, text: "x".repeat(40) });
      });
    }
    const rawStore = (first.transaction("messages").objectStore("messages") as unknown as { _rawObjectStore: { rawIndexes: Map<string, object> } })._rawObjectStore;
    first.close();
    await store.compact();
    await store.close();
    // The same start twice: a journal that touches a store with no index, then one that touches the messages. The
    // indexes of every message were built again for the second, once each. What is counted is the records an index is
    // handed, not the time the start takes: two times of one run differ by more than any margin on a busy machine.
    const indexRecord = vi.spyOn(Object.getPrototypeOf(rawStore.rawIndexes.get("byLink")) as { storeRecord(...args: unknown[]): unknown }, "storeRecord");
    const start = async (journal: Buffer) => {
      writeFileSync(join(dir, "journal.bin"), journal);
      indexRecord.mockClear();
      await (await openPersistentIndexedDb(dir)).close();
      return indexRecord.mock.calls.length;
    };
    let plain: number, touched: number;
    try {
      plain = await start(journalOf([{ db: "ghostly", store: "settings", kind: "put", key: "name", value: "Alice" }]));
      touched = await start(journalOf([{ db: "ghostly", store: "messages", kind: "put", key: ["chat-1", "m1"], value: { linkId: "chat-1", id: "m1", timestamp: 1, text: "edited" } }]));
    } finally { indexRecord.mockRestore(); }
    const d = await db(await open(dir), "ghostly", 2);
    expect(await read(d.transaction("messages").objectStore("messages").index("byLinkTime").count())).toBe(20_000);
    expect(((await read(d.transaction("messages").objectStore("messages").index("byLink").get("chat-1"))) as { text: string }).text).toBe("edited");
    // The message as it was leaves the two indexes that hold it and the message as it is comes into them: four records.
    expect(touched - plain).toBeLessThanOrEqual(4);
  }, 60_000);
  /** The profile's folder as a kill leaves it: what is on disk now, with the store still open. */
  const killed = (dir: string) => { const copy = folder(); cpSync(dir, copy, { recursive: true }); return copy; };
  /** The journal's entries, each a list of ops. */
  function entriesOf(dir: string): { db: string; store: string; kind: string }[][] {
    const journal = readFileSync(join(dir, "journal.bin")), entries = [];
    for (let at = 0; at < journal.length; at += 4 + journal.readUInt32BE(at)) entries.push(deserialize(journal.subarray(at + 4, at + 4 + journal.readUInt32BE(at))));
    return entries;
  }
  const count = (d: IDBDatabase, index = "byLink") => read(d.transaction("messages").objectStore("messages").index(index).count());

  it("leaves a short journal at close and at the next start: the snapshot is not written again for a few rows", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    const d = await db(first.factory);
    await first.flush();
    const snapshot = () => statSync(join(dir, "snapshot.bin")).mtimeMs;
    const written = snapshot();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    // A relaxed entry waits for a sync: the close brings it, one sync for the entry and the mark.
    const relaxed = d.transaction("settings", "readwrite", { durability: "relaxed" });
    relaxed.objectStore("settings").put("seen", "m1");
    await new Promise<void>((resolve) => { relaxed.oncomplete = () => resolve(); });
    const before = syncs.count;
    await first.close();
    expect(syncs.count - before).toBe(1);
    expect(snapshot()).toBe(written);
    expect(first.journalBytes()).toBeGreaterThan(0);
    expect(statSync(join(dir, "journal.bin")).mode & 0o777).toBe(0o600);
    // The mark names a database no profile has: a version that knows nothing of it finds no store for it, and skips it.
    expect(entriesOf(dir).at(-1)).toEqual([{ db: "__ghostly_closed__", store: "", kind: "clear" }]);

    const second = await openPersistentIndexedDb(dir);
    expect(second.recovered).toBe(false);
    expect(snapshot()).toBe(written);
    const again = await db(second.factory);
    expect(await count(again)).toBe(1);
    expect(await read(again.transaction("settings").objectStore("settings").get("m1"))).toBe("seen");
    await tx(again, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "2" }); s.messages.delete(["a", "1"]); });
    await second.close();
    expect(snapshot()).toBe(written);

    const third = await openPersistentIndexedDb(dir);
    opened.push(third);
    expect(third.recovered).toBe(false);
    expect(await read((await db(third.factory)).transaction("messages").objectStore("messages").index("byLink").getAllKeys())).toEqual([["a", "2"]]);
  });

  it("writes nothing at close when nothing was written since the journal's mark", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    await tx(await db(first.factory), ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    await first.close();
    const journal = readFileSync(join(dir, "journal.bin"));

    const second = await openPersistentIndexedDb(dir);
    expect(await count(await db(second.factory))).toBe(1);
    const before = syncs.count;
    await second.close();
    expect(syncs.count - before).toBe(0);
    expect(readFileSync(join(dir, "journal.bin")).equals(journal)).toBe(true);
    // Nor with no journal at all: a store that was folded and only read.
    const third = await openPersistentIndexedDb(dir);
    await third.compact();
    await third.close();
    const fourth = await openPersistentIndexedDb(dir);
    expect(fourth.recovered).toBe(false);
    const folded = syncs.count;
    await fourth.close();
    expect(syncs.count - folded).toBe(0);
    expect(fourth.journalBytes()).toBe(0);
  });

  it("says a store was not closed when its journal has no mark at its end, until the next close", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    opened.push(first);
    const d = await db(first.factory);
    await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    // Killed after its first write, with the journal never closed.
    const afterOne = killed(dir);
    await first.close();
    const reopened = await openPersistentIndexedDb(dir);
    opened.push(reopened);
    await tx(await db(reopened.factory), ["messages"], (s) => { s.messages.put({ linkId: "a", id: "2" }); });
    // Killed after a write that came behind an older close mark: the mark is not the journal's end any more.
    const afterMark = killed(dir);

    for (const [copy, rows] of [[afterOne, 1], [afterMark, 2]] as const) {
      const written = statSync(join(copy, "snapshot.bin")).mtimeMs;
      const second = await openPersistentIndexedDb(copy);
      expect(second.recovered).toBe(true);
      expect(await count(await db(second.factory))).toBe(rows);
      // Whole and short: the journal stays, and this close marks it.
      expect(statSync(join(copy, "snapshot.bin")).mtimeMs).toBe(written);
      expect(second.journalBytes()).toBeGreaterThan(0);
      await second.close();
      const third = await openPersistentIndexedDb(copy);
      expect(third.recovered).toBe(false);
      expect(await count(await db(third.factory))).toBe(rows);
      await third.close();
    }
  });

  it("folds a journal cut short before anything is appended to it: what is written after a torn entry is read back", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    await tx(await db(first.factory), ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    await first.close();
    // Killed while it wrote an entry, and killed while it wrote the close mark itself.
    const tornEntry = killed(dir), tornMark = killed(dir);
    const header = Buffer.alloc(4); header.writeUInt32BE(1000);
    appendFileSync(join(tornEntry, "journal.bin"), Buffer.concat([header, Buffer.from("partial")]));
    truncateSync(join(tornMark, "journal.bin"), statSync(join(tornMark, "journal.bin")).size - 3);

    for (const copy of [tornEntry, tornMark]) {
      const second = await openPersistentIndexedDb(copy);
      opened.push(second);
      expect(second.recovered).toBe(true);
      expect(second.journalBytes()).toBe(0);
      await tx(await db(second.factory), ["messages"], (s) => { s.messages.put({ linkId: "a", id: "2" }); });
      // Killed again: the new entry is the first thing in its journal, not something behind torn bytes.
      const third = await openPersistentIndexedDb(killed(copy));
      expect(third.recovered).toBe(true);
      expect(await count(await db(third.factory))).toBe(2);
      await third.close();
    }
  });

  it("folds a journal past a megabyte, at close and at a start that finds one", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    opened.push(first);
    const d = await db(first.factory);
    for (let i = 0; i < 6; i++) await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: `m${i}`, text: "x".repeat(200_000) }); });
    expect(first.journalBytes()).toBeGreaterThan(1024 * 1024);
    const long = killed(dir);
    await first.close();
    expect(first.journalBytes()).toBe(0);

    const second = await openPersistentIndexedDb(long);
    expect(second.recovered).toBe(true);
    expect(second.journalBytes()).toBe(0);
    expect(await count(await db(second.factory))).toBe(6);
    await second.close();
    for (const folderOf of [dir, long]) {
      const third = await openPersistentIndexedDb(folderOf);
      expect(third.recovered).toBe(false);
      expect(await count(await db(third.factory))).toBe(6);
      await third.close();
    }
  });
  it("does not replay a journal over a snapshot that holds it already: one that names another snapshot is left out", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    await tx(await db(first.factory), ["settings"], (s) => { s.settings.put("v1", "kept"); s.settings.put("v1", "spent"); });
    await first.close();
    const journal = readFileSync(join(dir, "journal.bin"));
    // The next process rewrites one row and removes the other (as an upgrade does), and folds.
    const second = await openPersistentIndexedDb(dir);
    await tx(await db(second.factory), ["settings"], (s) => { s.settings.put("v2", "kept"); s.settings.delete("spent"); });
    await second.compact();
    await second.close();
    // Killed between the snapshot's rename and the journal's unlink: the new snapshot, with the journal it folded.
    writeFileSync(join(dir, "journal.bin"), journal);

    const third = await openPersistentIndexedDb(dir);
    expect(third.recovered).toBe(true);
    expect(third.journalBytes()).toBe(0);
    const settings = (await db(third.factory)).transaction("settings").objectStore("settings");
    expect(await read(settings.get("kept"))).toBe("v2");
    expect(await read(settings.get("spent"))).toBeUndefined();
    await third.close();
    const fourth = await openPersistentIndexedDb(dir);
    expect(fourth.recovered).toBe(false);
    await fourth.close();
  });

  it("folds a journal that names no snapshot (an older version's), and keeps the next one", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    (await db(first.factory)).close();
    await first.close();
    writeFileSync(join(dir, "journal.bin"), journalOf([{ db: "ghostly", store: "settings", kind: "put", key: "name", value: "Alice" }]));
    const second = await openPersistentIndexedDb(dir);
    expect(second.recovered).toBe(true);
    expect(second.journalBytes()).toBe(0);
    const d = await db(second.factory);
    expect(await read(d.transaction("settings").objectStore("settings").get("name"))).toBe("Alice");
    await tx(d, ["settings"], (s) => { s.settings.put("Bob", "name"); });
    await second.close();
    expect(entriesOf(dir)[0]).toMatchObject([{ db: "__ghostly_journal__", kind: "clear" }]);
    const written = statSync(join(dir, "snapshot.bin")).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = await openPersistentIndexedDb(dir);
    expect(statSync(join(dir, "snapshot.bin")).mtimeMs).toBe(written);
    expect(await read((await db(third.factory)).transaction("settings").objectStore("settings").get("name"))).toBe("Bob");
    await third.close();
  });

  it("writes the whole store at close after a write that failed: what is held reaches the disk", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const dir = folder();
      const first = await openPersistentIndexedDb(dir);
      // The snapshot of a new database's stores cannot be written (a full disk): rows for stores no snapshot has.
      faults.rename = true;
      const d = await db(first.factory);
      await first.flush();
      faults.rename = false;
      expect(stderr.mock.calls.join("")).toContain("storage write failed");
      await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); s.messages.put({ linkId: "a", id: "2" }); });
      await first.close();
      expect(first.journalBytes()).toBe(0);
      const second = await openPersistentIndexedDb(dir);
      expect(await count(await db(second.factory))).toBe(2);
      // And a fold someone asked for says that it failed: a backup does not copy an older snapshot as if it were whole.
      faults.rename = true;
      await expect(second.compact()).rejects.toThrow("ENOSPC");
      faults.rename = false;
      await second.close();
    } finally { faults.rename = false; stderr.mockRestore(); }
  });

  it("writes a journal entry whole when the disk takes it in parts: the entries behind it are read back", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    opened.push(first);
    const d = await db(first.factory);
    await first.flush();
    await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    faults.short = true;
    await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "2" }); });
    expect(faults.short).toBe(false);
    await tx(d, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "3" }); });
    const second = await openPersistentIndexedDb(killed(dir));
    expect(await count(await db(second.factory))).toBe(3);
    await second.close();
  });
});

/**
 * The engine's messages and their indexes are kept in rows.db (SQLite), not in memory: the store's tree and its
 * indexes' are SQL trees, and the snapshot (format 3) says only that they are there. A daemon held every message of
 * its history in memory, about 1.3 KB each.
 */
describe("messages kept in rows.db", () => {
  const copyOf = (dir: string) => { const copy = folder(); cpSync(dir, copy, { recursive: true }); return copy; };
  /** The messages store's entries in rows.db (`idx` "" is the store's own tree, else an index's). */
  const entryCount = async (dir: string, idx = "") => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = new DatabaseSync(join(dir, "rows.db"));
    try { return Number((file.prepare("SELECT count(*) AS n FROM entries e JOIN trees t ON e.tree = t.id WHERE t.store = 'messages' AND t.idx = ?").get(idx) as { n: number }).n); } finally { file.close(); }
  };
  const snapshotOf = (dir: string) => deserialize(readFileSync(join(dir, "snapshot.bin"))) as { format: number; databases: { name: string; stores: { name: string; records: unknown[]; onDisk?: boolean }[] }[] };
  const messagesIn = (dir: string) => snapshotOf(dir).databases.find((d) => d.name === "ghostly")!.stores.find((s) => s.name === "messages")!;
  const rawMessages = (factory: IDBFactory) => (factory as unknown as { _databases: Map<string, { rawObjectStores: Map<string, { records: { records: object } }> }> })._databases.get("ghostly")!.rawObjectStores.get("messages")!.records;
  const message = (i: number) => ({ linkId: `chat-${i % 3}`, id: `m${String(i).padStart(3, "0")}`, timestamp: 1000 + i, text: `message ${i} `.repeat(20), ...(i % 4 ? {} : { card: { kind: "task" } }) });
  /** Every message, read on a connection of its own, closed after (an open one would hold back an upgrade). */
  const all = async (factory: IDBFactory) => { const d = await db(factory); try { return await read(d.transaction("messages").objectStore("messages").getAll()); } finally { d.close(); } };
  const upgrade = (factory: IDBFactory, version: number, work: (t: IDBTransaction) => void) => new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("ghostly", version);
    request.onupgradeneeded = () => work(request.transaction!);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  it("keeps the messages and their index entries in rows.db; the snapshot says only that they are there; a restart reads the same", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    for (let i = 0; i < 20; i++) await tx(await db(store.factory), ["messages", "settings"], (s) => { s.messages.put(message(i)); s.settings.put({ v: i }, "k"); });
    expect(rawMessages(store.factory).records.constructor.name).toBe("SqlTree");
    const before = await all(store.factory);
    expect(before).toHaveLength(20);
    expect(await entryCount(dir)).toBe(20);
    expect(await entryCount(dir, "byLink")).toBe(20);
    await store.compact();
    expect(snapshotOf(dir).format).toBe(3);
    expect(messagesIn(dir)).toMatchObject({ records: [], onDisk: true });
    // Other stores keep their values inline.
    expect(snapshotOf(dir).databases[0]!.stores.find((s) => s.name === "settings")!.records).toEqual([["k", { v: 19 }]]);
    await store.close();

    const again = await openPersistentIndexedDb(dir);
    opened.push(again);
    expect(await all(again.factory)).toEqual(before);
    expect(await read((await db(again.factory)).transaction("messages").objectStore("messages").index("byLink").getAll("chat-1"))).toEqual(before.filter((m) => (m as { linkId: string }).linkId === "chat-1"));
  });

  it("after a crash, replays what SQLite did not take, and skips what it did", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    opened.push(store);
    const d = await db(store.factory);
    for (let i = 0; i < 10; i++) await tx(d, ["messages"], (s) => { s.messages.put(message(i)); });
    await store.compact();
    for (let i = 0; i < 5; i++) await tx(d, ["messages"], (s) => { s.messages.put({ ...message(i), text: "edited" }); });
    await tx(d, ["messages"], (s) => { s.messages.delete(["chat-0", "m006"]); s.messages.delete(IDBKeyRange.bound(["chat-1", "m007"], ["chat-1", "m007"])); });
    // SQLite fails to take the last one: the journal has it, the layer stays in memory, reads find it.
    const apply = vi.spyOn(TreeFile.prototype, "apply").mockImplementationOnce(() => { throw new Error("SQLITE_IOERR: disk I/O error"); });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try { await tx(d, ["messages"], (s) => { s.messages.put({ ...message(9), text: "late" }); }); } finally { apply.mockRestore(); stderr.mockRestore(); }
    const expected = await all(store.factory);
    expect(expected).toHaveLength(8);
    expect(expected.find((m) => (m as { id: string }).id === "m009")).toMatchObject({ text: "late" });
    const crashed = copyOf(dir);
    expect(await entryCount(crashed)).toBe(8);

    const second = await openPersistentIndexedDb(crashed);
    opened.push(second);
    expect(second.recovered).toBe(true);
    expect(await all(second.factory)).toEqual(expected);
    // The index too: chat-1's messages by the index, as the store has them.
    expect((await read((await db(second.factory)).transaction("messages").objectStore("messages").index("byLink").getAll("chat-1"))).map((m) => (m as { id: string }).id)).toEqual(["m001", "m004"]);
    await second.compact();
    expect(await entryCount(crashed)).toBe(8);
    expect(await entryCount(crashed, "byLink")).toBe(8);
  });

  it("a cleared store, a deleted index and an aborted transaction leave nothing behind in rows.db", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    opened.push(store);
    let d = await db(store.factory);
    for (let i = 0; i < 6; i++) await tx(d, ["messages"], (s) => { s.messages.put(message(i)); });
    await tx(d, ["messages"], (s) => { s.messages.clear(); });
    await tx(d, ["messages"], (s) => { s.messages.put(message(99)); });
    // Aborted: none of its writes reaches rows.db, and reads never see them.
    const t = d.transaction("messages", "readwrite");
    t.objectStore("messages").put(message(50));
    t.objectStore("messages").delete(["chat-0", "m099"]);
    t.abort();
    await new Promise((resolve) => { t.onabort = resolve; });
    expect((await all(store.factory)).map((m) => (m as { id: string }).id)).toEqual(["m099"]);
    expect(await entryCount(dir)).toBe(1);
    d.close();
    d = await upgrade(store.factory, 2, (u) => { u.objectStore("messages").deleteIndex("byLink"); });
    d.close();
    await store.compact();
    expect(await entryCount(dir, "byLink")).toBe(0);
    expect(await entryCount(dir)).toBe(1);
  });

  it("a chat's deleted messages leave no copy of their text in the profile's files after the fold", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const d = await db(store.factory);
    const secret = (i: number) => ({ ...message(i), text: `deleted-secret-${i} `.repeat(20) });
    for (let i = 0; i < 12; i++) await tx(d, ["messages"], (s) => { s.messages.put(i % 3 === 1 ? secret(i) : message(i)); });
    await store.compact();
    // `chat remove`: the chat's key range; `message delete`: one key (here chat-1's, as db.deleteLink deletes them).
    await tx(d, ["messages"], (s) => { s.messages.delete(IDBKeyRange.bound(["chat-1"], ["chat-1", []])); });
    d.close();
    await store.compact();
    await store.close();
    expect(await entryCount(dir)).toBe(8);
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name)).includes("deleted-secret"), name).toBe(false);
  });

  it("an index added by an upgrade to a store that holds messages is built in rows.db, and kept across a restart", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const d = await db(store.factory);
    for (let i = 0; i < 12; i++) await tx(d, ["messages"], (s) => { s.messages.put(message(i)); });
    d.close();
    (await upgrade(store.factory, 2, (u) => { u.objectStore("messages").createIndex("byCard", "card.kind"); })).close();
    expect(await entryCount(dir, "byCard")).toBe(3);
    await store.close();
    const again = await openPersistentIndexedDb(dir);
    opened.push(again);
    const reopened = await upgrade(again.factory, 2, () => {});
    expect((await read(reopened.transaction("messages").objectStore("messages").index("byCard").getAll("task"))).map((m) => (m as { id: string }).id)).toEqual(["m000", "m004", "m008"]);
  });

  it("moves a profile of format 1 to rows.db at its first open, and exports format 1 with every value for a backup", async () => {
    const dir = folder();
    // As an older ghostly left it: every value inline.
    const old = await openPersistentIndexedDb(dir, { rowsOnDisk: () => false });
    for (let i = 0; i < 12; i++) await tx(await db(old.factory), ["messages"], (s) => { s.messages.put(message(i)); });
    const values = await all(old.factory);
    await old.compact();
    await old.close();
    expect(snapshotOf(dir).format).toBe(1);
    expect(messagesIn(dir).records).toHaveLength(12);

    const store = await openPersistentIndexedDb(dir);
    opened.push(store);
    expect(snapshotOf(dir).format).toBe(3);
    expect(messagesIn(dir).records).toEqual([]);
    expect(await entryCount(dir)).toBe(12);
    expect(await all(store.factory)).toEqual(values);

    // A backup's store: format 1, which any ghostly restores, with what rows.db held.
    const exported = join(folder(), "store.bin");
    await store.exportSnapshot(exported);
    const copy = folder();
    cpSync(exported, join(copy, "snapshot.bin"));
    expect(snapshotOf(copy).format).toBe(1);
    const elsewhere = await openPersistentIndexedDb(copy, { rowsOnDisk: () => false });
    opened.push(elsewhere);
    expect(await all(elsewhere.factory)).toEqual(values);
  });

  it("moves a profile of format 2 (values in rows, keys in the snapshot) to rows.db's trees, and drops the rows", async () => {
    const dir = folder();
    const value = { linkId: "a", id: "1", text: "from format 2" };
    const { DatabaseSync } = await import("node:sqlite");
    const file = new DatabaseSync(join(dir, "rows.db"));
    file.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
    file.prepare("INSERT INTO rows (id, value) VALUES (1, ?)").run(serialize(value));
    file.close();
    writeFileSync(join(dir, "snapshot.bin"), serialize({ format: 2, databases: [{ name: "ghostly", version: 1, stores: [
      { name: "messages", keyPath: ["linkId", "id"], autoIncrement: false, keyGenerator: null, indexes: [{ name: "byLink", keyPath: "linkId", multiEntry: false, unique: false }], records: [],
        rows: { keys: [["a", "1"]], ids: [1], inline: [], indexes: { byLink: [["a", 0]] } } },
      { name: "settings", keyPath: null, autoIncrement: false, keyGenerator: null, indexes: [], records: [] },
      { name: "log", keyPath: null, autoIncrement: true, keyGenerator: 1, indexes: [], records: [] },
    ] }] }));
    const store = await openPersistentIndexedDb(dir);
    opened.push(store);
    expect(await all(store.factory)).toEqual([value]);
    expect(snapshotOf(dir).format).toBe(3);
    expect(await entryCount(dir, "byLink")).toBe(1);
    const check = new DatabaseSync(join(dir, "rows.db"));
    try { expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'rows'").get()).toBeUndefined(); } finally { check.close(); }
  });

  it("refuses a snapshot that names rows.db when it is gone, instead of opening a profile with no messages, every time", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    await tx(await db(store.factory), ["messages"], (s) => { s.messages.put(message(1)); });
    await store.compact();
    await store.close();
    for (const file of ["rows.db", "rows.db-wal", "rows.db-shm"]) rmSync(join(dir, file), { force: true });
    await expect(openPersistentIndexedDb(dir)).rejects.toThrow(/missing rows\.db/);
    // Again: the open that failed left no empty rows.db for the next one to read as no messages.
    await expect(openPersistentIndexedDb(dir)).rejects.toThrow(/missing rows\.db/);
    // An empty one (as a half-failed attempt would leave): the same.
    writeFileSync(join(dir, "rows.db"), "");
    await expect(openPersistentIndexedDb(dir)).rejects.toThrow(/missing rows\.db/);
  });

  it("restores every index of a store kept on disk, cursors both ways", async () => {
    const dir = folder();
    const first = await openPersistentIndexedDb(dir);
    (await db(first.factory)).close();
    const d = await upgrade(first.factory, 2, (u) => { const m = u.objectStore("messages"); m.createIndex("byLinkTime", ["linkId", "timestamp"]); m.createIndex("byCard", "card.kind"); });
    for (let i = 0; i < 30; i++) await tx(d, ["messages"], (s) => { s.messages.put(message(29 - i)); });
    d.close();
    await first.compact();
    await first.close();

    const store = await openPersistentIndexedDb(dir);
    opened.push(store);
    const reopened = await upgrade(store.factory, 2, () => {});
    const messages = reopened.transaction("messages").objectStore("messages");
    const newest = await new Promise<string[]>((resolve, reject) => {
      const ids: string[] = [];
      const request = messages.index("byLinkTime").openCursor(IDBKeyRange.bound(["chat-2", 0], ["chat-2", Infinity]), "prev");
      request.onsuccess = () => { const cursor = request.result; if (!cursor || ids.length === 3) return resolve(ids); ids.push((cursor.value as { id: string }).id); cursor.continue(); };
      request.onerror = () => reject(request.error);
    });
    expect(newest).toEqual(["m029", "m026", "m023"]);
    expect((await read(messages.index("byCard").getAll("task"))).map((m) => (m as { id: string }).id)).toEqual(["m000", "m012", "m024", "m004", "m016", "m028", "m008", "m020"]);
    expect(await read(messages.index("byLink").count("chat-0"))).toBe(10);
  });
});
