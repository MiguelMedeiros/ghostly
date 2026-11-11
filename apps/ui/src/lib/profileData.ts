import { WALLET_NETWORKS, identityFromSeedB64, type WalletNetwork } from "@ghostly/core";
import { databaseExists } from "@ghostly/browser/backup/database";
import { forgetServicesOf, releaseUnusedLocalAccessOf } from "@ghostly/browser/host";
import { runsEngine } from "@ghostly/browser/devices/state";
import { deviceStateOf, forgetDevice, readDeviceRecord } from "@ghostly/browser/devices/store";
import { handoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import { dropFileSpace } from "@ghostly/browser/shared/fileBytes";
import { dropBreezDatabasesOf } from "@ghostly/browser/engine/paymentAdapters/providers/breezDatabases";
import { activeProfileId, chosenProfileId, forgetProfileHere, homeDatabaseOf, listProfiles, namespaceOf, prefixOf, registryKey, settingsKeyFor, unregisterProfile } from "./profiles";
import { LEGACY_JOIN_PREFIX, originalKeyOwner, retryUnsaved, unreadUnder } from "./storage";
import { clearPeek, peekFresh, storeKey as peekStoreKey } from "./profilePeek";
import { lockRetryAt, tryLockPassword, waitMessage } from "./lockAttempts";
import { pushPlatform } from "./wakePush";
import { linkedFilesDatabase } from "./apps/webFiles";
import { resetIncomingShare } from "./incomingShare";

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
  // A profile this device is on standby for (WISP 06 § The gate): its database is not opened, even to count.
  if (!(await deviceStateOf(`ghostly_${ns}`).then(runsEngine, () => false))) return summary;
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

/**
 * `drop`, only if no other connection holds the database. A blocked delete is not withdrawn by giving up on it: it stays
 * queued and deletes the database once the holder closes. So the delete is asked from inside a version change, which
 * runs only when every other connection has closed; one that was blocked is refused when it finally runs.
 */
async function dropUnheld(name: string): Promise<void> {
  const current = await request(indexedDB.open(name));
  const version = current.version;
  current.close();
  return new Promise((resolve, reject) => {
    let blocked = false, deleted: Promise<void> | null = null;
    const r = indexedDB.open(name, version + 1);
    r.onblocked = () => { blocked = true; reject(new Error("This profile is open in another window. Close it, then try again.")); };
    r.onupgradeneeded = () => {
      // Queued behind this version change, the delete runs as soon as it is refused, before any other connection opens.
      if (!blocked) deleted = drop(name);
      r.transaction!.abort();
    };
    r.onerror = (event) => {
      event.preventDefault();
      if (deleted) deleted.then(resolve, reject);
      else if (!blocked) reject(r.error);
    };
    r.onsuccess = () => { r.result.close(); reject(new Error("Could not delete this profile's data")); };
  });
}

const databaseOf = (id: string) => (namespaceOf(id) ? `ghostly_${namespaceOf(id)}` : "ghostly");
/** A profile's peer database (WISP 04). */
export const profileDatabase = databaseOf;

/**
 * The public keys a profile acts with toward others: each chat's participation key (or, for a chat from before them,
 * its own chat key) and its DID's key. Two profiles sharing one of them answer as the same person, which is what a
 * backup restored on the device it was made on would do (WISP 05). Read from the stored records, nothing started.
 */
export function identityKeysOf(links: readonly unknown[], did: unknown): Set<string> {
  const keys = new Set<string>();
  for (const link of links) {
    const { participationSeed, seedB64 } = (link ?? {}) as { participationSeed?: unknown; seedB64?: unknown };
    const seed = typeof participationSeed === "string" ? participationSeed : typeof seedB64 === "string" ? seedB64 : null;
    if (!seed) continue;
    try { keys.add(`chat:${identityFromSeedB64(seed).pubKeyZ32}`); } catch { /* not a seed: nothing to compare */ }
  }
  const didKey = (did as { publicKey?: unknown } | null | undefined)?.publicKey;
  if (typeof didKey === "string" && didKey) keys.add(`did:${didKey}`);
  return keys;
}

/** `identityKeysOf` a profile of this space, from its peer database (read only, closed at once). */
export async function profileIdentityKeys(id: string): Promise<Set<string>> {
  const db = await openExisting(databaseOf(id));
  if (!db) return new Set();
  try {
    const names = ["links", "settings"].filter((name) => db.objectStoreNames.contains(name));
    if (!names.length) return new Set();
    const tx = db.transaction(names, "readonly");
    const [links, did] = await Promise.all([
      names.includes("links") ? request(tx.objectStore("links").getAll()) : Promise.resolve([]),
      names.includes("settings") ? request(tx.objectStore("settings").get("profileDid")) : Promise.resolve(undefined),
    ]);
    return identityKeysOf(links, did);
  } finally { db.close(); }
}

/**
 * The storage outside its peer database that a profile's wallets name, current and retired: each Ark wallet's
 * database (`ghostly-ark-<id>`), each Bark wallet's two (`ghostly-bark-<id>`, `…-onchain`), and each Fedimint
 * federation's client database, a file of the origin-private file system.
 */
interface WalletStorage { databases: string[]; files: string[] }
const FEDIMINT_FILE = /^ghostly-fedimint-[\w-]{1,80}\.db$/;
async function walletStorage(dbName: string): Promise<WalletStorage> {
  const found: WalletStorage = { databases: [], files: [] };
  const db = await openExisting(dbName);
  if (!db) return found;
  try {
    if (!db.objectStoreNames.contains("settings")) return found;
    const store = db.transaction("settings", "readonly").objectStore("settings");
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    keys.forEach((key, i) => {
      if (typeof key !== "string") return;
      const value = values[i] as { config?: { walletId?: unknown }; database?: unknown; federations?: { database?: unknown }[] } | null;
      const walletId = value?.config?.walletId;
      if (typeof walletId === "string" && walletId && key.startsWith("arkWallet")) found.databases.push(`ghostly-ark-${walletId}`);
      if (typeof walletId === "string" && walletId && key.startsWith("barkWallet")) found.databases.push(`ghostly-bark-${walletId}`, `ghostly-bark-${walletId}-onchain`);
      if (key.startsWith("fedimint")) {
        const federations = Array.isArray(value?.federations) ? value.federations.map((f) => f?.database) : [];
        for (const file of [value?.database, ...federations]) if (typeof file === "string" && FEDIMINT_FILE.test(file)) found.files.push(file);
      }
    });
    return found;
  } finally { db.close(); }
}

/** A wallet at home on this device (WISP 06 § Wallets that stay home): its kind, its network, and a Lightning card's name. */
export interface HomeWallet { type: "arkade" | "bark" | "spark" | "usdt" | "fedimint" | "bitcoin" | "lightning"; network: WalletNetwork; name?: string }

/** Where each wallet's record is (`walletHomes.ts` `homeRow`): the settings key of each kind, by network. */
const HOME_ROWS: [RegExp, HomeWallet["type"]][] = [
  [/^arkWallet-mode-(\w+)$/, "arkade"], [/^barkWallet-mode-(\w+)$/, "bark"], [/^sparkWallet-mode-(\w+)$/, "spark"], [/^usdtWallet-mode-(\w+)$/, "usdt"],
  [/^fedimintWallet-(\w+)$/, "fedimint"], [/^onchainSource-(\w+)$/, "bitcoin"],
];
const homeKey = (value: unknown): string | undefined => {
  const key = (value as { home?: { key?: unknown } } | null)?.home?.key;
  return typeof key === "string" ? key : undefined;
};

/**
 * The wallets whose home mark names the device `own` (its signing key), read from a profile's settings rows: each
 * record's mark, and each Lightning card's in its network's list.
 */
export function walletsAtHome(own: string, rows: readonly (readonly [IDBValidKey, unknown])[]): HomeWallet[] {
  const found: HomeWallet[] = [];
  for (const [key, value] of rows) {
    if (typeof key !== "string") continue;
    const cards = /^lightningCards-(\w+)$/.exec(key);
    if (cards && (WALLET_NETWORKS as readonly string[]).includes(cards[1])) {
      const list = (value as { cards?: unknown } | null)?.cards;
      for (const card of Array.isArray(list) ? list as { name?: unknown }[] : []) {
        if (homeKey(card) === own) found.push({ type: "lightning", network: cards[1] as WalletNetwork, ...(typeof card.name === "string" && card.name ? { name: card.name } : {}) });
      }
      continue;
    }
    for (const [pattern, type] of HOME_ROWS) {
      const network = pattern.exec(key)?.[1];
      if (network && (WALLET_NETWORKS as readonly string[]).includes(network) && homeKey(value) === own) found.push({ type, network: network as WalletNetwork });
    }
  }
  return found;
}

/**
 * The wallets of profile `id` whose home is this device, as its frozen copy names them: their own storage (a Bark
 * database, a Fedimint client file) is only here, and Remove this profile here deletes it. None when the profile's
 * device record names no slot of this device's own, or the copy is not here.
 */
export async function walletsAtHomeHere(id: string): Promise<HomeWallet[]> {
  const dbName = databaseOf(id);
  const record = await readDeviceRecord(dbName).catch(() => null);
  const own = record?.ownSlot !== undefined ? record.deviceSet[record.ownSlot]?.key : undefined;
  if (!own) return [];
  const db = await openExisting(dbName);
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("settings")) return [];
    const store = db.transaction("settings", "readonly").objectStore("settings");
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return walletsAtHome(own, keys.map((key, i) => [key, values[i]] as const));
  } finally { db.close(); }
}

/**
 * Deletes the wallets' own storage that the profile database `dbName` names (`walletStorage`) and the Breez databases
 * noted for it, before that database itself goes: never a database or file that a profile on the list still names
 * (another profile, or this profile's current state after a handoff: a wallet at home on this device keeps its
 * database's name, WISP 06 § Installing the staged state).
 */
export async function dropWalletStorageOf(dbName: string): Promise<void> {
  const others = await Promise.all(listProfiles().filter((p) => databaseOf(p.id) !== dbName).map((p) => walletStorage(databaseOf(p.id)).catch(() => ({ databases: [], files: [] }))));
  const usedElsewhere = new Set(others.flatMap((o) => [...o.databases, ...o.files]));
  const own = await walletStorage(dbName).catch(() => ({ databases: [], files: [] }));
  // One that cannot go now (open somewhere) does not keep the others.
  for (const name of new Set(own.databases)) if (!usedElsewhere.has(name)) await drop(name).catch(() => {});
  for (const name of new Set(own.files)) if (!usedElsewhere.has(name)) await dropFile(name).catch(() => {});
  // Its Breez databases, as the device's register lists them: each is that profile database's only.
  await dropBreezDatabasesOf(dbName).catch(() => {});
}

/** Removes a file of the origin-private file system, if there is one; a platform without it has none to remove. */
async function dropFile(name: string): Promise<void> {
  if (typeof navigator === "undefined") return;
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  await root?.removeEntry(name).catch((error: { name?: string }) => { if (error?.name !== "NotFoundError") throw error; });
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
 * A profile this device is on standby for (WISP 06 § User experience) shows "Standby" in place of its counts: what it
 * left unread is no longer where the profile runs, and its database is not opened, even for its picture.
 */
export interface ProfileGlance { locked: boolean; unread: number; fresh: number; avatar?: string; standby?: true }
export async function profileGlance(id: string): Promise<ProfileGlance> {
  if (profileLock(id)) return { locked: true, unread: 0, fresh: 0 };
  if (!(await deviceStateOf(databaseOf(id)).then(runsEngine, () => false))) return { locked: false, standby: true, unread: 0, fresh: 0 };
  return { locked: false, unread: unreadUnder(prefixOf(id)), fresh: peekFresh(id), avatar: await storedAvatar(databaseOf(id)) };
}
/**
 * What another window's write of this storage key (null: the storage was cleared) can change of `profileGlance(id)`:
 * all of it (the registry, the peeks, that profile's settings and lock), only its unread count (one of its chats or read
 * marks), or nothing (a draft typed in that profile, a mute, a key of any other profile).
 */
export function changesGlance(key: string | null, id: string): "glance" | "unread" | undefined {
  if (key === null || key === registryKey() || key === peekStoreKey() || key === settingsKeyFor(id)) return "glance";
  const prefix = prefixOf(id);
  if (!key.startsWith(prefix)) return undefined;
  // As `unreadUnder` reads them: a chat is `<prefix><chat id>`, its read mark `<prefix>read_<chat id>`.
  const rest = key.slice(prefix.length);
  return !rest.includes("_") || /^read_[^_]+$/.test(rest) ? "unread" : undefined;
}
/** A glance with its unread count read again, without opening the profile's database: a locked or standby one shows none. */
export const recounted = (id: string, glance: ProfileGlance): ProfileGlance => (glance.locked || glance.standby ? glance : { ...glance, unread: unreadUnder(prefixOf(id)) });
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
 * being able to open one profile must not open the others. Wrong passwords are paced as on that profile's lock screen.
 */
export async function assertUnlocked(id: string, password?: string): Promise<void> {
  if (id === activeProfileId()) return;
  const hash = profileLock(id);
  if (!hash) return;
  const waiting = lockRetryAt(id);
  if (waiting) throw new Error(waitMessage(waiting));
  if (!password) throw new Error("Wrong lock password for that profile");
  const tried = await tryLockPassword(id, password, hash);
  if (tried.waited) throw new Error(waitMessage(tried.retryAt!));
  if (!tried.ok) throw new Error("Wrong lock password for that profile");
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
 * Deletes a profile of this space for good: its local keys, its peer database and its wallets' own storage
 * (Ark, Bark and Breez databases, Fedimint client files), the forks a handoff left of it on this device and what a move
 * of it to this device staged and never installed, then its place on the list (WISP 04). Never the active one, never the
 * first, never one running in another tab, and never a wallet's storage another profile still uses.
 */
export async function deleteProfile(id: string, password?: string): Promise<void> {
  if (!id) throw new Error("The first profile cannot be deleted");
  if (id === activeProfileId()) throw new Error("Switch to another profile first");
  const ns = namespaceOf(id);
  // Another tab runs it (and has likely made it the registry's choice): that is what to say, since switching here
  // would not close it.
  if (await lockHeld(ns)) throw new Error("This profile is open in another window. Close it, then try again.");
  // Nor the one the registry has chosen, which the next page starts as.
  if (id === chosenProfileId()) throw new Error("Switch to another profile first");
  await assertUnlocked(id, password);
  await dropProfile(id, (key) => key.startsWith(`ghostly_${ns}_`));
  unregisterProfile(id);
  // The local hosts it shared apps at (the extension's host permissions), unless a profile still on the list shares one there.
  await releaseUnusedLocalAccessOf();
}

/**
 * "Remove this profile here" (WISP 06 § User experience), on a device out of the profile's device set for good: removed,
 * or `moving` with nothing it can accept. The profile this page runs as, on its standby screen, holds a frozen copy that
 * is not encrypted; it goes from this device as `deleteProfile` takes a profile, forks included. Another profile goes off
 * the list; the first one stays on it, empty. Its other devices keep the profile. The caller then reloads.
 */
export async function removeProfileHere(): Promise<void> {
  const id = activeProfileId(), ns = namespaceOf(id), dbName = databaseOf(id);
  const record = await readDeviceRecord(dbName);
  if (!record || !(record.state === "removed" || (record.state === "moving" && record.reenroll))) throw new Error("Only a device removed from this profile's devices removes it here");
  // The shares this page holds go with it: the reload after this would carry them to the next page.
  resetIncomingShare();
  // The first profile running on a namespace a handoff installed: what a take left in its own namespace goes as well
  // (an earlier build's take dropped its database and kept its keys), since the profile starts there again, empty.
  const original = homeDatabaseOf(id) === "ghostly" ? "" : homeDatabaseOf(id).slice("ghostly_".length);
  const own = keysOfSpace(ns), originals = id ? null : keysOfSpace(original);
  await dropProfile(id, (key) => own(key) || !!originals?.(key));
  forgetProfileHere(id);
  await releaseUnusedLocalAccessOf();
}

/**
 * Which local keys are a namespace's own: `ghostly_<ns>_`, or for the first profile's original one (`ns` empty) the
 * keys without another profile's id or space after `ghostly_` (`originalKeyOwner`) and the legacy join marks. Never the
 * registry, which the app needs to start at all. For one pass over the keys (`keyOwner`).
 */
export function keysOfSpace(ns: string): (key: string) => boolean {
  const registry = registryKey(), original = ns ? null : originalKeyOwner();
  return (key) => key !== registry && (original ? original(key) || key.startsWith(LEGACY_JOIN_PREFIX) : key.startsWith(`ghostly_${ns}_`));
}

/**
 * What `deleteProfile` and `removeProfileHere` delete of a profile: its peer database, its wallets' own storage, its
 * linked files and files, the local keys `owned` names, its push subscription, the forks its device record lists and
 * the record itself, and what another profile's peek saw of it. Not its place on the list.
 */
async function dropProfile(id: string, owned: (key: string) => boolean): Promise<void> {
  const dbName = databaseOf(id);
  const others = await Promise.all(listProfiles().filter((p) => p.id !== id).map((p) => walletStorage(databaseOf(p.id))));
  const usedElsewhere = new Set(others.flatMap((o) => [...o.databases, ...o.files]));
  const own = await walletStorage(dbName);
  // The forks its device record lists (WISP 06 § Installing the staged state), and the staging namespace a move of it
  // to this device wrote and never installed (a pull that stopped keeps its files, their notes and, past pass 2, the
  // staged database for a later try): read before the record goes, the only thing that names them.
  const record = await readDeviceRecord(dbName).catch(() => null);
  const forks = record?.forks ?? [];
  const staged = record?.handoff?.role === "taking" ? record.handoff.staging : undefined;
  if (await databaseExists(dbName)) await dropUnheld(dbName);
  // The folders and files its apps were given (linked files: handles, never copies).
  if (await databaseExists(linkedFilesDatabase(dbName))) await drop(linkedFilesDatabase(dbName)).catch(() => {});
  await dropFileSpace(dbName).catch(() => {});
  for (const name of new Set(own.databases)) if (!usedElsewhere.has(name)) await drop(name);
  for (const name of new Set(own.files)) if (!usedElsewhere.has(name)) await dropFile(name).catch(() => {});
  // Its Breez databases, as the device's register lists them: each is one profile's only.
  await dropBreezDatabasesOf(dbName).catch(() => {});
  for (const key of Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k && owned(k))) localStorage.removeItem(key);
  // The room its keys made may fit what the open profile's page held (the storage-full notice).
  retryUnsaved();
  // Its push subscription (WISP 401 § Wake-up push) ends with it: its worker goes, and contacts who kept it get 410.
  await pushPlatform()?.unsubscribe(id).catch(() => {});
  // What the contacts' apps it opened kept on their own origins (the web app's).
  await forgetServicesOf({ profile: id });
  // Each fork of it goes as "Discard this copy" takes it, with its linked files: no screen lists it once the record
  // is gone. Never a database a profile on the list runs on.
  const listed = new Set(listProfiles().map((p) => databaseOf(p.id)));
  for (const fork of forks) {
    if (listed.has(fork)) continue;
    await handoffProfileHost()?.staging.drop(fork).catch(() => {});
    if (await databaseExists(linkedFilesDatabase(fork))) await drop(linkedFilesDatabase(fork)).catch(() => {});
  }
  if (staged && staged !== dbName && !listed.has(staged)) await handoffProfileHost()?.staging.drop(staged).catch(() => {});
  // Its device state goes with it (WISP 06): a profile made later under the same name must not inherit it.
  await forgetDevice(dbName).catch(() => {});
  // What another profile's peek saw of it (its contacts' keys, link and message ids), and its notice.
  clearPeek(id);
}
