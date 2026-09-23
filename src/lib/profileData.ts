import { databaseExists } from "@ghostly/browser/backup/database";
import { activeProfileId, listProfiles, namespaceOf, settingsKeyFor, unregisterProfile } from "./profiles";
import { verifyPassword } from "./settings";

/** What deleting a profile would take away, read from its own storage without starting it. */
export interface ProfileSummary { chats: number; cashuSats: number; ark: boolean; usdt: boolean; services: number }

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
async function openExisting(name: string): Promise<IDBDatabase | null> {
  return (await databaseExists(name)) ? request(indexedDB.open(name)) : null;
}
function chatsOf(prefix: string): number {
  let count = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix) && !key.slice(prefix.length).includes("_")) count++;
  }
  return count;
}

export async function profileSummary(id: string): Promise<ProfileSummary> {
  const ns = namespaceOf(id);
  const summary: ProfileSummary = { chats: chatsOf(`ghostly_${ns}_`), cashuSats: 0, ark: false, usdt: false, services: 0 };
  const db = await openExisting(`ghostly_${ns}`);
  if (!db) return summary;
  try {
    const has = (name: string) => db.objectStoreNames.contains(name);
    const tx = db.transaction(["proofs", "settings", "services"].filter(has), "readonly");
    if (has("proofs")) summary.cashuSats = (await request(tx.objectStore("proofs").getAll()) as { amount: number; reserved?: boolean }[]).reduce((sum, p) => sum + (p.reserved ? 0 : p.amount), 0);
    if (has("settings")) { const keys = await request(tx.objectStore("settings").getAllKeys()); summary.ark = keys.includes("arkWallet"); summary.usdt = keys.includes("usdtWallet"); }
    if (has("services")) summary.services = (await request(tx.objectStore("services").count()));
  } finally { db.close(); }
  return summary;
}

function drop(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("This profile is open in another window. Close it, then try again."));
  });
}

const databaseOf = (id: string) => (namespaceOf(id) ? `ghostly_${namespaceOf(id)}` : "ghostly");

/** The Ark wallets a profile's database names, current and retired. */
async function arkWalletIds(dbName: string): Promise<string[]> {
  const db = await openExisting(dbName);
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("settings")) return [];
    const store = db.transaction("settings", "readonly").objectStore("settings");
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return keys.flatMap((key, i) => {
      const walletId = (values[i] as { config?: { walletId?: string } })?.config?.walletId;
      return walletId && typeof key === "string" && key.startsWith("arkWallet") ? [walletId] : [];
    });
  } finally { db.close(); }
}

/** The password hash of a profile's lock screen, when it has one turned on. */
export function profileLock(id: string): string | null {
  try {
    const lock = (JSON.parse(localStorage.getItem(settingsKeyFor(id)) ?? "{}") as { lockScreen?: { enabled?: boolean; passwordHash?: string | null } }).lockScreen;
    return lock?.enabled && lock.passwordHash ? lock.passwordHash : null;
  } catch { return null; }
}

/**
 * Another profile's data is only read or removed from here with its lock password, when it has a lock:
 * being able to open one profile must not open the others.
 */
export async function assertUnlocked(id: string, password?: string): Promise<void> {
  if (id === activeProfileId()) return;
  const hash = profileLock(id);
  if (hash && !(password && (await verifyPassword(password, hash)))) throw new Error("Wrong lock password for that profile");
}

/** Another tab running this profile holds its peer lock (see the entry points). */
async function runningElsewhere(ns: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.locks?.query) return false;
  const { held = [] } = await navigator.locks.query();
  return held.some((lock) => lock.name === `ghostly-peer-${ns}`);
}

/**
 * Deletes a profile of this space for good: its local keys, its peer database and its Ark wallets'
 * databases, then its place on the list (WISP 04). Never the active one, never the first, never one
 * running in another tab, and never an Ark database another profile still uses.
 */
export async function deleteProfile(id: string, password?: string): Promise<void> {
  if (!id) throw new Error("The first profile cannot be deleted");
  if (id === activeProfileId()) throw new Error("Switch to another profile first");
  await assertUnlocked(id, password);
  const ns = namespaceOf(id), dbName = `ghostly_${ns}`;
  if (await runningElsewhere(ns)) throw new Error("This profile is open in another window. Close it, then try again.");
  const others = new Set((await Promise.all(listProfiles().filter((p) => p.id !== id).map((p) => arkWalletIds(databaseOf(p.id))))).flat());
  const arkIds = (await arkWalletIds(dbName)).filter((walletId) => !others.has(walletId));
  if (await databaseExists(dbName)) await drop(dbName);
  for (const walletId of arkIds) await drop(`ghostly-ark-${walletId}`);
  const prefix = `ghostly_${ns}_`;
  for (const key of Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k?.startsWith(prefix))) localStorage.removeItem(key);
  unregisterProfile(id);
}
