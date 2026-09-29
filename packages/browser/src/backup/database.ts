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

/** Every store of a database: its shape, keys and values, read in one transaction. */
export async function snapshotDatabase(name: string): Promise<DatabaseSnapshot | null> {
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
      const [keys, values] = await Promise.all([wrap(store.getAllKeys()), wrap(store.getAll())]);
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
  let fresh = true, created = false;
  const request = indexedDB.open(name, snapshot.version);
  request.onupgradeneeded = (event) => {
    if (event.oldVersion !== 0) { fresh = false; request.transaction?.abort(); return; }
    created = true;
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
    throw fresh ? error : new Error(`A database named ${name} already exists`);
  }
  // Opened at the same version without an upgrade: it existed, and nothing was written.
  if (!fresh || !created) throw new Error(`A database named ${name} already exists`);
}
