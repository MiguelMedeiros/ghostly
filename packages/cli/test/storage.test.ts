import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.storage

const opened: PersistentIndexedDb[] = [];
afterEach(() => { opened.length = 0; });

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

  it("refuses a snapshot from a newer format instead of starting empty", async () => {
    const dir = folder();
    const { serialize } = await import("node:v8");
    writeFileSync(join(dir, "snapshot.bin"), serialize({ format: 2, databases: [] }));
    await expect(openPersistentIndexedDb(dir)).rejects.toThrow(/newer/);
    expect(readFileSync(join(dir, "snapshot.bin")).length).toBeGreaterThan(0);
  });
});
