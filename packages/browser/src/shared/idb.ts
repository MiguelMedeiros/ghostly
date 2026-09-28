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
/** The peer database this page uses: its profile's (WISP 04). */
export function databaseName(): string {
  return dbName;
}
const DB_VERSION = 9;

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
  intents: "paymentIntents",
  /** Private groups (WISP 900): membership chain, epoch secrets and my own recent messages, by group id. */
  groups: "groups",
  /** Files kept in 1 MiB pieces where the platform has no file system for them (see `fileBytesIdb.ts`). */
  fileChunks: "fileChunks",
  /**
   * What changes about a stored file after it is stored, by file id. A `files` record is written once and never
   * again: WebKit loses the Blob of a record written back with the Blob it read (see `fileStore`).
   */
  fileState: "fileState",
} as const;

/**
 * A file's contents. Metadata travels with the chat message; this is only the bytes: in `blob` for a file
 * small enough to hold whole, or in the platform's file storage (`bytes`, see `fileBytes.ts`) under the same id.
 * Ids are `<link id>-out-<random>` for files we send and `<link id>-in-<random>` for
 * files we receive, both chosen here. Files stored before that are `<link id>-<wire id>`
 * without `direction` and are still read under their old id.
 */
export interface StoredFile {
  id: string;
  linkId: string;
  blob?: Blob;
  /** Where the bytes are when there is no `blob`. */
  bytes?: import("./fileBytes").FileBytesKind;
  createdAt: number;
  direction?: "in" | "out";
  /** The id the file had on the data link. */
  wireId?: string;
  digest?: string;
  metadata?: { name: string; size: number; mime: string; timestamp: number; voice?: import("@ghostly/core").VoiceMeta; video?: import("@ghostly/core").VideoMeta; image?: import("@ghostly/core").ImageMeta };
  transfer?: { state: "transferring" | "done" | "failed"; transferred: number; size: number; error?: string };
  /** files/3: the transfer's own record (`@ghostly/core` `FileTransferRecord`), kept so it resumes after a restart. */
  wire3?: import("@ghostly/core").FileTransferRecord;
}

/** The fields of a stored file that change after it is stored: kept in `STORES.fileState`, read over the record's own. */
type FileStateFields = Partial<Pick<StoredFile, "bytes" | "digest" | "transfer" | "wire3">>;
type FileState = { id: string } & FileStateFields;

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
      if (!has(STORES.intents)) db.createObjectStore(STORES.intents, { keyPath: "review.id" });
      if (!has(STORES.files)) {
        db.createObjectStore(STORES.files, { keyPath: "id" }).createIndex("byLink", "linkId");
      }
      // v7: private groups.
      if (!has(STORES.groups)) db.createObjectStore(STORES.groups, { keyPath: "id" });
      // v8: files in pieces, for platforms without the origin-private file system.
      if (!has(STORES.fileChunks)) db.createObjectStore(STORES.fileChunks, { keyPath: ["id", "index"] });
      // v9: what changes about a stored file, apart from its record (see `fileStore`).
      if (!has(STORES.fileState)) db.createObjectStore(STORES.fileState, { keyPath: "id" });
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
  const names = [STORES.links, STORES.messages, STORES.files, STORES.fileState, STORES.fileChunks, STORES.services, STORES.groups];
  const tx = (await openDb()).transaction(names, "readwrite");
  for (const name of names) tx.objectStore(name).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Deletes a database of the origin by name (an SDK's own), as far as the browser lets it: blocked or failed, it gives up quietly. */
export function deleteDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); } catch { resolve(); }
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

/** A stored file as it stands: its record, with what changed since it was stored read over it. */
function withState(file: StoredFile, state: FileState | undefined): StoredFile {
  if (!state) return file;
  const { id: _id, ...fields } = state;
  return { ...file, ...fields };
}

/**
 * The files store. A record is written once, by `put`, and never written back: what changes later (`patch`,
 * `updateTransfer`) goes to `STORES.fileState` and is read over it. WebKit (Safari, the macOS app) keeps a stored
 * Blob as a file the record points to, and a record written back with the Blob it read can lose that file: from
 * then on every read of it fails with "The object can not be found here." For the same reason a Blob read from
 * here is never put here again, under any id (a forward copies the bytes into a Blob of its own).
 */
export const fileStore = {
  /** Stores a file anew: whatever changed about an earlier file under this id is forgotten. */
  async put(file: StoredFile): Promise<void> {
    await transact([STORES.files, STORES.fileState], stores => {
      stores[STORES.files].put(file);
      stores[STORES.fileState].delete(file.id);
    });
  },
  async updateTransfer(id: string, transfer: NonNullable<StoredFile["transfer"]>): Promise<void> {
    await fileStore.patch(id, { transfer });
  },
  /** Changes some fields of a stored file (never its record, see above); nothing happens to one that was deleted. */
  async patch(id: string, fields: FileStateFields): Promise<void> {
    await transact([STORES.files, STORES.fileState], stores => {
      const exists = stores[STORES.files].getKey(id);
      exists.onsuccess = () => {
        if (exists.result === undefined) return;
        const state = stores[STORES.fileState].get(id);
        state.onsuccess = () => { stores[STORES.fileState].put({ ...(state.result as FileState | undefined), ...fields, id } satisfies FileState); };
      };
    });
  },
  async get(id: string): Promise<StoredFile | undefined> {
    const tx = (await openDb()).transaction([STORES.files, STORES.fileState], "readonly");
    const [file, state] = await Promise.all([
      wrap<StoredFile | undefined>(tx.objectStore(STORES.files).get(id)),
      wrap<FileState | undefined>(tx.objectStore(STORES.fileState).get(id)),
    ]);
    return file && withState(file, state);
  },
  async listForLink(linkId: string): Promise<StoredFile[]> {
    const tx = (await openDb()).transaction([STORES.files, STORES.fileState], "readonly");
    const files = await wrap<StoredFile[]>(tx.objectStore(STORES.files).index("byLink").getAll(linkId));
    const states = await Promise.all(files.map((file) => wrap<FileState | undefined>(tx.objectStore(STORES.fileState).get(file.id))));
    return files.map((file, i) => withState(file, states[i]));
  },
  async delete(id: string): Promise<void> {
    await transact([STORES.files, STORES.fileState], stores => {
      stores[STORES.files].delete(id);
      stores[STORES.fileState].delete(id);
    });
  },
  async deleteForLink(linkId: string): Promise<void> {
    const tx = (await openDb()).transaction([STORES.files, STORES.fileState], "readwrite");
    const files = tx.objectStore(STORES.files), state = tx.objectStore(STORES.fileState);
    const keys = await wrap(files.index("byLink").getAllKeys(linkId));
    await Promise.all(keys.flatMap((key) => [wrap(files.delete(key)), wrap(state.delete(key))]));
  },
};
