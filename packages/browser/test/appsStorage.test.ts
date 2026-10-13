import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink } from "@ghostly/core";
import { DEFAULT_APP_STORES } from "../src/engine/appDefaults";
import { APP_SCOPE_ALONE, APP_STORAGE_LIMITS, type Apps } from "../src/engine/apps";
import { db } from "../src/engine/db";
import { GhostlyNode } from "../src/engine/node";
import { snapshotDatabase } from "../src/backup/database";
import { DB_VERSION, PROFILE_STORES, STORES, clearProfileStores, databaseName, openDb, wrap } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, STORE_URL, appRows, apps, bundle, bundleIds, emptyProfile, storageRows, storeFiles, type Built } from "./appsSupport";
// covers: apps.engine.storage, apps.engine.installed

/*
 * Each app's own storage (WISP 1200 § Permissions: 5 MiB per app and per chat, keys of 256 bytes, JSON values of 64 KiB,
 * each key counting 128 bytes and its own bytes eight times), uninstall, the database step that adds the apps' stores, what a backup carries, and the engine's flag.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** The apps' own rows: each scope's kept count left out. */
const ownRows = async () => (await storageRows() as { ref: string; scope: string; key: string }[]).filter((r) => r.key !== "");

/** What a key and a value of `valueBytes` take of a scope's 5 MiB. */
const cost = (key: string, valueBytes: number) => APP_STORAGE_LIMITS.rowBytes + APP_STORAGE_LIMITS.keyTimes * key.length + valueBytes;

async function installed(options: Parameters<typeof bundle>[0] = {}): Promise<{ store: Apps; app: Built }> {
  const app = await bundle(options);
  net.put(BUNDLE_URL, app.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: app.digest, grant: ["chat"] });
  return { store, app };
}

describe("storage", () => {
  it("keeps JSON per app and per chat: one chat's data is not another's", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    await store.storageSet({ ref, scope: "chat-1", key: "game", value: { moves: ["e4", "e5"], turn: 3 } });
    await store.storageSet({ ref, scope: APP_SCOPE_ALONE, key: "game", value: "solo" });
    expect(await store.storageGet({ ref, scope: "chat-1", key: "game" })).toEqual({ value: { moves: ["e4", "e5"], turn: 3 } });
    expect(await store.storageGet({ ref, scope: "chat-2", key: "game" })).toBeNull();
    expect(await store.storageGet({ ref, scope: APP_SCOPE_ALONE, key: "game" })).toEqual({ value: "solo" });
    await store.storageSet({ ref, scope: "chat-1", key: "nothing", value: null });
    expect(await store.storageGet({ ref, scope: "chat-1", key: "nothing" }), "a stored null is not a missing key").toEqual({ value: null });
    expect(await store.storageKeys({ ref, scope: "chat-1" })).toEqual(["game", "nothing"]);
    await store.storageDelete({ ref, scope: "chat-1", key: "game" });
    expect(await store.storageKeys({ ref, scope: "chat-1" })).toEqual(["nothing"]);
  });

  it("refuses a scope that is not a chat of this profile, an app not installed, and a value that is not JSON", async () => {
    const { store, app } = await installed();
    await expect(store.storageSet({ ref: app.ref, scope: "group:g1", key: "k", value: 1 })).rejects.toThrow(/^bad-scope/);
    await expect(store.storageGet({ ref: app.ref, scope: "someone-else", key: "k" })).rejects.toThrow(/^bad-scope/);
    const other = (await bundle({ name: "go" })).ref;
    await expect(store.storageSet({ ref: other, scope: "chat-1", key: "k", value: 1 })).rejects.toThrow(/^not-installed/);
    await expect(store.storageSet({ ref: "not a ref", scope: "chat-1", key: "k", value: 1 })).rejects.toThrow(/^bad-ref/);
    await expect(store.storageSet({ ref: app.ref, scope: "chat-1", key: "k", value: undefined })).rejects.toThrow(/^bad-value/);
    await expect(store.storageSet({ ref: app.ref, scope: "chat-1", key: "k", value: () => 1 })).rejects.toThrow(/^bad-value/);
    expect(await storageRows()).toEqual([]);
  });

  it("a key is 1 to 256 bytes and a value at most 64 KiB of JSON", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    await store.storageSet({ ref, scope: "chat-1", key: "k".repeat(256), value: 1 });
    await expect(store.storageSet({ ref, scope: "chat-1", key: "k".repeat(257), value: 1 })).rejects.toThrow(/^bad-key/);
    await expect(store.storageSet({ ref, scope: "chat-1", key: "é".repeat(129), value: 1 }), "bytes, not characters").rejects.toThrow(/^bad-key/);
    await expect(store.storageSet({ ref, scope: "chat-1", key: "", value: 1 })).rejects.toThrow(/^bad-key/);
    // A string value's JSON is its text and two quotes.
    await store.storageSet({ ref, scope: "chat-1", key: "big", value: "x".repeat(APP_STORAGE_LIMITS.valueBytes - 2) });
    await expect(store.storageSet({ ref, scope: "chat-1", key: "big", value: "x".repeat(APP_STORAGE_LIMITS.valueBytes - 1) })).rejects.toThrow(/^too-large/);
  });

  it("5 MiB per app and per chat: a write past it is refused, a rewrite or a delete makes room, another chat has its own", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    const value = "x".repeat(APP_STORAGE_LIMITS.valueBytes - 2);
    let used = 0, n = 0;
    for (; ; n++) {
      const key = `k${String(n).padStart(3, "0")}`;
      const size = cost(key, APP_STORAGE_LIMITS.valueBytes);
      if (used + size > APP_STORAGE_LIMITS.scopeBytes) break;
      await store.storageSet({ ref, scope: "chat-1", key, value });
      used += size;
    }
    await expect(store.storageSet({ ref, scope: "chat-1", key: "one-more", value })).rejects.toThrow(/^full/);
    // Writing a key again counts its new size, not both.
    await store.storageSet({ ref, scope: "chat-1", key: "k000", value });
    await store.storageSet({ ref, scope: "chat-2", key: "one-more", value });
    await store.storageSet({ ref, scope: APP_SCOPE_ALONE, key: "one-more", value });
    await store.storageDelete({ ref, scope: "chat-1", key: "k000" });
    await store.storageSet({ ref, scope: "chat-1", key: "one-more", value: 1 });
    // A fresh engine counts what is stored, so the cap holds after a restart.
    const again = apps(net);
    await again.storageSet({ ref, scope: "chat-1", key: "k000", value });
    await expect(again.storageSet({ ref, scope: "chat-1", key: "k999", value })).rejects.toThrow(/^full/);
  });

  it("writes to one scope at once keep the count true", async () => {
    const { store, app } = await installed();
    const value = "x".repeat(APP_STORAGE_LIMITS.valueBytes - 2);
    const writes = Array.from({ length: 90 }, (_, i) => store.storageSet({ ref: app.ref, scope: "chat-1", key: `k${String(i).padStart(3, "0")}`, value }).then(() => "ok", (e: Error) => e.message.split(":")[0]));
    const results = await Promise.all(writes);
    const fit = Math.floor(APP_STORAGE_LIMITS.scopeBytes / cost("k000", APP_STORAGE_LIMITS.valueBytes));
    expect(results.filter((r) => r === "ok")).toHaveLength(fit);
    expect(results.filter((r) => r === "full")).toHaveLength(90 - fit);
    const total = (await storageRows() as { key: string; size: number }[]).filter((r) => r.key).reduce((sum, r) => sum + cost(r.key, r.size - r.key.length), 0);
    expect(total).toBeLessThanOrEqual(APP_STORAGE_LIMITS.scopeBytes);
  });

  /**
   * Rows as `storageSet` writes them, put straight in the store: `big` values of 64 KiB under keys `b00`, `b01`…, which
   * take most of a scope in a few rows, then `small` values of one byte under keys `k0000`, `k0001`…, then `long` values
   * of one byte under keys of 256 bytes.
   */
  async function seed(ref: string, scope: string, { big, small = 0, long = 0 }: { big: number; small?: number; long?: number }): Promise<void> {
    const value = JSON.stringify("x".repeat(APP_STORAGE_LIMITS.valueBytes - 2));
    const tx = (await openDb()).transaction(STORES.appStorage, "readwrite");
    for (let i = 0; i < big; i++) tx.objectStore(STORES.appStorage).put({ ref, scope, key: `b${String(i).padStart(2, "0")}`, value, size: 3 + APP_STORAGE_LIMITS.valueBytes });
    for (let i = 0; i < small; i++) tx.objectStore(STORES.appStorage).put({ ref, scope, key: `k${String(i).padStart(4, "0")}`, value: "1", size: 6 });
    for (let i = 0; i < long; i++) tx.objectStore(STORES.appStorage).put({ ref, scope, key: longKey(i), value: "1", size: 257 });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  }

  /** A key of 256 bytes, `i` at its end. */
  const longKey = (i: number) => `${"x".repeat(250)}${String(i).padStart(6, "0")}`;

  it("each key counts 128 bytes beside its own and its value's: the room left takes hundreds of one-byte values, not thousands", async () => {
    const { app } = await installed();
    const { ref } = app;
    // 79 values of 64 KiB leave 53,528 bytes of the 5 MiB (65,299 before a key counted 128 bytes, 55,187 before it
    // counted its own bytes eight times).
    const big = 79;
    await seed(ref, "chat-1", { big });
    const left = APP_STORAGE_LIMITS.scopeBytes - big * cost("b00", APP_STORAGE_LIMITS.valueBytes);
    // A key of 5 bytes and a value of 1: 6 bytes of the app's, 169 counted, and about 230 on the device.
    const fit = Math.floor(left / cost("k0000", 1));
    expect(fit).toBe(316);
    // A fresh engine counts the rows it finds the same way.
    const store = apps(net);
    const results: string[] = [];
    for (let i = 0; i < fit + 20; i++) results.push(await store.storageSet({ ref, scope: "chat-1", key: `k${String(i).padStart(4, "0")}`, value: 1 }).then(() => "ok", (e: Error) => e.message.split(":")[0]));
    expect(results.filter((r) => r === "ok")).toHaveLength(fit);
    expect(results.slice(fit)).toEqual(Array.from({ length: 20 }, () => "full"));
    // A delete gives back the key's 128 bytes with its own.
    await store.storageDelete({ ref, scope: "chat-1", key: "k0000" });
    await store.storageSet({ ref, scope: "chat-1", key: "k9999", value: 1 });
    await expect(store.storageSet({ ref, scope: "chat-1", key: "k0000", value: 1 })).rejects.toThrow(/^full/);
    expect(await store.storageKeys({ ref, scope: "chat-1" })).toHaveLength(big + fit);
  });

  it("keys of 256 bytes count their bytes eight times: a scope holds about 2,400 of them, not 13,600", async () => {
    const { app } = await installed();
    const { ref } = app;
    // A key of 256 bytes and a value of 1: 2,177 bytes counted, about 3,000 on the device (it was 385).
    const fit = Math.floor(APP_STORAGE_LIMITS.scopeBytes / cost(longKey(0), 1));
    expect(fit).toBe(2408);
    await seed(ref, "chat-1", { big: 0, long: fit - 1 });
    // A fresh engine counts the rows it finds the same way.
    const store = apps(net);
    await store.storageSet({ ref, scope: "chat-1", key: longKey(fit - 1), value: 1 });
    await expect(store.storageSet({ ref, scope: "chat-1", key: longKey(fit), value: 1 })).rejects.toThrow(/^full/);
    // A short key still fits in what is left, and a delete gives back the long key's whole count.
    await store.storageSet({ ref, scope: "chat-1", key: "k", value: 1 });
    await store.storageDelete({ ref, scope: "chat-1", key: longKey(0) });
    await store.storageSet({ ref, scope: "chat-1", key: longKey(fit), value: 1 });
  });

  it("the first write after a start reads no value: the scope's count is kept beside its rows", async () => {
    const { app } = await installed();
    const { ref } = app;
    // 10,000 rows from before the count was kept: the first write counts them once, from their values.
    await seed(ref, "chat-1", { big: 0, small: 10_000 });
    const first = apps(net);
    await first.storageSet({ ref, scope: "chat-1", key: "a", value: 1 });
    const reads = [vi.spyOn(IDBObjectStore.prototype, "getAll"), vi.spyOn(IDBIndex.prototype, "getAll"), vi.spyOn(IDBObjectStore.prototype, "openCursor"), vi.spyOn(IDBIndex.prototype, "openCursor")];
    /** Reads of many app storage rows at once (the installed apps' own store is read by other calls). */
    const storageReads = (spy: (typeof reads)[number]) => spy.mock.contexts.filter((c) => ((c as IDBObjectStore).name ?? (c as IDBIndex).objectStore.name) === STORES.appStorage).length;
    try {
      // A fresh engine takes the kept count: a write, a rewrite and a delete read no other row.
      const again = apps(net);
      await again.storageSet({ ref, scope: "chat-1", key: "b", value: 2 });
      await again.storageSet({ ref, scope: "chat-1", key: "a", value: [1, 2, 3] });
      await again.storageDelete({ ref, scope: "chat-1", key: "k0000" });
      expect(reads.map(storageReads)).toEqual([0, 0, 0, 0]);
    } finally {
      for (const r of reads) r.mockRestore();
    }
    // The kept count is the one the rows make.
    const rows = await storageRows() as { key: string; value: string; size: number }[];
    const own = rows.filter((r) => r.key);
    expect(JSON.parse(rows.find((r) => !r.key)!.value)).toEqual({ rows: 10_001, keyBytes: own.reduce((n, r) => n + r.key.length, 0), size: own.reduce((n, r) => n + r.size, 0) });
  });

  it("a kept count that disagrees with the rows (an older client wrote some) is counted again", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    await store.storageSet({ ref, scope: "chat-1", key: "a", value: 1 });
    // Rows an older client put there, the kept count not told.
    await seed(ref, "chat-1", { big: 79 });
    const again = apps(net);
    const left = APP_STORAGE_LIMITS.scopeBytes - cost("a", 1) - 79 * cost("b00", APP_STORAGE_LIMITS.valueBytes);
    const fit = Math.floor(left / cost("k0000", 1));
    for (let i = 0; i < fit; i++) await again.storageSet({ ref, scope: "chat-1", key: `k${String(i).padStart(4, "0")}`, value: 1 });
    await expect(again.storageSet({ ref, scope: "chat-1", key: "k9999", value: 1 })).rejects.toThrow(/^full/);
  });

  it("the kept count is never one of the app's keys, and goes with the scope's last key", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    await store.storageSet({ ref, scope: "chat-1", key: "a", value: 1 });
    await store.storageSet({ ref, scope: "chat-1", key: "b", value: 2 });
    expect(await store.storageKeys({ ref, scope: "chat-1" })).toEqual(["a", "b"]);
    expect(await store.exportData({ ref })).toEqual([{ ghostlyAppData: 1, app: ref, scope: "chat-1", entries: { a: 1, b: 2 } }]);
    expect(await store.exportDataText({ ref })).toEqual([{ app: ref, scope: "chat-1", entries: [["a", "1"], ["b", "2"]] }]);
    expect((await storageRows() as { key: string }[]).map((r) => r.key)).toEqual(["", "a", "b"]);
    await store.storageDelete({ ref, scope: "chat-1", key: "a" });
    await store.storageDelete({ ref, scope: "chat-1", key: "b" });
    expect(await storageRows()).toEqual([]);
  });

  it("a scope filled under an older count takes no new key, and still rewrites and deletes the ones it has", async () => {
    const { app } = await installed();
    const { ref } = app;
    // 5,181,181 bytes as they were first counted, under the 5 MiB; 5,290,752 as they are now, over it.
    await seed(ref, "chat-1", { big: 79, small: 600 });
    const store = apps(net);
    await expect(store.storageSet({ ref, scope: "chat-1", key: "new", value: 1 })).rejects.toThrow(/^full/);
    await store.storageSet({ ref, scope: "chat-1", key: "k0000", value: 2 });
    expect(await store.storageGet({ ref, scope: "chat-1", key: "k0000" })).toEqual({ value: 2 });
    await expect(store.storageSet({ ref, scope: "chat-1", key: "k0000", value: 10 }), "a rewrite that grows").rejects.toThrow(/^full/);
    await store.storageDelete({ ref, scope: "chat-1", key: "k0001" });
    expect(await store.storageGet({ ref, scope: "chat-1", key: "k0001" })).toBeNull();
    await expect(store.storageSet({ ref, scope: "chat-1", key: "new", value: 1 }), "still over after one delete").rejects.toThrow(/^full/);
    // Another chat has its own count, and a smaller value makes room in this one.
    await store.storageSet({ ref, scope: "chat-2", key: "new", value: 1 });
    await store.storageSet({ ref, scope: "chat-1", key: "b00", value: "smaller" });
    await store.storageSet({ ref, scope: "chat-1", key: "new", value: 1 });
  });

  it("keys calls made at once on a scope of many keys read the database once at a time, and each sees the writes done before it", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    await seed(ref, "chat-1", { big: 0, small: 5000 });
    const reads = vi.spyOn(IDBObjectStore.prototype, "getAllKeys");
    try {
      const calls = Array.from({ length: 49 }, () => store.storageKeys({ ref, scope: "chat-1" }));
      const answers = await Promise.all(calls);
      expect(answers.every((keys) => keys.length === 5000)).toBe(true);
      expect(reads.mock.calls.length, "one read running and one shared by every call made meanwhile").toBeLessThanOrEqual(2);
      reads.mockClear();
      const before = store.storageKeys({ ref, scope: "chat-1" });
      await store.storageSet({ ref, scope: "chat-1", key: "late", value: 1 });
      const after = await store.storageKeys({ ref, scope: "chat-1" });
      expect(after, "a call made after a write sees it").toContain("late");
      expect((await before).length).toBeGreaterThanOrEqual(5000);
      expect(await store.storageKeys({ ref, scope: APP_SCOPE_ALONE }), "another scope reads its own").toEqual([]);
    } finally { reads.mockRestore(); }
  });

  it("exports every scope as the WISP's file", async () => {
    const { store, app } = await installed();
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "a", value: [1, 2] });
    await store.storageSet({ ref: app.ref, scope: APP_SCOPE_ALONE, key: "b", value: { c: true } });
    expect(await store.exportData({ ref: app.ref })).toEqual([
      { ghostlyAppData: 1, app: app.ref, scope: APP_SCOPE_ALONE, entries: { b: { c: true } } },
      { ghostlyAppData: 1, app: app.ref, scope: "chat-1", entries: { a: [1, 2] } },
    ]);
  });

  it("exports every scope with each value as the JSON text it is kept as, a scope at a time", async () => {
    const { store, app } = await installed();
    const other = await bundle({ name: "go" });
    net.put("https://raw.githubusercontent.com/ana/go/HEAD/app.ghostlyapp", other.bytes);
    await store.preview({ url: "https://github.com/ana/go" });
    await store.install({ digest: other.digest, grant: ["chat"] });
    await store.storageSet({ ref: app.ref, scope: "chat-2", key: "z", value: { b: 1, "2": [true, null] } });
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "__proto__", value: "p" });
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "a", value: [1, 2] });
    await store.storageSet({ ref: app.ref, scope: APP_SCOPE_ALONE, key: "b", value: 0.5 });
    await store.storageSet({ ref: other.ref, scope: "chat-1", key: "a", value: "another app's" });
    const timers = vi.spyOn(globalThis, "setTimeout");
    expect(await store.exportDataText({ ref: app.ref })).toEqual([
      { app: app.ref, scope: APP_SCOPE_ALONE, entries: [["b", "0.5"]] },
      { app: app.ref, scope: "chat-1", entries: [["__proto__", "\"p\""], ["a", "[1,2]"]] },
      { app: app.ref, scope: "chat-2", entries: [["z", '{"2":[true,null],"b":1}']] },
    ]);
    // The thread is let go between scopes.
    expect(timers.mock.calls.filter(([, ms]) => ms === 0).length).toBeGreaterThanOrEqual(2);
    timers.mockRestore();
    // The parsed export is the same data.
    expect((await store.exportData({ ref: app.ref })).map((file) => file.entries)).toEqual([{ b: 0.5 }, JSON.parse('{"__proto__":"p","a":[1,2]}'), { z: { b: 1, 2: [true, null] } }]);
    expect(await store.exportDataText({ ref: other.ref })).toEqual([{ app: other.ref, scope: "chat-1", entries: [["a", "\"another app's\""]] }]);
  });

  it("exports a key named __proto__ like any other", async () => {
    const { store, app } = await installed();
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "__proto__", value: { board: "rnbqkbnr", turn: 7 } });
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "score", value: 3 });
    const [file] = await store.exportData({ ref: app.ref });
    expect(Object.keys(file.entries).sort()).toEqual(["__proto__", "score"]);
    expect(Object.getPrototypeOf(file.entries)).toBe(Object.prototype);
    // The file the uninstall dialog saves is this, as JSON.
    expect(JSON.parse(JSON.stringify(file))).toEqual({
      ghostlyAppData: 1, app: app.ref, scope: "chat-1",
      entries: JSON.parse('{"__proto__":{"board":"rnbqkbnr","turn":7},"score":3}'),
    });
  });
});

describe("uninstall", () => {
  it("removes the app's files, its record and its storage in every chat; another app's stay", async () => {
    const { store, app } = await installed();
    const go = await bundle({ name: "go" });
    net.put("https://raw.githubusercontent.com/ana/go/HEAD/app.ghostlyapp", go.bytes);
    await store.preview({ url: "https://github.com/ana/go" });
    await store.install({ digest: go.digest, grant: ["chat"] });
    for (const scope of ["chat-1", "chat-2", APP_SCOPE_ALONE]) {
      await store.storageSet({ ref: app.ref, scope, key: "k", value: scope });
      await store.storageSet({ ref: go.ref, scope, key: "k", value: scope });
    }
    await store.uninstall({ ref: app.ref });
    expect((await appRows() as { ref: string }[]).map((a) => a.ref)).toEqual([go.ref]);
    expect((await storageRows() as { ref: string }[]).every((r) => r.ref === go.ref)).toBe(true);
    expect(await ownRows()).toHaveLength(3);
    expect(await bundleIds()).toEqual([`app-${go.digest}`]);
    await expect(store.entry({ ref: app.ref })).rejects.toThrow(/^not-installed/);
    // Installed again, it starts empty.
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: app.digest, grant: ["chat"] });
    expect(await store.storageKeys({ ref: app.ref, scope: "chat-1" })).toEqual([]);
  });

  it("a waiting update's files go too", async () => {
    const { store, app } = await installed();
    const v2 = await bundle({ sequence: 2, permissions: ["chat", "name"] });
    net.put("https://raw.githubusercontent.com/ana/chess/v2/app.ghostlyapp", v2.bytes);
    const { listing } = await import("./appsSupport");
    await net.putStore(await storeFiles({ apps: [listing(v2, ["https://raw.githubusercontent.com/ana/chess/v2/app.ghostlyapp"])] }));
    await store.addStore({ url: STORE_URL });
    await store.checkUpdates();
    expect(await bundleIds()).toHaveLength(2);
    await store.uninstall({ ref: app.ref });
    expect(await bundleIds()).toEqual([]);
  });

  it("a deleted chat takes every app's storage for that chat with it", async () => {
    const { store, app } = await installed();
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "k", value: 1 });
    await store.storageSet({ ref: app.ref, scope: "chat-2", key: "k", value: 2 });
    await db.deleteLink("chat-1");
    expect((await ownRows()).map((r) => r.scope)).toEqual(["chat-2"]);
  });

  it("a chat deleted while its app is writing keeps none of that app's rows: a write still waiting is refused", async () => {
    for (const burst of [5, 20, 50]) {
      await emptyProfile();
      const chats = new Set(["chat-1", "chat-2"]);
      const app = await bundle();
      net.put(BUNDLE_URL, app.bytes);
      const store = apps(net, { isChat: (scope) => chats.has(scope) });
      await store.preview({ url: BUNDLE_URL });
      await store.install({ digest: app.digest, grant: ["chat"] });
      const { ref } = app;
      await store.storageSet({ ref, scope: "chat-1", key: "before", value: 1 });
      await store.storageSet({ ref, scope: "chat-2", key: "other", value: 2 });
      const writes = Array.from({ length: burst }, (_, i) => store.storageSet({ ref, scope: "chat-1", key: `k${i}`, value: i }).then(() => "ok", (e: Error) => e.message.split(":")[0]));
      // As the engine's `removeLink`: the chat is no longer one at once, its rows go in the background.
      await writes[0];
      chats.delete("chat-1");
      const deleted = db.deleteLink("chat-1");
      const results = await Promise.all(writes);
      await deleted;
      expect((await ownRows()).map((r) => r.scope), `burst of ${burst}`).toEqual(["chat-2"]);
      expect(await store.exportData({ ref }), `burst of ${burst}`).toEqual([{ ghostlyAppData: 1, app: ref, scope: "chat-2", entries: { other: 2 } }]);
      expect(results[0]).toBe("ok");
      expect(results.at(-1), `burst of ${burst}: the last write waited past the delete`).toBe("bad-scope");
      expect(new Set(results)).toEqual(new Set(["ok", "bad-scope"]));
      // The other chat and the app alone still write, and the deleted chat's count starts again if its id ever comes back.
      await store.storageSet({ ref, scope: "chat-2", key: "after", value: 3 });
      await store.storageSet({ ref, scope: APP_SCOPE_ALONE, key: "after", value: 4 });
      chats.add("chat-1");
      expect(await store.storageKeys({ ref, scope: "chat-1" })).toEqual([]);
      await store.storageSet({ ref, scope: "chat-1", key: "big", value: "x".repeat(APP_STORAGE_LIMITS.valueBytes - 2) });
    }
  });

  it("a deleted chat's messages and app rows go by range, one delete per app, not one per row", async () => {
    const refs = ["ana/chess", "ana/go", "bo/notes"];
    const tx = (await openDb()).transaction([STORES.messages, STORES.appStorage], "readwrite");
    for (const linkId of ["chat-1", "chat-2"]) {
      for (let i = 0; i < 300; i++) tx.objectStore(STORES.messages).put({ linkId, id: `m${i}`, timestamp: i });
      for (const ref of refs) for (let i = 0; i < 100; i++) tx.objectStore(STORES.appStorage).put({ ref, scope: linkId, key: `k${i}`, value: "1", size: 1 });
    }
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    const deletes = vi.spyOn(IDBObjectStore.prototype, "delete");
    try {
      await db.deleteLink("chat-1");
      const on = (name: string) => deletes.mock.contexts.filter((store) => (store as IDBObjectStore).name === name).length;
      expect(on(STORES.messages)).toBe(1);
      expect(on(STORES.appStorage)).toBe(refs.length);
    } finally { deletes.mockRestore(); }
    expect((await db.getMessages("chat-1"))).toEqual([]);
    expect((await db.getMessages("chat-2"))).toHaveLength(300);
    expect(new Set((await storageRows() as { scope: string }[]).map((r) => r.scope))).toEqual(new Set(["chat-2"]));
    expect(await ownRows()).toHaveLength(300);
  });

  it("Clear all data empties the apps' stores", async () => {
    const { store, app } = await installed();
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "k", value: 1 });
    expect(PROFILE_STORES).toEqual(expect.arrayContaining([STORES.apps, STORES.appStores, STORES.appStorage]));
    await clearProfileStores();
    expect(await appRows()).toEqual([]);
    expect(await storageRows()).toEqual([]);
  });
});

describe("the database", () => {
  it("a profile at 13 opens at 14 with its rows kept and the apps' stores added", async () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(14);
    await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(databaseName()); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
    const thirteen = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName(), 13);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("settings");
        request.result.createObjectStore("links", { keyPath: "id" });
        request.transaction!.objectStore("settings").put({ nick: "Kept" }, "settings");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    thirteen.close();
    const opened = await openDb();
    expect(opened.version).toBe(DB_VERSION);
    expect([...opened.objectStoreNames]).toEqual(expect.arrayContaining(["settings", "links", "apps", "appStores", "appStorage"]));
    expect(await wrap(opened.transaction("settings").objectStore("settings").get("settings"))).toEqual({ nick: "Kept" });
    const storage = opened.transaction("appStorage").objectStore("appStorage");
    expect(storage.keyPath).toEqual(["ref", "scope", "key"]);
    expect([...storage.indexNames].sort()).toEqual(["byAppScope", "byScope"]);
    // A build that reads up to 13 gets a version error and never opens it (it says "Update Ghostly to open it").
    const older = await new Promise<unknown>((resolve) => { const r = indexedDB.open(databaseName(), 13); r.onsuccess = () => { r.result.close(); resolve(null); }; r.onerror = () => resolve(r.error); });
    expect((older as DOMException | null)?.name).toBe("VersionError");
  });

  it("a backup carries the installed list, the stores and the storage, not the bundles", async () => {
    const { store, app } = await installed();
    await net.putStore(await storeFiles());
    await store.addStore({ url: STORE_URL });
    await store.storageSet({ ref: app.ref, scope: "chat-1", key: "game", value: 7 });
    // As the profile backup reads it (apps/ui profileBackup.ts): every store, the pieces of files left to file storage.
    const snapshot = (await snapshotDatabase(databaseName(), ["fileChunks"]))!;
    const rowsOf = (name: string) => snapshot.stores.find((s) => s.name === name)!.values;
    expect(rowsOf("apps")).toMatchObject([{ ref: app.ref, digest: app.digest, sequence: 1, permissions: ["chat"] }]);
    expect(rowsOf("appStores")).toHaveLength(1);
    // The scope's kept count goes with its rows.
    expect(rowsOf("appStorage")).toMatchObject([{ ref: app.ref, scope: "chat-1", key: "", value: JSON.stringify({ rows: 1, keyBytes: 4, size: 5 }) }, { ref: app.ref, scope: "chat-1", key: "game", value: "7" }]);
    expect(rowsOf("fileChunks")).toEqual([]);
    // A bundle has no `files` row, so no file of the backup carries it.
    expect(rowsOf("files")).toEqual([]);
  });
});

describe("the engine", () => {
  async function node(options: { apps?: boolean } = {}) {
    await db.putSettings({ online: true, nick: "Ana", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const invitation = createLink();
    await db.putLink({ ...invitation.mine, id: "l1", profile: "paired-chat/1", participationSeed: createIdentity().seedB64, pairedPeerKey: createIdentity().pubKeyZ32, createdAt: 1 });
    const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
    const peer = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, appFetch: net.fetch, ...options });
    await peer.start();
    return peer;
  }

  it("is off: every app call is refused", async () => {
    // Off by the engine's option, so this holds whatever the build's APPS_ENABLED says.
    const peer = await node({ apps: false });
    await expect(Promise.resolve().then(() => peer.appList())).rejects.toThrow("Apps do not run on this client");
    await expect(Promise.resolve().then(() => peer.appStoreAdd({ url: STORE_URL }))).rejects.toThrow("Apps do not run on this client");
    await peer.shutdown({ quiet: true });
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it("on for a test engine: a chat of the profile is a scope, a group or an unknown id is not, and nothing is asked", async () => {
    const peer = await node({ apps: true });
    expect(await peer.appList()).toEqual([]);
    expect((await peer.appStoreList()).map((s) => s.url)).toEqual(DEFAULT_APP_STORES.map((s) => s.url));
    expect(await peer.appCheckUpdates()).toEqual([]);
    const app = await bundle();
    net.put(BUNDLE_URL, app.bytes);
    const preview = await peer.appPreview({ url: BUNDLE_URL });
    await peer.appInstall({ digest: preview.digest, grant: ["chat"] });
    await peer.appStorageSet({ ref: app.ref, scope: "l1", key: "k", value: 1 });
    await expect(peer.appStorageSet({ ref: app.ref, scope: "l2", key: "k", value: 1 })).rejects.toThrow(/^bad-scope/);
    expect(await peer.appStorageGet({ ref: app.ref, scope: "l1", key: "k" })).toEqual({ value: 1 });
    expect((await peer.appEntry({ ref: app.ref })).entry).toContain("Chess");
    expect(net.requests).toEqual([BUNDLE_URL]);
    await peer.shutdown({ quiet: true });
  });
});
