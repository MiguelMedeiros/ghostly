/**
 * The extension's one IndexedDB database. The peer (offscreen document) and
 * the pages share an origin, so both open it: that is also how file contents
 * move between them without squeezing through runtime messages.
 */
let dbName = "ghostly";

/** Before first use: keeps profiles that share a browser storage area apart (Desktop's GHOSTLY_PROFILE). */
export function setDatabaseName(name: string): void {
  dbName = name;
}
const DB_VERSION = 5;

export const STORES = {
  links: "links",
  messages: "messages",
  services: "services",
  settings: "settings",
  files: "files",
  proofs: "proofs",
  payments: "payments",
  quotes: "quotes",
  walletTx: "walletTx",
  melts: "melts",
} as const;

/**
 * A file's contents. Metadata travels with the chat message; this is only the bytes.
 * Ids are `<link id>-out-<random>` for files we send and `<link id>-in-<random>` for
 * files we receive, both chosen here. Files stored before that are `<link id>-<wire id>`
 * without `direction` and are still read under their old id.
 */
export interface StoredFile {
  id: string;
  linkId: string;
  blob: Blob;
  createdAt: number;
  direction?: "in" | "out";
  /** The id the file had on the data link. */
  wireId?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const has = (name: string) => db.objectStoreNames.contains(name);
      if (!has(STORES.links)) db.createObjectStore(STORES.links, { keyPath: "id" });
      if (!has(STORES.services)) db.createObjectStore(STORES.services, { keyPath: "id" });
      if (!has(STORES.settings)) db.createObjectStore(STORES.settings);
      if (!has(STORES.messages)) {
        db.createObjectStore(STORES.messages, { keyPath: ["linkId", "id"] }).createIndex("byLink", "linkId");
      }
      if (!has(STORES.proofs)) db.createObjectStore(STORES.proofs, { keyPath: "secret" });
      if (!has(STORES.payments)) db.createObjectStore(STORES.payments, { keyPath: "id" });
      if (!has(STORES.quotes)) db.createObjectStore(STORES.quotes, { keyPath: "quote" });
      if (!has(STORES.walletTx)) db.createObjectStore(STORES.walletTx, { keyPath: "id" });
      // v5: Lightning payments the mint has not settled yet, and the proofs they hold.
      if (!has(STORES.melts)) db.createObjectStore(STORES.melts, { keyPath: "quote" });
      if (!has(STORES.files)) {
        db.createObjectStore(STORES.files, { keyPath: "id" }).createIndex("byLink", "linkId");
      }
    };
    request.onsuccess = () => {
      // Let the other context upgrade the schema instead of blocking it.
      request.result.onversionchange = () => {
        request.result.close();
        dbPromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/**
 * "Clear all data": chats, messages, files and shared services. The wallet
 * (proofs, payments, quotes, history) and the mint list stay: ecash is money,
 * and nothing else holds a copy of it.
 */
export async function clearChatData(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const names = [STORES.links, STORES.messages, STORES.files, STORES.services];
  const tx = (await openDb()).transaction(names, "readwrite");
  for (const name of names) tx.objectStore(name).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

/**
 * Several writes across stores in one transaction: they all land, or none does.
 * `work` only queues requests; the promise settles when the transaction does.
 */
export async function transact(names: string[], work: (stores: Record<string, IDBObjectStore>) => void): Promise<void> {
  const tx = (await openDb()).transaction(names, "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("The wallet could not save"));
    tx.onerror = () => reject(tx.error ?? new Error("The wallet could not save"));
  });
  try {
    work(Object.fromEntries(names.map((name) => [name, tx.objectStore(name)])));
  } catch (error) {
    tx.abort();
    await done.catch(() => {});
    throw error;
  }
  return done;
}

export const fileStore = {
  async put(file: StoredFile): Promise<void> {
    await wrap((await store(STORES.files, "readwrite")).put(file));
  },
  async get(id: string): Promise<StoredFile | undefined> {
    return wrap((await store(STORES.files, "readonly")).get(id));
  },
  async listForLink(linkId: string): Promise<StoredFile[]> {
    return wrap((await store(STORES.files, "readonly")).index("byLink").getAll(linkId));
  },
  async delete(id: string): Promise<void> {
    await wrap((await store(STORES.files, "readwrite")).delete(id));
  },
  async deleteForLink(linkId: string): Promise<void> {
    const files = await store(STORES.files, "readwrite");
    const keys = await wrap(files.index("byLink").getAllKeys(linkId));
    await Promise.all(keys.map((key) => wrap(files.delete(key))));
  },
};
