import { wrap } from "../shared/idb";

export interface StoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  keys: IDBValidKey[];
  values: unknown[];
}
export interface DatabaseSnapshot { version: number; stores: StoreSnapshot[] }

/** Whether a database of this name exists; opening one that does not would create it. */
export async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases === "function") return (await indexedDB.databases()).some((d) => d.name === name);
  return true;
}

/**
 * Every store of a database: its shape, keys and values, read in one transaction. The stores in `skip` come back with
 * their shape and no rows (the pieces of large files, which a backup reads through file storage a step at a time).
 */
export async function snapshotDatabase(name: string, skip: readonly string[] = []): Promise<DatabaseSnapshot | null> {
  if (!(await databaseExists(name))) return null;
  const db = await wrap(indexedDB.open(name));
  try {
    const names = Array.from(db.objectStoreNames);
    if (!names.length) return null;
    const tx = db.transaction(names, "readonly");
    const stores = await Promise.all(names.map(async (storeName) => {
      const store = tx.objectStore(storeName);
      const indexes = Array.from(store.indexNames).map((indexName) => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      });
      const [keys, values] = skip.includes(storeName) ? [[], []] : await Promise.all([wrap(store.getAllKeys()), wrap(store.getAll())]);
      return { name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys, values };
    }));
    return { version: db.version, stores };
  } finally {
    db.close();
  }
}

/** Creates a database from a snapshot. Refuses a name that already holds data: restores never replace. */
export async function restoreDatabase(name: string, snapshot: DatabaseSnapshot): Promise<void> {
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || !Array.isArray(snapshot.stores) || new Set(snapshot.stores.map((s) => s.name)).size !== snapshot.stores.length ||
    snapshot.stores.some((s) => typeof s.name !== "string" || !Array.isArray(s.keys) || !Array.isArray(s.values) || s.keys.length !== s.values.length)) throw new Error("This backup's database is malformed");
  let fresh = true, created = false, failure = null as DOMException | null;
  const request = indexedDB.open(name, snapshot.version);
  request.onupgradeneeded = (event) => {
    if (event.oldVersion !== 0) { fresh = false; request.transaction?.abort(); return; }
    created = true;
    // A write that fails (no room left, say) aborts the upgrade: its reason, not the open request's "AbortError", is the error.
    const upgrade = request.transaction!;
    upgrade.addEventListener("abort", () => { failure = upgrade.error; });
    for (const entry of snapshot.stores) {
      const store = request.result.createObjectStore(entry.name, { keyPath: entry.keyPath, autoIncrement: entry.autoIncrement });
      for (const index of entry.indexes ?? []) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      entry.values.forEach((value, i) => (entry.keyPath === null ? store.put(value, entry.keys[i]) : store.put(value)));
    }
  };
  try {
    const db = await wrap(request);
    db.close();
  } catch (error) {
    throw fresh ? failure ?? error : new Error(`A database named ${name} already exists`);
  }
  // Opened at the same version without an upgrade: it existed, and nothing was written.
  if (!fresh || !created) throw new Error(`A database named ${name} already exists`);
}

/** The shape of a snapshot's stores, without their rows. */
export type StoreShape = Omit<StoreSnapshot, "keys" | "values">;

/**
 * Creates an empty database with these stores, for a restore that writes its rows a batch at a time (`putRows`).
 * Refuses a name that already holds data: restores never replace. The caller closes what it gets.
 */
export async function createDatabase(name: string, version: number, stores: StoreShape[]): Promise<IDBDatabase> {
  if (!Number.isSafeInteger(version) || version < 1 || !Array.isArray(stores) || new Set(stores.map((s) => s?.name)).size !== stores.length || stores.some((s) => typeof s?.name !== "string")) throw new Error("This backup's database is malformed");
  let fresh = true, created = false;
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = (event) => {
    if (event.oldVersion !== 0) { fresh = false; request.transaction?.abort(); return; }
    created = true;
    for (const entry of stores) {
      const store = request.result.createObjectStore(entry.name, { keyPath: entry.keyPath, autoIncrement: entry.autoIncrement });
      for (const index of entry.indexes ?? []) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
    }
  };
  let db: IDBDatabase;
  try { db = await wrap(request); } catch (error) { throw fresh ? error : new Error(`A database named ${name} already exists`); }
  if (!fresh || !created) { db.close(); throw new Error(`A database named ${name} already exists`); }
  return db;
}

/** Writes one batch of rows to a store, in a transaction of its own. A failed write's own reason is the error. */
export async function putRows(db: IDBDatabase, name: string, keys: IDBValidKey[], values: unknown[]): Promise<void> {
  if (!Array.isArray(keys) || !Array.isArray(values) || keys.length !== values.length || !db.objectStoreNames.contains(name)) throw new Error("This backup's database is malformed");
  if (!values.length) return;
  const tx = db.transaction(name, "readwrite");
  const store = tx.objectStore(name);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The restore could not write to this device"));
    try { values.forEach((value, i) => (store.keyPath === null ? store.put(value, keys[i]) : store.put(value))); } catch (error) { try { tx.abort(); } catch { /* already over */ } reject(error); }
  });
}
