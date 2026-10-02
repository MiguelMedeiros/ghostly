import { fromBase64Url, identityFromSeed, randomBytes, seedSigner, toBase64Url, verify, webCryptoSigner, type Signer } from "@ghostly/core";
import type { DeviceSigningKeyKind } from "./state";

/*
 * The device signing key (WISP 06 § Terms): an Ed25519 key made on this device, in no backup and in no handoff. It
 * signs the turn record, authenticates the device's links and signs a release.
 *
 * Where the engine offers Ed25519 in WebCrypto, the key is generated non-extractable: the app cannot export it. It is
 * still bytes in the browser's storage on disk, and copied storage copies it. Elsewhere the key is a stored seed, like
 * every other key of the profile. Which of the two a device has is found at run time, by doing it: a key is
 * generated, must refuse export, must sign what the JavaScript library verifies, must be stored and read back, and
 * must sign again after that. Anything short of that, and the key is a seed.
 *
 * The key lives in a database of its own, `ghostly-device-keys`, one record per profile, and not in the device record
 * (`ghostly-devices`): that record is JSON, goes to Desktop's file, and is what later parts copy into a backup and a
 * handoff. A `CryptoKey` cannot go into any of those, and a seed must not. The device record only says which form
 * the key has (`signingKey`). No OS keychain is used.
 *
 * Nothing here runs for a profile with no device set: a key is made when a device set is (`setup.ts`) or, later, when
 * a device is enrolled. A read never makes the database.
 *
 * (Not `deviceKey`: `engine/did.ts` already uses that name for the local key that seals a seed.)
 */

export const DEVICE_KEYS_DB = "ghostly-device-keys";
const VERSION = 1;
const STORE = "keys";

/** This device's signing key for one profile: a signer, and which form it has. */
export interface DeviceSigningKey extends Signer {
  readonly kind: DeviceSigningKeyKind;
}

interface StoredKey {
  profile: string;
  kind: DeviceSigningKeyKind;
  /** The Ed25519 public key, base64url. */
  publicKey: string;
  /** `webcrypto`: the non-extractable private key, kept as the browser's own object. */
  privateKey?: CryptoKey;
  /** `seed`: the seed, base64url. */
  seed?: string;
  createdAt: number;
}

/** What the run-time check found (for the report on which engines hold a non-extractable key). */
export interface NonExtractableCheck {
  supported: boolean;
  /** Why not, in the engine's own words where it gave some. */
  reason?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openKeysDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DEVICE_KEYS_DB, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "profile" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onerror = (event) => { event.preventDefault?.(); reject(request.error ?? new Error("The device key database did not open")); };
    request.onblocked = () => reject(new Error("The device key database is held open by another window at an older version"));
  }).catch((error: unknown) => { dbPromise = null; throw error; });
  return dbPromise;
}

/** Closes the connection (tests, and before the database is deleted). */
export async function closeDeviceKeysDb(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  if (open) await open.then((db) => db.close(), () => {});
}

/** Whether the key database exists, without making it. */
async function keysDbExists(): Promise<boolean> {
  if (dbPromise) return true;
  if (typeof indexedDB === "undefined") return false;
  if (typeof indexedDB.databases === "function") return (await indexedDB.databases()).some((d) => d.name === DEVICE_KEYS_DB);
  return new Promise<boolean>((resolve) => {
    const request = indexedDB.open(DEVICE_KEYS_DB);
    let made = false;
    request.onupgradeneeded = () => { made = true; try { request.transaction?.abort(); } catch { /* already over */ } };
    request.onsuccess = () => { request.result.close(); resolve(!made); };
    request.onerror = (event) => { event.preventDefault?.(); resolve(false); };
    request.onblocked = () => resolve(true);
  });
}

async function readStored(profile: string): Promise<StoredKey | null> {
  if (!(await keysDbExists())) return null;
  const db = await openKeysDb();
  return new Promise<StoredKey | null>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(profile);
    request.onsuccess = () => resolve((request.result as StoredKey | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Stores `key` unless the profile already has one, in one strict transaction, and answers what is stored after it:
 * a device keeps its key, and two pages that both make one end with the same one.
 */
async function storeOnce(key: StoredKey): Promise<StoredKey> {
  const db = await openKeysDb();
  const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
  return new Promise<StoredKey>((resolve, reject) => {
    let kept: StoredKey = key;
    tx.oncomplete = () => resolve(kept);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The device signing key could not be saved"));
    const store = tx.objectStore(STORE);
    const current = store.get(key.profile);
    current.onsuccess = () => {
      if (current.result) kept = current.result as StoredKey;
      else store.put(key);
    };
  });
}

/**
 * Removes the profile's key. With `onlyKey` (a public key, base64url), only if that is the key stored, in the same
 * transaction: a page taking back the key it made never removes one another page stored meanwhile.
 */
async function remove(profile: string, onlyKey?: string): Promise<void> {
  if (!(await keysDbExists())) return;
  const db = await openKeysDb();
  const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The device signing key could not be removed"));
    const store = tx.objectStore(STORE);
    if (onlyKey === undefined) { store.delete(profile); return; }
    const current = store.get(profile);
    current.onsuccess = () => { if ((current.result as StoredKey | undefined)?.publicKey === onlyKey) store.delete(profile); };
  });
}

const why = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Signs a random message with `signer` and checks it with the JavaScript library, which every reader uses. */
async function signsCorrectly(signer: Signer): Promise<boolean> {
  const probe = randomBytes(32);
  const signature = await signer.sign(probe);
  return signature.length === 64 && verify(signature, probe, signer.publicKey);
}

/**
 * A new non-extractable Ed25519 key from this engine's WebCrypto, or why there is none: no WebCrypto, no Ed25519 in
 * it, a key that came back extractable or let itself be exported, or a signature the library does not verify.
 */
async function generateNonExtractable(): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array } | { reason: string }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { reason: "This engine has no WebCrypto here" };
  try {
    const pair = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
    if (pair.privateKey.extractable) return { reason: "The key was made extractable" };
    for (const format of ["pkcs8", "jwk", "raw"] as const) {
      let exported = false;
      try { await subtle.exportKey(format, pair.privateKey); exported = true; } catch { /* refused, as it must be */ }
      if (exported) return { reason: `The key let itself be exported as ${format}` };
    }
    const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    if (publicKey.length !== 32) return { reason: "The public key is not 32 bytes" };
    if (!(await signsCorrectly(webCryptoSigner(pair.privateKey, publicKey)))) return { reason: "Its signature does not verify" };
    return { privateKey: pair.privateKey, publicKey };
  } catch (error) {
    return { reason: why(error) };
  }
}

/**
 * Whether this engine makes a non-extractable Ed25519 key that signs (WISP 06 § Measured, and still to measure). It
 * says nothing about storing one: `createDeviceSigningKey` finds that out with the key it keeps.
 */
export async function checkNonExtractableEd25519(): Promise<NonExtractableCheck> {
  const made = await generateNonExtractable();
  return "reason" in made ? { supported: false, reason: made.reason } : { supported: true };
}

function signerOf(stored: StoredKey): DeviceSigningKey {
  const publicKey = fromBase64Url(stored.publicKey);
  if (stored.kind === "webcrypto") {
    if (!stored.privateKey) throw new Error("The stored device signing key has no key");
    return { kind: "webcrypto", ...webCryptoSigner(stored.privateKey, publicKey) };
  }
  if (!stored.seed) throw new Error("The stored device signing key has no seed");
  const signer = seedSigner(fromBase64Url(stored.seed));
  if (toBase64Url(signer.publicKey) !== stored.publicKey) throw new Error("The stored device signing key does not match its public key");
  return { kind: "seed", ...signer };
}

/** This device's signing key for the profile, or null when it has none. Makes nothing. */
export async function loadDeviceSigningKey(profile: string): Promise<DeviceSigningKey | null> {
  const stored = await readStored(profile);
  return stored ? signerOf(stored) : null;
}

/**
 * This device's signing key for the profile, made now if it has none. Non-extractable where this engine makes such a
 * key, stores it, reads it back and signs with what it read; a stored seed otherwise (`forceSeed`: tests, and an
 * engine known not to keep such keys). A profile that has a key keeps it: the same key is answered again.
 */
export async function createDeviceSigningKey(profile: string, options: { forceSeed?: boolean; now?: () => number } = {}): Promise<DeviceSigningKey> {
  const existing = await loadDeviceSigningKey(profile);
  if (existing) return existing;
  const createdAt = (options.now ?? Date.now)();
  if (!options.forceSeed) {
    const made = await generateNonExtractable();
    if (!("reason" in made)) {
      const publicKey = toBase64Url(made.publicKey);
      try {
        // Stored as the browser's own object (a structured clone): an engine that cannot store one throws here.
        const kept = await storeOnce({ profile, kind: "webcrypto", publicKey, privateKey: made.privateKey, createdAt });
        // What is stored must sign: this is the key every later start reads. It is this page's, or one another page
        // stored a moment before.
        const signer = signerOf(kept);
        if (await signsCorrectly(signer)) return signer;
      } catch { /* this engine does not keep such a key: a seed */ }
      // Taken back only if it is the key this page made: one another page stored meanwhile stays.
      await remove(profile, publicKey).catch(() => {});
    }
  }
  const identity = identityFromSeed(randomBytes(32));
  const kept = await storeOnce({ profile, kind: "seed", publicKey: toBase64Url(identity.publicKey), seed: identity.seedB64, createdAt });
  // The seed, or what another page stored first, or a key this page could not take back: whichever it is, a key that
  // does not sign is refused here, never handed out to be named in a device record.
  let signer: DeviceSigningKey;
  try { signer = signerOf(kept); } catch (error) { throw new Error(`The device signing key stored here cannot be used: ${why(error)}`, { cause: error }); }
  if (!(await signsCorrectly(signer).catch(() => false))) throw new Error("The device signing key stored here does not sign");
  return signer;
}

/** The profile is gone from this device, or its device left the set for good: its key goes too. Makes no database. */
export async function forgetDeviceSigningKey(profile: string): Promise<void> {
  await remove(profile);
}
