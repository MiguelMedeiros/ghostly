/*
 * What the push worker needs to know to show a wake-up (WISP 401 § Wake-up push), written by the app's page:
 * which chat each per-contact token names, whether that chat is muted, and the words to show. IndexedDB, since
 * a worker cannot read the page's localStorage. It holds no key and no message: a token, a route and a time.
 */

export interface WakeEntry {
  token: string;
  /** Where a tap opens: `/chat/<session id>`. */
  path: string;
  /** Muted until then (ms since the epoch), or for good; absent when it is not muted. */
  mutedUntil?: number | "forever";
}

export interface WakeText {
  title: string;
  body: string;
  /** What a call wake-up says ("Incoming call"), in the app's language. */
  call?: string;
  /**
   * In a profile on several devices (WISP 06 § Push and the phone), the words of a device that is not the active one,
   * with `{device}` where a device's name goes: a message ("New message. Active on {device}."), a call, the same without
   * a name, and a wake-up from another of the person's devices ("{device} wants to take over. Open Ghostly.", or, on a
   * standby, "{device} wants to move this profile here.").
   */
  standby?: string;
  standbyCall?: string;
  standbyUnnamed?: string;
  standbyCallUnnamed?: string;
  takeover?: string;
  moveHere?: string;
  /**
   * The profile's peer database name: the key of its device record in `ghostly-devices`, which the worker reads when a
   * push arrives. It changes when a handoff installs a new namespace, so every page writes it when it starts.
   */
  db?: string;
}

const DB = "ghostly-wake";
const TOKENS = "tokens";
const TEXT = "text";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(TOKENS);
      request.result.createObjectStore(TEXT);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const key = (profile: string, token: string) => `${profile}|${token}`;

/** This profile's tokens, all of them (the ones no longer listed are gone), and the words to show. */
export async function writeWakeEntries(profile: string, entries: readonly WakeEntry[], text: WakeText): Promise<void> {
  const db = await open();
  try {
    const transaction = db.transaction([TOKENS, TEXT], "readwrite");
    const tokens = transaction.objectStore(TOKENS);
    const prefix = `${profile}|`;
    tokens.delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    for (const entry of entries) tokens.put(entry, key(profile, entry.token));
    transaction.objectStore(TEXT).put(text, profile);
    await done(transaction);
  } finally {
    db.close();
  }
}

/**
 * The words to show and the profile's database name, its tokens left as they are: what a standby's page writes (it
 * holds no chats to list), and what a never-active device needs for its first push.
 */
export async function writeWakeText(profile: string, text: WakeText): Promise<void> {
  const db = await open();
  try {
    const transaction = db.transaction([TEXT], "readwrite");
    transaction.objectStore(TEXT).put(text, profile);
    await done(transaction);
  } finally {
    db.close();
  }
}

/** The words and database name of this profile, whatever token a push carries; undefined when no page wrote them. */
export async function readWakeText(profile: string): Promise<WakeText | undefined> {
  const db = await open();
  try {
    return await get<WakeText>(db, TEXT, profile);
  } finally {
    db.close();
  }
}

/** Forgets everything of this profile (push turned off, its data cleared): its tokens and its words. */
export async function clearWakeEntries(profile: string): Promise<void> {
  const db = await open();
  try {
    const transaction = db.transaction([TOKENS, TEXT], "readwrite");
    const prefix = `${profile}|`;
    transaction.objectStore(TOKENS).delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    transaction.objectStore(TEXT).delete(profile);
    await done(transaction);
  } finally {
    db.close();
  }
}

function get<T>(db: IDBDatabase, store: string, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** The chat a token names in this profile, and the words to show; undefined for a token it no longer knows. */
export async function readWakeEntry(profile: string, token: string): Promise<{ entry: WakeEntry; text: WakeText } | undefined> {
  const db = await open();
  try {
    const entry = await get<WakeEntry>(db, TOKENS, key(profile, token));
    if (!entry) return undefined;
    const text = await get<WakeText>(db, TEXT, profile);
    return { entry, text: text?.title ? text : { title: "Ghostly", body: "New message" } };
  } finally {
    db.close();
  }
}
