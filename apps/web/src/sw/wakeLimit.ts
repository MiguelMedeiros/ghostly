/*
 * When each wake-up token last made a notice show, so the push worker can keep one contact from flooding the screen
 * (`wakeNoticeDue`). A database of its own, not a store in `ghostly-wake`: pages of an older build open that one at
 * its version, and a new store would need a new version. A worker is stopped between pushes, so memory alone would
 * forget; it is the fallback when IndexedDB cannot be opened. It holds a token, a kind and a time, nothing else.
 */
import { WAKE_NOTICE_GAP_MS, wakeNoticeDue } from "./policy";

const DB = "ghostly-wake-limit";
const SHOWN = "shown";

const memory = new Map<string, number>();

/**
 * The longest gap: a row older than this answers as no row would, so it can go. One as far ahead goes too (a clock set
 * back); one only a little ahead stays: two pushes handled at once may write their rows out of order.
 */
const KEEP_MS = Math.max(...Object.values(WAKE_NOTICE_GAP_MS));

function spent(last: number, now: number): boolean {
  return Math.abs(now - last) >= KEEP_MS;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHOWN);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Checks and records in one transaction, so two pushes handled at once cannot both show. It also drops the rows that
 * no longer limit anything: a token changes when a chat is muted or deleted, or push is subscribed again, and the old
 * token's rows would otherwise stay for good.
 */
async function takeFromDb(key: string, call: boolean | "online", now: number): Promise<boolean> {
  const db = await open();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction(SHOWN, "readwrite");
      const store = transaction.objectStore(SHOWN);
      let due = false;
      const read = store.get(key);
      read.onsuccess = () => {
        const last = typeof read.result === "number" ? read.result : undefined;
        due = wakeNoticeDue(last, call, now);
        if (due) store.put(now, key);
      };
      const rows = store.openCursor();
      rows.onsuccess = () => {
        const row = rows.result;
        if (!row) return;
        if (row.key !== key && (typeof row.value !== "number" || spent(row.value, now))) row.delete();
        row.continue();
      };
      transaction.oncomplete = () => resolve(due);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function takeFromMemory(key: string, call: boolean | "online", now: number): boolean {
  for (const [other, last] of memory) if (other !== key && spent(last, now)) memory.delete(other);
  if (!wakeNoticeDue(memory.get(key), call, now)) return false;
  memory.set(key, now);
  return true;
}

/**
 * Whether this token's wake-up may show a notice now, recording it when it may. A call (true), a message (false) and
 * an online notice ("online") are counted apart (`WAKE_NOTICE_GAP_MS`).
 */
export async function takeWakeSlot(profile: string, token: string, call: boolean | "online", now = Date.now()): Promise<boolean> {
  const key = `${profile}|${token}|${call === "online" ? "online" : call ? "call" : "message"}`;
  try {
    if (typeof indexedDB === "undefined") throw new Error("no IndexedDB");
    return await takeFromDb(key, call, now);
  } catch {
    return takeFromMemory(key, call, now);
  }
}

/** Forgets what this profile's tokens showed, when it stops being woken (`unsubscribePush`: push off, profile deleted). */
export async function clearWakeLimit(profile: string): Promise<void> {
  const prefix = `${profile}|`;
  for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key);
  if (typeof indexedDB === "undefined") return;
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(SHOWN, "readwrite");
      transaction.objectStore(SHOWN).delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Tests only: what the memory fallback holds. */
export function resetWakeLimitMemory(): void {
  memory.clear();
}
