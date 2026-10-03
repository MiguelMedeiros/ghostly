/*
 * The push worker's read of the device state (WISP 06 § Push and the phone, "How the worker knows"): when a push
 * arrives it reads this profile's record in `ghostly-devices` itself, and needs no message from a page. A read never
 * makes the database: where it does not exist (no profile of this browser ever had a second device) the open is undone
 * before it happens, and the profile is on one device.
 *
 * Only what the worker shows is taken out of the record: the state, the name of the device the record names active,
 * and which of the person's devices each token this device gave out belongs to.
 */

/** What a push's notice depends on. Null: no device set (a profile on one device). */
export interface PushDeviceView {
  state: string;
  /** The device the record names active, by name, when it is another one. */
  active?: string;
  /** The tokens this device gave its other devices, each with that device's name. */
  tokens: Record<string, string>;
}

const DB = "ghostly-devices";
const STORE = "devices";

interface StoredRecord {
  state?: unknown;
  deviceSet?: unknown;
  activeSlot?: unknown;
  ownSlot?: unknown;
  push?: { own?: { tokens?: unknown } };
}

/** The view of a stored record. Pure, so it is tested without a worker. */
export function pushDeviceView(record: StoredRecord | undefined | null): PushDeviceView | null {
  if (!record || typeof record !== "object" || typeof record.state !== "string") return null;
  const slots = Array.isArray(record.deviceSet) ? record.deviceSet as ({ key?: unknown; name?: unknown } | null)[] : [];
  const nameOf = (key: string) => { const slot = slots.find((s) => s?.key === key); return typeof slot?.name === "string" ? slot.name : ""; };
  const activeSlot = typeof record.activeSlot === "number" ? slots[record.activeSlot] : undefined;
  const active = record.activeSlot !== record.ownSlot && typeof activeSlot?.name === "string" && activeSlot.name ? activeSlot.name : undefined;
  const tokens: Record<string, string> = {};
  const given = record.push?.own?.tokens;
  if (given && typeof given === "object") {
    for (const [key, token] of Object.entries(given as Record<string, unknown>)) {
      // A token of a device the set no longer lists names nobody: it wakes nothing.
      if (typeof token === "string" && slots.some((s) => s?.key === key)) tokens[token] = nameOf(key);
    }
  }
  return { state: record.state, ...(active ? { active } : {}), tokens };
}

/** Opens the database only if it is there: an open that would make it is aborted. */
function openExisting(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB); } catch { resolve(null); return; }
    let made = false;
    request.onupgradeneeded = () => { made = true; try { request.transaction?.abort(); } catch { /* already over */ } };
    request.onsuccess = () => { if (made) { request.result.close(); resolve(null); } else resolve(request.result); };
    request.onerror = (event) => { event.preventDefault?.(); resolve(null); };
    request.onblocked = () => resolve(null);
  });
}

/**
 * This profile's device view (`db`: its peer database's name), or null: no device set. A database that is there and
 * cannot be read is evidence of a device set: `unreadable`, which shows the quiet notices (a standby never rings).
 */
export async function readPushDeviceView(db: string | undefined): Promise<PushDeviceView | null> {
  if (!db) return null;
  const opened = await openExisting();
  if (!opened) return null;
  try {
    if (!opened.objectStoreNames.contains(STORE)) return null;
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = opened.transaction(STORE, "readonly").objectStore(STORE).get(db);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (stored === undefined) return null;
    return pushDeviceView(stored as StoredRecord) ?? { state: "unreadable", tokens: {} };
  } catch {
    return { state: "unreadable", tokens: {} };
  } finally {
    opened.close();
  }
}
