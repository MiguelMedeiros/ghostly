/*
 * When each wake-up token last made a notice show, so the push worker can keep one contact from flooding the screen
 * (`wakeNoticeDue`). A database of its own, not a store in `ghostly-wake`: pages of an older build open that one at
 * its version, and a new store would need a new version. A worker is stopped between pushes, so memory alone would
 * forget; it is the fallback when IndexedDB cannot be opened. It holds a token, a kind and a time, nothing else.
 */
import { wakeNoticeDue } from "./policy";

const DB = "ghostly-wake-limit";
const SHOWN = "shown";

const memory = new Map<string, number>();

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHOWN);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Checks and records in one transaction, so two pushes handled at once cannot both show. */
async function takeFromDb(key: string, call: boolean, now: number): Promise<boolean> {
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
      transaction.oncomplete = () => resolve(due);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function takeFromMemory(key: string, call: boolean, now: number): boolean {
  if (!wakeNoticeDue(memory.get(key), call, now)) return false;
  memory.set(key, now);
  return true;
}

/**
 * Whether this token's wake-up may show a notice now, recording it when it may. A call and a message are counted
 * apart (`WAKE_NOTICE_GAP_MS`).
 */
export async function takeWakeSlot(profile: string, token: string, call: boolean, now = Date.now()): Promise<boolean> {
  const key = `${profile}|${token}|${call ? "call" : "message"}`;
  try {
    if (typeof indexedDB === "undefined") throw new Error("no IndexedDB");
    return await takeFromDb(key, call, now);
  } catch {
    return takeFromMemory(key, call, now);
  }
}

/** Tests only: what the memory fallback holds. */
export function resetWakeLimitMemory(): void {
  memory.clear();
}
