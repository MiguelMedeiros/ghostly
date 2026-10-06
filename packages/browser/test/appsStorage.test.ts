import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink } from "@ghostly/core";
import { APP_SCOPE_ALONE, APP_STORAGE_LIMITS, type Apps } from "../src/engine/apps";
import { db } from "../src/engine/db";
import { GhostlyNode } from "../src/engine/node";
import { snapshotDatabase } from "../src/backup/database";
import { APPS_ENABLED } from "../src/shared/features";
import { DB_VERSION, PROFILE_STORES, STORES, clearProfileStores, databaseName, openDb, wrap } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, STORE_URL, appRows, apps, bundle, bundleIds, emptyProfile, storageRows, storeFiles, type Built } from "./appsSupport";
// covers: apps.engine.storage, apps.engine.installed

/*
 * Each app's own storage (WISP 1200 § Permissions: 5 MiB per app and per chat, keys of 256 bytes, JSON values of 64 KiB),
 * uninstall, the database step that adds the apps' stores, what a backup carries, and the engine's flag.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

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
      const size = key.length + APP_STORAGE_LIMITS.valueBytes;
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
    const fit = Math.floor(APP_STORAGE_LIMITS.scopeBytes / (4 + APP_STORAGE_LIMITS.valueBytes));
    expect(results.filter((r) => r === "ok")).toHaveLength(fit);
    expect(results.filter((r) => r === "full")).toHaveLength(90 - fit);
    const total = (await storageRows() as { size: number }[]).reduce((sum, r) => sum + r.size, 0);
    expect(total).toBeLessThanOrEqual(APP_STORAGE_LIMITS.scopeBytes);
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
    expect(await storageRows()).toHaveLength(3);
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
    expect((await storageRows() as { scope: string }[]).map((r) => r.scope)).toEqual(["chat-2"]);
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
    expect(DB_VERSION).toBe(14);
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
    expect(opened.version).toBe(14);
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
    expect(rowsOf("appStorage")).toMatchObject([{ ref: app.ref, scope: "chat-1", key: "game", value: "7" }]);
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

  it("is off in this build: every app call is refused", async () => {
    expect(APPS_ENABLED).toBe(false);
    const peer = await node();
    await expect(Promise.resolve().then(() => peer.appList())).rejects.toThrow("Apps are unavailable in this release");
    await expect(Promise.resolve().then(() => peer.appStoreAdd({ url: STORE_URL }))).rejects.toThrow("Apps are unavailable in this release");
    await peer.shutdown({ quiet: true });
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it("on for a test engine: a chat of the profile is a scope, a group or an unknown id is not, and nothing is asked", async () => {
    const peer = await node({ apps: true });
    expect(await peer.appList()).toEqual([]);
    expect(await peer.appStoreList()).toEqual([]);
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
