import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { DB_VERSION, STORES } from "../src/shared/idb";
// covers: devices.gate, app.profile-unavailable

/*
 * `DB_VERSION` 12 (WISP 06 § Compatibility and rollout): raised with the first build that knows device states, so an
 * older build given this storage refuses it and can never run a standby's frozen copy. The schema itself does not
 * change at 12. Here a database as Ghostly 1.0.2 made it (version 10) is opened by this build: it upgrades, every row
 * is as it was, and the only thing added is what version 11 added (the card index, already on `dev`).
 */

/** The peer database exactly as 1.0.2's `onupgradeneeded` made it (`git show v1.0.2:packages/browser/src/shared/idb.ts`). */
function makeV10(name: string, fill: (db: IDBDatabase, tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 10);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("links", { keyPath: "id" });
      db.createObjectStore("services", { keyPath: "id" });
      db.createObjectStore("settings");
      const messages = db.createObjectStore("messages", { keyPath: ["linkId", "id"] });
      messages.createIndex("byLink", "linkId");
      db.createObjectStore("proofs", { keyPath: "secret" });
      db.createObjectStore("payments", { keyPath: "id" });
      db.createObjectStore("quotes", { keyPath: "quote" });
      db.createObjectStore("walletTx", { keyPath: "id" });
      db.createObjectStore("melts", { keyPath: "quote" });
      db.createObjectStore("paymentIntents", { keyPath: "review.id" });
      db.createObjectStore("files", { keyPath: "id" }).createIndex("byLink", "linkId");
      db.createObjectStore("groups", { keyPath: "id" });
      db.createObjectStore("fileChunks", { keyPath: ["id", "index"] });
      db.createObjectStore("fileState", { keyPath: "id" });
      messages.createIndex("byLinkTime", ["linkId", "timestamp"]);
      fill(db, request.transaction!);
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}

/** One row or more in every store, shaped as the app writes them. */
const ROWS: Record<string, { key?: IDBValidKey; value: unknown }[]> = {
  links: [{ value: { id: "link-1", profile: "paired-chat/1", seedB64: "c2VlZA", peerPubKeyZ32: "ybndrfg8", encKeyB64: "a2V5", createdAt: 1_700_000_000_000, dhtDeliveryState: { sequence: 4, peerSequence: 9 } } }],
  services: [{ value: { id: "atlas", name: "Atlas", origin: "http://localhost:3400" } }],
  settings: [{ key: "settings", value: { nick: "Kept", online: true, relays: ["https://relay.example"], mints: [] } }, { key: "profileDid", value: { seed: new Uint8Array([1, 2, 3]) } }],
  messages: [
    { value: { linkId: "link-1", id: "m1", text: "hello", sender: "me", timestamp: 1_700_000_000_001, via: "datalink" } },
    { value: { linkId: "link-1", id: "m2", text: "a card", sender: "peer", timestamp: 1_700_000_000_002, via: "dht", card: { kind: "task", id: "relay", title: "Fix relay", status: "running" } } },
  ],
  proofs: [{ value: { secret: "s1", amount: 8, id: "009a1f293253e41e", C: "02ab", mint: "https://mint.example" } }],
  payments: [{ value: { id: "pay-1", amount: 21, state: "done" } }],
  quotes: [{ value: { quote: "q-1", mint: "https://mint.example", amount: 100 } }],
  walletTx: [{ value: { id: "tx-1", amount: -5, at: 1_700_000_000_003 } }],
  melts: [{ value: { quote: "melt-1", proofs: ["s1"] } }],
  paymentIntents: [{ value: { review: { id: "intent-1", state: "submitted", method: "cashu" }, prepared: { bytes: new Uint8Array([9, 9]) } } }],
  files: [{ value: { id: "link-1-in-abc", linkId: "link-1", createdAt: 1_700_000_000_004, direction: "in", digest: "ZGlnZXN0" } }],
  groups: [{ value: { id: "group-1", name: "Friends", epoch: 3 } }],
  fileChunks: [{ value: { id: "link-1-in-abc", index: 0, bytes: new Uint8Array([7, 7, 7]) } }],
  fileState: [{ value: { id: "link-1-in-abc", transfer: { state: "done", transferred: 3, size: 3 } } }],
};

function fill(_db: IDBDatabase, tx: IDBTransaction): void {
  for (const [store, rows] of Object.entries(ROWS)) for (const row of rows) tx.objectStore(store).put(row.value, row.key);
}

interface Shape { version: number; stores: Record<string, { keyPath: unknown; autoIncrement: boolean; indexes: Record<string, { keyPath: unknown; unique: boolean; multiEntry: boolean }>; keys: IDBValidKey[]; values: unknown[] }> }
async function shapeOf(db: IDBDatabase): Promise<Shape> {
  const names = Array.from(db.objectStoreNames).sort();
  const tx = db.transaction(names, "readonly");
  const get = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const stores: Shape["stores"] = {};
  for (const name of names) {
    const store = tx.objectStore(name);
    const indexes = Object.fromEntries(Array.from(store.indexNames).sort().map((index) => { const i = store.index(index); return [index, { keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }]; }));
    stores[name] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys: await get(store.getAllKeys()), values: await get(store.getAll()) };
  }
  return { version: db.version, stores };
}
/** This build opening a profile's database, as a page that just started does. */
async function openAs(name: string): Promise<IDBDatabase> {
  vi.resetModules();
  const idb = await import("../src/shared/idb");
  idb.setDatabaseName(name);
  return idb.openDb();
}
const openAt = (name: string, version?: number) => new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name, version); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

describe("DB_VERSION 12", () => {
  it("is 12", () => {
    expect(DB_VERSION).toBe(12);
  });

  it("a database of Ghostly 1.0.2 upgrades, with every row as it was and nothing added but the card index of version 11", async () => {
    await makeV10("ghostly_from102", fill);
    const before = await openAt("ghostly_from102");
    const was = await shapeOf(before);
    before.close();
    expect(was.version).toBe(10);

    const db = await openAs("ghostly_from102");
    const now = await shapeOf(db);
    expect(now.version).toBe(12);

    // The same stores, with the same keys, key paths and rows.
    expect(Object.keys(now.stores)).toEqual(Object.keys(was.stores));
    expect(Object.keys(now.stores)).toEqual(Object.values(STORES).slice().sort());
    for (const name of Object.keys(was.stores)) {
      expect(now.stores[name].keyPath, name).toEqual(was.stores[name].keyPath);
      expect(now.stores[name].autoIncrement, name).toBe(was.stores[name].autoIncrement);
      expect(now.stores[name].keys, name).toEqual(was.stores[name].keys);
      expect(now.stores[name].values, name).toEqual(was.stores[name].values);
      expect(now.stores[name].values.length, name).toBe(ROWS[name].length);
    }
    // The indexes: what 1.0.2 had, plus version 11's card index on messages. Version 12 adds none.
    const indexes = (shape: Shape) => Object.fromEntries(Object.entries(shape.stores).map(([name, store]) => [name, store.indexes]));
    expect(indexes(now)).toEqual({ ...indexes(was), messages: { ...was.stores.messages.indexes, byCardKind: { keyPath: "card.kind", unique: false, multiEntry: false } } });
    // The card index holds the one message that carries a card.
    const cards = await new Promise<unknown[]>((resolve) => { const r = db.transaction("messages").objectStore("messages").index("byCardKind").getAll(); r.onsuccess = () => resolve(r.result); });
    expect(cards).toEqual([ROWS.messages[1].value]);
    db.close();
  });

  it("an upgraded database and a new one have the same shape", async () => {
    await makeV10("ghostly_upgraded", () => {});
    const upgraded = await openAs("ghostly_upgraded");
    const a = await shapeOf(upgraded);
    upgraded.close();
    const fresh = await openAs("ghostly_new12");
    const b = await shapeOf(fresh);
    fresh.close();
    expect(a).toEqual(b);
    expect(a.version).toBe(12);
  });

  it("an older build cannot open what this one stored: it gets a version error and nothing changes", async () => {
    const db = await openAs("ghostly_older_build");
    await new Promise<void>((resolve) => { const tx = db.transaction("settings", "readwrite"); tx.objectStore("settings").put({ nick: "Kept" }, "settings"); tx.oncomplete = () => resolve(); });
    db.close();
    // What 1.0.2 (10) and the builds on `dev` before this one (11) ask for.
    for (const older of [10, 11]) await expect(openAt("ghostly_older_build", older)).rejects.toMatchObject({ name: "VersionError" });
    const after = await openAt("ghostly_older_build");
    expect(after.version).toBe(12);
    const kept = await new Promise((resolve) => { const r = after.transaction("settings").objectStore("settings").get("settings"); r.onsuccess = () => resolve(r.result); });
    expect(kept).toEqual({ nick: "Kept" });
    after.close();
  });
});
