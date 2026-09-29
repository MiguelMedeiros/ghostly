import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { databaseExists, restoreDatabase, snapshotDatabase, type DatabaseSnapshot } from "../src/backup/database";
import { restoreArkDatabase, snapshotArkDatabase, type ArkDatabaseSnapshot } from "../src/engine/paymentAdapters/backup";
import { wrap } from "../src/shared/idb";
// covers: backup.database-snapshot, backup.envelope, wallet.ark.backup

async function make(name: string, version: number, build: (db: IDBDatabase, tx: IDBTransaction) => void) {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => build(request.result, request.transaction!);
  (await wrap(request)).close();
}
async function readAll(name: string, store: string) {
  const db = await wrap(indexedDB.open(name));
  try { const s = db.transaction(store).objectStore(store); return { keys: await wrap(s.getAllKeys()), values: await wrap(s.getAll()), indexes: Array.from(s.indexNames) }; } finally { db.close(); }
}

it("copies every store with its shape: key paths, out-of-line keys, auto-increment and indexes", async () => {
  await make("snap-src", 4, (db) => {
    const msgs = db.createObjectStore("messages", { keyPath: ["linkId", "id"] });
    msgs.createIndex("byLink", "linkId", { unique: false });
    msgs.put({ linkId: "l", id: "1", at: 5n });
    db.createObjectStore("settings").put({ on: true }, "flags");
    db.createObjectStore("log", { autoIncrement: true }).put("first");
  });
  const snapshot = (await snapshotDatabase("snap-src"))!;
  expect(snapshot.version).toBe(4);
  await restoreDatabase("snap-copy", snapshot);
  expect(await readAll("snap-copy", "messages")).toEqual({ keys: [["l", "1"]], values: [{ linkId: "l", id: "1", at: 5n }], indexes: ["byLink"] });
  expect((await readAll("snap-copy", "settings")).keys).toEqual(["flags"]);
  expect((await readAll("snap-copy", "log")).values).toEqual(["first"]);
});

it("reading a database that does not exist neither creates it nor fails", async () => {
  expect(await snapshotDatabase("never-made")).toBeNull();
  expect(await databaseExists("never-made")).toBe(false);
});

it("never writes over a database that exists, and refuses malformed snapshots", async () => {
  await make("snap-existing", 1, (db) => db.createObjectStore("s").put("mine", "k"));
  const other: DatabaseSnapshot = { version: 1, stores: [{ name: "s", keyPath: null, autoIncrement: false, indexes: [], keys: ["k"], values: ["theirs"] }] };
  await expect(restoreDatabase("snap-existing", other)).rejects.toThrow("already exists");
  await expect(restoreDatabase("snap-existing", { ...other, version: 2 })).rejects.toThrow("already exists");
  expect((await readAll("snap-existing", "s")).values).toEqual(["mine"]);
  const bad: DatabaseSnapshot[] = [
    { version: 0, stores: [] },
    { version: 1.5, stores: [] },
    { version: 1, stores: [other.stores[0], other.stores[0]] },
    { version: 1, stores: [{ ...other.stores[0], keys: [] }] },
    { version: 1, stores: [{ ...other.stores[0], name: 5 as unknown as string }] },
    { version: 1, stores: "nope" as unknown as DatabaseSnapshot["stores"] },
  ];
  for (const snapshot of bad) await expect(restoreDatabase("snap-bad", snapshot)).rejects.toThrow("malformed");
  expect(await databaseExists("snap-bad")).toBe(false);
});

const ARK_STORES = ["vtxos", "utxos", "transactions", "walletState", "contracts", "contractsCollections"];
it("an Ark wallet database travels only with the stores the SDK is known to use, and never over another", async () => {
  await make("ghostly-ark-w1", 3, (db) => { for (const name of ARK_STORES) db.createObjectStore(name, { keyPath: "id" }); });
  const snapshot = await snapshotArkDatabase("w1");
  await restoreArkDatabase("w2", snapshot);
  expect(await databaseExists("ghostly-ark-w2")).toBe(true);
  await expect(restoreArkDatabase("w2", snapshot), "an existing wallet database is never replaced").rejects.toThrow("already exists");

  await make("ghostly-ark-odd", 3, (db) => { for (const name of [...ARK_STORES, "surprise"]) db.createObjectStore(name); });
  await expect(snapshotArkDatabase("odd")).rejects.toThrow("Unsupported Ark database schema");
  const unknown: ArkDatabaseSnapshot = { ...snapshot, stores: [...snapshot.stores, { ...snapshot.stores[0], name: "surprise" }] };
  await expect(restoreArkDatabase("w3", unknown)).rejects.toThrow("Unsupported Ark backup schema");
  await expect(restoreArkDatabase("w3", { ...snapshot, version: 2 })).rejects.toThrow("Unsupported Ark backup schema");
  await expect(restoreArkDatabase("w3", { ...snapshot, stores: snapshot.stores.slice(1) })).rejects.toThrow("Incomplete");
  expect(await databaseExists("ghostly-ark-w3")).toBe(false);
});
