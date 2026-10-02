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
/** The schema this build reads and writes. A database stored at a higher one is a newer build's: it is never opened. */
export const DB_VERSION = 11;

/**
 * Why the profile's database did not open. `newer`: a newer Ghostly stored it (IndexedDB never opens a database below
 * its stored version). `blocked`: another window still holds it open at an older version. `full`: no storage space.
 * `denied`: the browser gives this page no storage (a private window, storage blocked for the site). `failed`:
 * anything else, a damaged database included (browsers do not tell that one apart).
 */
export type ProfileOpenReason = "newer" | "blocked" | "full" | "denied" | "failed";

/** What the pages are told (a plain object: it crosses the extension's port), and what a bot reads in `details`. */
export interface ProfileOpenFailure {
  reason: ProfileOpenReason;
  /** The schema version this build reads (`DB_VERSION`). */
  supportedVersion: number;
  /** The version the database is stored at, when it could be read (`newer`). */
  storedVersion?: number;
  /** What the browser said, in its own words. */
  detail?: string;
}

/** The profile's database did not open. Nothing was changed, and nothing is ever deleted or reset because of it. */
export class ProfileOpenError extends Error {
  constructor(readonly failure: ProfileOpenFailure) {
    super(profileOpenMessage(failure));
    this.name = "ProfileOpenError";
  }
}

/** The failure in plain English, for logs, the CLI and anything that shows an engine error as it came. */
export function profileOpenMessage(failure: ProfileOpenFailure): string {
  const could = "Ghostly could not open this profile's data";
  switch (failure.reason) {
    case "newer":
      return `This profile was last used by a newer version of Ghostly (its data is version ${failure.storedVersion ?? "above " + failure.supportedVersion}, this version reads up to ${failure.supportedVersion}). Update Ghostly to open it.`;
    case "blocked": return `${could}: another Ghostly window or tab still has it open with an older version. Close it and try again.`;
    case "full": return `${could}: this device is out of storage space. Free some space and try again.`;
    case "denied": return `${could}: storage is not allowed here (a private window, or storage blocked for this site).`;
    default: return `${could}${failure.detail ? `: ${failure.detail}` : ""}`;
  }
}

/** What the start of the engine failed with, as the failure the pages show: a database that did not open, or anything else. */
export function profileOpenFailure(error: unknown): ProfileOpenFailure {
  if (error instanceof ProfileOpenError) return error.failure;
  const detail = error instanceof Error ? error.message : String(error);
  return { reason: "failed", supportedVersion: DB_VERSION, ...(detail ? { detail } : {}) };
}

/** How long an open that another window blocks may wait for that window to let go before it is said to be blocked. */
export const OPEN_TIMINGS = { blockedMs: 10_000 };

function failureOf(error: unknown): ProfileOpenFailure {
  const name = (error as { name?: unknown } | null)?.name;
  const message = (error as { message?: unknown } | null)?.message;
  const detail = [typeof name === "string" ? name : "", typeof message === "string" ? message : ""].filter(Boolean).join(": ");
  const reason: ProfileOpenReason = name === "VersionError" ? "newer"
    : name === "QuotaExceededError" ? "full"
      // Firefox's private windows of old, storage blocked for the site, or no IndexedDB at all.
      : name === "BlockedError" ? "blocked"
      : name === "SecurityError" || name === "InvalidStateError" || name === "ReferenceError" || name === "TypeError" ? "denied"
        : "failed";
  return { reason, supportedVersion: DB_VERSION, ...(detail ? { detail } : {}) };
}

/**
 * The version a database is stored at, read without changing it: an open that names no version opens what is there.
 * Only for a database known to exist (an open without a version would make a missing one).
 */
function storedVersion(name: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(name);
      // It did not exist after all: leave nothing behind.
      request.onupgradeneeded = () => { try { request.transaction?.abort(); } catch { /* already over */ } };
      request.onsuccess = () => { const { version } = request.result; request.result.close(); resolve(version); };
      request.onerror = request.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}
/** The messages store's index of card messages (`card.kind`): what `db.getCardMessages` reads. */
export const CARD_INDEX = "byCardKind";

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
    let settled = false;
    let blocked: ReturnType<typeof setTimeout> | undefined;
    // Said once, as what it is (`ProfileOpenError`): the engine does not start, and the pages show why.
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(blocked);
      const failure = failureOf(error);
      if (failure.reason !== "newer") { reject(new ProfileOpenError(failure)); return; }
      void storedVersion(dbName).then((version) => reject(new ProfileOpenError({ ...failure, ...(version !== undefined ? { storedVersion: version } : {}) })));
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName, DB_VERSION);
    } catch (error) {
      fail(error);
      return;
    }
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
      // v10: a chat's messages in time order, so its latest page is read without the rest.
      const messages = request.transaction!.objectStore(STORES.messages);
      if (!messages.indexNames.contains("byLinkTime")) messages.createIndex("byLinkTime", ["linkId", "timestamp"]);
      // v11: the messages that carry a status card, by the card's kind, across every chat and group (the Tasks board).
      // A message without a card has no such key and is not in it, so the index is as small as the cards are few.
      if (!messages.indexNames.contains(CARD_INDEX)) messages.createIndex(CARD_INDEX, "card.kind");
    };
    request.onsuccess = () => {
      // Opened after it was said to be blocked: nobody uses this connection, and it must not block the next open.
      if (settled) { request.result.close(); return; }
      settled = true;
      clearTimeout(blocked);
      // Let the other context upgrade the schema instead of blocking it.
      request.result.onversionchange = () => {
        request.result.close();
        dbPromise = null;
      };
      resolve(request.result);
    };
    // The event's default aborts nothing here, but an unhandled one is logged as an uncaught error in some browsers.
    request.onerror = (event) => { event.preventDefault?.(); fail(request.error); };
    // Another window holds the database at an older version and has not let go (ours do, on `versionchange`). The
    // open stays pending for as long as that lasts: before, the engine waited with it, silently and for good.
    request.onblocked = () => {
      blocked ??= setTimeout(() => fail({ name: "BlockedError", message: "another connection holds an older version open" }), OPEN_TIMINGS.blockedMs);
    };
  });
  return dbPromise;
}

/** The stores "Clear all data" empties: chats and their keys, messages, files, shared apps, groups. */
export const PROFILE_STORES = [STORES.links, STORES.messages, STORES.files, STORES.fileState, STORES.fileChunks, STORES.services, STORES.groups] as const;

/**
 * Records of the settings store that belong to the profile, not to a wallet: its DID and its key, its identity proofs
 * with their keys and revocations, its own Nostr data, the public profiles it read. A list of what goes rather than of
 * what stays, on purpose: every other record of that store is a wallet's (seeds, configuration, pending operations),
 * and a wallet record a newer version adds must never be deleted by mistake.
 */
export const PROFILE_SETTINGS_KEYS = ["profileDid", "identityProofs", "identityRevocations", "nostrSocial", "publicProfiles"] as const;

/**
 * The fields of the peer's `settings` record that are a wallet's, kept by "Clear all data": the mint list, the first-run
 * wallet setup and the backup reminders. Everything else in it is the profile's (name, picture, network settings,
 * storage credentials for held items, the push subscription and who holds it) and goes.
 */
export const WALLET_SETTINGS_FIELDS = ["mints", "mintsInitialized", "walletSetup", "backupReminders"] as const;

/**
 * "Clear all data" (WISP 04): everything of the profile in its peer database except its wallets. The chats' stores are
 * emptied, the profile's records of the settings store are deleted and the `settings` record keeps only its wallet
 * fields. The wallets (proofs, payments, quotes, history, payment journal, wallet records) stay: ecash is money, and
 * nothing else holds a copy of it. The caller stops the peer first, or it may write back what was just deleted.
 */
export async function clearProfileStores(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  const names = [...PROFILE_STORES, STORES.settings].filter((name) => db.objectStoreNames.contains(name));
  const tx = db.transaction(names, "readwrite");
  for (const name of names) if (name !== STORES.settings) tx.objectStore(name).clear();
  if (names.includes(STORES.settings)) {
    const settings = tx.objectStore(STORES.settings);
    for (const key of PROFILE_SETTINGS_KEYS) settings.delete(key);
    const read = settings.get("settings");
    read.onsuccess = () => {
      const record = read.result as Record<string, unknown> | undefined;
      if (!record || typeof record !== "object") return;
      const kept = Object.fromEntries(WALLET_SETTINGS_FIELDS.filter((field) => field in record).map((field) => [field, record[field]]));
      settings.put(kept, "settings");
    };
  }
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
