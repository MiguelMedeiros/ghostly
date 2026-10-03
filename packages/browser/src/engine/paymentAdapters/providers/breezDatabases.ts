import { sha256 } from "@noble/hashes/sha2.js";
import { databaseName } from "../../../shared/idb";

/**
 * Where the Breez SDK keeps a wallet on this device, and which profile it belongs to.
 *
 * The SDK keeps its IndexedDB databases under one storage name (`breezDatabaseFiles`). That name is one per **profile,
 * network and seed**: the Spark rail and a Breez Lightning card of the same phrase in one profile are one SDK instance
 * over one database (`openBreez`), two phrases are two wallets, and a profile restored as a copy on the same device
 * starts from the phrase with a database of its own. Two SDK instances over one database would each think the leaves
 * are theirs.
 *
 * Before this, the name came from the network and the seed only, so every profile of the origin holding that phrase
 * opened the same database. Such a database is kept, under its old name, for **one** profile: the first to open the
 * phrase on this device after the change claims it in a small database of the device (`ghostly-breez`), outside every
 * profile database (a backup copies a profile's database whole, so a mark in it would be the copy's too). Any other
 * profile gets a new name. The same register lists every name a profile uses, so deleting a profile deletes its Breez
 * databases without opening its sealed phrases.
 */
export type BreezDatabaseNetwork = "mainnet" | "regtest";
const netOf = (network: string): BreezDatabaseNetwork => (network === "bitcoin" || network === "mainnet" ? "mainnet" : "regtest");
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const digest = (text: string) => hex(sha256(new TextEncoder().encode(text))).slice(0, 16);

/** What a Breez database name looks like, old or new: nothing about the seed or the profile shows in it. */
export const BREEZ_DATABASE = /^ghostly-breez-(mainnet|regtest)-[0-9a-f]{16}$/;

/** The name every profile of the origin used for this phrase before databases were per profile. */
export const breezLegacyName = (network: string, mnemonic: string) => `ghostly-breez-${netOf(network)}-${digest(`ghostly-breez:${netOf(network)}:${mnemonic}`)}`;

/** The name of this phrase's Breez database in one profile (`space`: the profile's peer database, WISP 04). */
export const breezDatabaseName = (network: string, mnemonic: string, space: string = databaseName()) =>
  `ghostly-breez-${netOf(network)}-${digest(`ghostly-breez:${space}:${netOf(network)}:${mnemonic}`)}`;

/**
 * The databases the SDK keeps under one storage name. SDK 0.26 roots them there: `<name>/<network>/<identity>` and
 * `<name>/<network>/<identity>-tree`, the identity read from the seed inside the SDK. Older builds kept `<name>`
 * itself. A browser without `indexedDB.databases()` cannot list them: only the bare names are known there.
 */
export async function breezDatabaseFiles(name: string): Promise<string[]> {
  const files = [name, `${name}-tree`];
  if (typeof indexedDB.databases !== "function") return files;
  const under = (await indexedDB.databases()).map((d) => d.name ?? "").filter((file) => file.startsWith(`${name}/`));
  return [...new Set([...files, ...under])];
}

interface Entry { name: string; space: string; network: BreezDatabaseNetwork; legacy?: true }
const REGISTER = "ghostly-breez", STORE = "databases";

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
function openRegister(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(REGISTER, 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("The Breez register is blocked"));
  });
}
async function withRegister<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await openRegister();
  try {
    const tx = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
    const result = await run(tx.objectStore(STORE));
    await done;
    return result;
  } finally { db.close(); }
}

/**
 * Whether the SDK keeps a wallet under this storage name on this device (`breezDatabaseFiles`). A browser that cannot
 * list databases is answered yes: the first profile then takes the old name whether or not it is there, which is
 * safe, since only one profile ever has it.
 */
async function exists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return true;
  return (await indexedDB.databases()).some((d) => d.name === name || !!d.name?.startsWith(`${name}/`));
}

/**
 * The Breez database this profile opens for this phrase: the old shared one when this profile owns it (or is the
 * first to claim it), else the profile's own. Noted in the register either way. A device whose IndexedDB cannot be
 * read gets the profile's own name: never a database another profile may use.
 */
export async function breezDatabase(network: string, mnemonic: string, space: string = databaseName()): Promise<string> {
  const fresh = breezDatabaseName(network, mnemonic, space);
  if (typeof indexedDB === "undefined") return fresh;
  const legacy = breezLegacyName(network, mnemonic);
  try {
    const legacyHere = await exists(legacy);
    return await withRegister("readwrite", async (store) => {
      // Both reads and the write in one transaction: two profiles opening at once cannot both claim the old one.
      const [owner, own] = await Promise.all([request(store.get(legacy)) as Promise<Entry | undefined>, request(store.get(fresh)) as Promise<Entry | undefined>]);
      if (owner?.space === space) return legacy;
      if (!own && !owner && legacyHere) { store.put({ name: legacy, space, network: netOf(network), legacy: true } satisfies Entry, legacy); return legacy; }
      if (!own) store.put({ name: fresh, space, network: netOf(network) } satisfies Entry, fresh);
      return fresh;
    });
  } catch { return fresh; }
}

/** The names this profile has noted for this phrase (nothing is claimed): what removing the wallet deletes. */
export async function breezDatabasesFor(network: string, mnemonic: string, space: string = databaseName()): Promise<string[]> {
  const names = [breezLegacyName(network, mnemonic), breezDatabaseName(network, mnemonic, space)];
  return (await breezDatabasesOf(space)).filter((name) => names.includes(name));
}

/** Every Breez database name noted for a profile of this device. */
export async function breezDatabasesOf(space: string): Promise<string[]> {
  if (typeof indexedDB === "undefined") return [];
  try { return ((await withRegister("readonly", (store) => request(store.getAll()))) as Entry[]).filter((e) => e?.space === space && BREEZ_DATABASE.test(e.name)).map((e) => e.name); }
  catch { return []; }
}

const deleteDatabase = (name: string) => new Promise<void>((resolve) => {
  try { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch { resolve(); }
});

/** Deletes one Breez wallet's databases (all the SDK keeps under the name) and its note in the register. Anything else is refused. */
export async function dropBreezDatabase(name: string): Promise<void> {
  if (!BREEZ_DATABASE.test(name) || typeof indexedDB === "undefined") return;
  for (const file of await breezDatabaseFiles(name).catch(() => [name, `${name}-tree`])) await deleteDatabase(file);
  await withRegister("readwrite", (store) => { store.delete(name); }).catch(() => {});
}

/** Deletes every Breez database a profile used on this device (the profile is being deleted). */
export async function dropBreezDatabasesOf(space: string): Promise<void> {
  for (const name of await breezDatabasesOf(space)) await dropBreezDatabase(name);
}
