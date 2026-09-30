import { databaseExists } from "@ghostly/browser/backup/database";
import { dropFileSpace } from "@ghostly/browser/shared/fileBytes";
import { activeProfileId, listProfiles, namespaceOf, prefixOf, settingsKeyFor, unregisterProfile } from "./profiles";
import { unreadUnder } from "./storage";
import { peekFresh } from "./profilePeek";
import { verifyPassword } from "./settings";
import { pushPlatform } from "./wakePush";

/**
 * What deleting a profile would take away, read from its own storage without starting it. `wallets`: the kinds of
 * wallet it keeps (Cashu aside, counted in sats), each named once however many networks it has one on.
 */
export interface ProfileSummary { chats: number; cashuSats: number; wallets: WalletName[]; services: number }
export type WalletName = "Ark" | "USDT" | "Bark" | "Spark" | "Fedimint" | "Lightning" | "Bitcoin";

/**
 * The wallet a settings key holds, if it holds one in use. Each network's wallet is under `<rail>-mode-<network>`
 * (an older app kept one under the bare `<rail>`); an archived one (`-retired-`) is not counted.
 */
const WALLET_KEYS: [RegExp, WalletName][] = [
  [/^arkWallet(-mode-.+)?$/, "Ark"], [/^usdtWallet(-mode-.+)?$/, "USDT"], [/^barkWallet(-mode-.+)?$/, "Bark"], [/^sparkWallet(-mode-.+)?$/, "Spark"],
  [/^fedimintWallet-(mainnet|testnet)$/, "Fedimint"], [/^lightningSource-/, "Lightning"], [/^onchainSource-/, "Bitcoin"],
];
export function walletsIn(keys: readonly IDBValidKey[]): WalletName[] {
  const found = new Set<WalletName>();
  for (const key of keys) for (const [pattern, name] of WALLET_KEYS) if (typeof key === "string" && pattern.test(key)) found.add(name);
  return WALLET_KEYS.map(([, name]) => name).filter((name) => found.has(name));
}

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
  const summary: ProfileSummary = { chats: chatsOf(`ghostly_${ns}_`), cashuSats: 0, wallets: [], services: 0 };
  const db = await openExisting(`ghostly_${ns}`);
  if (!db) return summary;
  try {
    const has = (name: string) => db.objectStoreNames.contains(name);
    const tx = db.transaction(["proofs", "settings", "services"].filter(has), "readonly");
    if (has("proofs")) summary.cashuSats = (await request(tx.objectStore("proofs").getAll()) as { amount: number; reserved?: boolean }[]).reduce((sum, p) => sum + (p.reserved ? 0 : p.amount), 0);
    if (has("settings")) summary.wallets = walletsIn(await request(tx.objectStore("settings").getAllKeys()));
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
/** A profile's peer database (WISP 04). */
export const profileDatabase = databaseOf;

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
 * What the switcher shows of a profile that is not running: its picture, how many messages were left unread in its
 * chats, and in how many chats something new waits for it (`fresh`), as the running profile saw while checking the
 * others (WISP 04 § Checking other profiles). A locked profile shows none of it: only its name and that it is locked.
 */
export interface ProfileGlance { locked: boolean; unread: number; fresh: number; avatar?: string }
export async function profileGlance(id: string): Promise<ProfileGlance> {
  if (profileLock(id)) return { locked: true, unread: 0, fresh: 0 };
  return { locked: false, unread: unreadUnder(prefixOf(id)), fresh: peekFresh(id), avatar: await storedAvatar(databaseOf(id)) };
}
/** The picture a profile's peer keeps in its settings (WISP 04), if it is the small JPEG the peer accepts. */
async function storedAvatar(dbName: string): Promise<string | undefined> {
  try {
    const db = await openExisting(dbName);
    if (!db) return undefined;
    try {
      if (!db.objectStoreNames.contains("settings")) return undefined;
      const settings = await request(db.transaction("settings", "readonly").objectStore("settings").get("settings")) as { avatar?: unknown } | undefined;
      const avatar = settings?.avatar;
      return typeof avatar === "string" && avatar.startsWith("data:image/jpeg;base64,") && avatar.length < 45_000 ? avatar : undefined;
    } finally { db.close(); }
  } catch { return undefined; }
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

/** Another window runs that profile: it is online itself. */
export const runningElsewhere = (id: string) => lockHeld(namespaceOf(id));

/** Another tab running this profile holds its peer lock (see the entry points). */
async function lockHeld(ns: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.locks?.query) return false;
  const { held = [] } = await navigator.locks.query();
  // The default profile's lock is `ghostly-peer` on the web and in the extension, `ghostly-peer-` on Desktop.
  const names = ns ? [`ghostly-peer-${ns}`] : ["ghostly-peer", "ghostly-peer-"];
  return held.some((lock) => !!lock.name && names.includes(lock.name));
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
  if (await lockHeld(ns)) throw new Error("This profile is open in another window. Close it, then try again.");
  const others = new Set((await Promise.all(listProfiles().filter((p) => p.id !== id).map((p) => arkWalletIds(databaseOf(p.id))))).flat());
  const arkIds = (await arkWalletIds(dbName)).filter((walletId) => !others.has(walletId));
  if (await databaseExists(dbName)) await drop(dbName);
  await dropFileSpace(dbName).catch(() => {});
  for (const walletId of arkIds) await drop(`ghostly-ark-${walletId}`);
  const prefix = `ghostly_${ns}_`;
  for (const key of Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k?.startsWith(prefix))) localStorage.removeItem(key);
  // Its push subscription (WISP 401 § Wake-up push) ends with it: its worker goes, and contacts who kept it get 410.
  await pushPlatform()?.unsubscribe(id).catch(() => {});
  unregisterProfile(id);
}
