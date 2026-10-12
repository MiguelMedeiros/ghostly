import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.storage

/** Every disk sync the store asks for. */
const syncs = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => { syncs.count++; fs.fsyncSync(fd); } };
});

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

  it("folds the journal into the snapshot on close, owner-only files", async () => {
    const dir = folder();
    const store = await openPersistentIndexedDb(dir);
    const first = await db(store.factory);
    await tx(first, ["messages"], (s) => { s.messages.put({ linkId: "a", id: "1" }); });
    expect(store.journalBytes()).toBeGreaterThan(0);
    expect(statSync(join(dir, "journal.bin")).mode & 0o777).toBe(0o600);
    await store.close();
    expect(store.journalBytes()).toBe(0);
    expect(statSync(join(dir, "snapshot.bin")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
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
    await store.close();

    const probe = await db(new (await import("fake-indexeddb")).IDBFactory());
    const rawStore = (probe.transaction("messages").objectStore("messages") as unknown as { _rawObjectStore: object })._rawObjectStore;
    const storeRecord = vi.spyOn(Object.getPrototypeOf(rawStore) as { storeRecord(...args: unknown[]): unknown }, "storeRecord");
    let again: IDBDatabase;
    try {
      const factory = await open(dir);
      expect(storeRecord.mock.calls.length).toBe(0);
      again = await new Promise<IDBDatabase>((resolve) => { const request = factory.open("ghostly", 2); request.onsuccess = () => resolve(request.result); });
    } finally { storeRecord.mockRestore(); }

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
    writeFileSync(join(dir, "snapshot.bin"), serialize({ format: 2, databases: [] }));
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
});
