/**
 * The extension's one IndexedDB database. The peer (offscreen document) and
 * the pages share an origin, so both open it: that is also how file contents
 * move between them without squeezing through runtime messages.
 */
const DB_NAME = "ghostly";
const DB_VERSION = 3;

export const STORES = {
  links: "links",
  messages: "messages",
  services: "services",
  settings: "settings",
  files: "files",
  proofs: "proofs",
  payments: "payments",
  quotes: "quotes",
} as const;

/** A file's contents. Metadata travels with the chat message; this is only the bytes. */
export interface StoredFile {
  id: string;
  linkId: string;
  blob: Blob;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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

export function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export const fileStore = {
  async put(file: StoredFile): Promise<void> {
    await wrap((await store(STORES.files, "readwrite")).put(file));
  },
  async get(id: string): Promise<StoredFile | undefined> {
    return wrap((await store(STORES.files, "readonly")).get(id));
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
