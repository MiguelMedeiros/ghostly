import type { Settings, StoredLink, StoredMessage, StoredService } from "../shared/types";

/**
 * Durable local state of the browser peer. Identity seeds live here the same
 * way Desktop keeps them in its WebView storage: local to this profile, never
 * published. Network presence is not stored; it only exists while the engine runs.
 */
const DB_NAME = "ghostly";
const DB_VERSION = 1;
const STORES = { links: "links", messages: "messages", services: "services", settings: "settings" } as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORES.links, { keyPath: "id" });
      db.createObjectStore(STORES.services, { keyPath: "id" });
      db.createObjectStore(STORES.settings);
      const messages = db.createObjectStore(STORES.messages, { keyPath: ["linkId", "id"] });
      messages.createIndex("byLink", "linkId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export const db = {
  async getLinks(): Promise<StoredLink[]> {
    return wrap((await store(STORES.links, "readonly")).getAll());
  },
  async putLink(link: StoredLink): Promise<void> {
    await wrap((await store(STORES.links, "readwrite")).put(link));
  },
  async deleteLink(linkId: string): Promise<void> {
    await wrap((await store(STORES.links, "readwrite")).delete(linkId));
    const messages = await store(STORES.messages, "readwrite");
    const keys = await wrap(messages.index("byLink").getAllKeys(linkId));
    await Promise.all(keys.map((key) => wrap(messages.delete(key))));
  },

  async getMessages(linkId: string): Promise<StoredMessage[]> {
    const messages = await wrap<StoredMessage[]>((await store(STORES.messages, "readonly")).index("byLink").getAll(linkId));
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  },
  /** Returns false when the message was already stored. */
  async addMessage(message: StoredMessage): Promise<boolean> {
    const messages = await store(STORES.messages, "readwrite");
    if (await wrap(messages.getKey([message.linkId, message.id]))) return false;
    await wrap(messages.put(message));
    return true;
  },

  async getServices(): Promise<StoredService[]> {
    return wrap((await store(STORES.services, "readonly")).getAll());
  },
  async putService(service: StoredService): Promise<void> {
    await wrap((await store(STORES.services, "readwrite")).put(service));
  },
  async deleteService(serviceId: string): Promise<void> {
    await wrap((await store(STORES.services, "readwrite")).delete(serviceId));
  },

  async getSettings(): Promise<Partial<Settings>> {
    return (await wrap((await store(STORES.settings, "readonly")).get("settings"))) ?? {};
  },
  async putSettings(settings: Settings): Promise<void> {
    await wrap((await store(STORES.settings, "readwrite")).put(settings, "settings"));
  },
};
