import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, toZ32 } from "./bytes";
import { canonicalJsonBytes, readCanonicalJson, type JsonValue } from "./canonicalJson";
import { findAppForbiddenKey, isAppUrl } from "./appBundle";
import {
  APP_PREFIXES, isAppHash, isAppKey, isAppRef, readAppRevocation, readAppSignature, signAppObject, verifyAppSignature,
  type AppSignature, type SignedAppRevocation,
} from "./appStatements";
import type { Signer } from "./signer";

/*
 * A store index (WISP 1200 · Stores): `ghostly-store.json`, canonical JSON, signed by the store key under
 * `ghostly-store/1` in `ghostly-store.sig` beside it (the same statement as a bundle's). It lists apps by reference and
 * digest, the versions it removed, and publishers' revocations copied verbatim. Times are Unix seconds.
 *
 * A store lists and ranks; it never changes what installs: the bundle a listing points at is checked on its own, and
 * its icon and description come from the bundle. `listing.json` in a store's repository is one entry of `apps`.
 */

export const APP_STORE_LIMITS = {
  /** The index's bytes, uncompressed. */
  indexBytes: 16 * 1024 * 1024,
  /** How far ahead `expires` may be. */
  expiresAheadS: 90 * 24 * 60 * 60,
  name: 40,
  description: 2000,
  title: 40,
  tagline: 80,
  /** `category`, `developer`, `submitter`. */
  label: 40,
  reason: 200,
  urls: 4,
  apps: 4096,
  removed: 4096,
  revoked: 4096,
} as const;

export const APP_STORE_KINDS = ["curated", "indexed"] as const;
export type AppStoreKind = typeof APP_STORE_KINDS[number];

export interface AppListing {
  ref: string;
  sequence: number;
  digest: string;
  urls: string[];
  title: string;
  tagline: string;
  category?: string;
  developer?: string;
  submitter?: string;
  repo?: string;
  support?: string;
}
export interface AppRemoval { ref: string; digest: string; reason: string; at: number }
export interface AppStoreIndex {
  ghostlyStore: 1;
  key: string;
  name: string;
  description?: string;
  kind: AppStoreKind;
  sequence: number;
  expires: number;
  apps: AppListing[];
  removed: AppRemoval[];
  revoked: SignedAppRevocation[];
}

export type AppStoreRefusal =
  | "too-large" | "not-json" | "not-canonical" | "unsupported-format" | "unknown-key" | "missing-key" | "bad-field"
  | "duplicate-app" | "bad-signature-statement" | "signature-key" | "bad-signature" | "store-key" | "expires-too-far"
  | "bad-revocation";

const isObject = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && [...v].length >= min && [...v].length <= max && !/\p{Cc}/u.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && [...v].length <= max && !/[^\P{Cc}\n]/u.test(v);
const isCount = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

type Check = { ok: true } | { ok: false; reason: AppStoreRefusal; detail?: string };
const fine: Check = { ok: true };

/**
 * How a check treats a key it does not know. A reader (`readAppStore`, the client) ignores it, so a later format can
 * add an optional key without a client refusing the whole signed index; the signature still covers the bytes as they
 * are, unknown keys included. A writer (`signAppStore`, the CLI, a store's check of a `listing.json` through
 * `readAppListing`) passes `strict` and refuses it, so a misspelt key is caught before anything is signed. Required
 * keys, their types and their bounds hold in both, and `APP_FORBIDDEN_KEYS` are refused in both, at any level.
 */
export interface AppFormatOptions { strict?: boolean }

function keysOf(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], options: AppFormatOptions = {}): Check {
  // `__proto__` and its kin are refused in both modes, at any level (`findAppForbiddenKey`): a reader keeps what it ignores.
  const forbidden = findAppForbiddenKey(value);
  if (forbidden !== undefined) return { ok: false, reason: "unknown-key", detail: forbidden };
  for (const k of Object.keys(value)) {
    if (options.strict && !required.includes(k) && !optional.includes(k)) return { ok: false, reason: "unknown-key", detail: k };
  }
  for (const k of required) if (!(k in value)) return { ok: false, reason: "missing-key", detail: k };
  return fine;
}

const LISTING_REQUIRED = ["ref", "sequence", "digest", "urls", "title", "tagline"] as const;
const LISTING_OPTIONAL = ["category", "developer", "submitter", "repo", "support"] as const;

/** Checks one entry of `apps`, which is also the whole of a `listing.json`. An unknown key is ignored unless `strict`. */
export function checkAppListing(value: unknown, options: AppFormatOptions = {}): Check {
  if (!isObject(value)) return { ok: false, reason: "bad-field", detail: "A listing is not an object" };
  const keys = keysOf(value, LISTING_REQUIRED, LISTING_OPTIONAL, options);
  if (!keys.ok) return keys;
  const bad = (field: string): Check => ({ ok: false, reason: "bad-field", detail: `apps: ${field}` });
  if (!isAppRef(value.ref)) return bad("ref");
  if (!isCount(value.sequence, 1)) return bad("sequence");
  if (!isAppHash(value.digest)) return bad("digest");
  const urls = value.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > APP_STORE_LIMITS.urls || !urls.every(isAppUrl)) return bad("urls");
  if (!isLine(value.title, APP_STORE_LIMITS.title, 1)) return bad("title");
  if (!isLine(value.tagline, APP_STORE_LIMITS.tagline, 1)) return bad("tagline");
  for (const k of ["category", "developer", "submitter"] as const) if (value[k] !== undefined && !isLine(value[k], APP_STORE_LIMITS.label, 1)) return bad(k);
  for (const k of ["repo", "support"] as const) if (value[k] !== undefined && !isAppUrl(value[k])) return bad(k);
  return fine;
}

/**
 * Reads a `listing.json`: JSON holding exactly one listing (written by hand in release 1.2, so not required canonical).
 * A store reads it, as a writer: strict by default, so a misspelt key is refused before the owner signs the index (the
 * client never reads a `listing.json`, only the signed index). `{ strict: false }` reads it as a client reads an index
 * entry, ignoring a later key.
 */
export function readAppListing(text: string, options: AppFormatOptions = { strict: true }): { ok: true; listing: AppListing } | { ok: false; reason: AppStoreRefusal; detail?: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { return { ok: false, reason: "not-json", detail: String(error) }; }
  const checked = checkAppListing(value, options);
  return checked.ok ? { ok: true, listing: value as AppListing } : checked;
}

function checkRemoval(value: unknown, options: AppFormatOptions): Check {
  if (!isObject(value)) return { ok: false, reason: "bad-field", detail: "A removal is not an object" };
  const keys = keysOf(value, ["ref", "digest", "reason", "at"], [], options);
  if (!keys.ok) return keys;
  if (!isAppRef(value.ref) || !isAppHash(value.digest) || !isLine(value.reason, APP_STORE_LIMITS.reason, 1) || !isCount(value.at, 0)) {
    return { ok: false, reason: "bad-field", detail: "removed: not {ref, digest, reason, at}" };
  }
  return fine;
}

const STORE_REQUIRED = ["ghostlyStore", "key", "name", "kind", "sequence", "expires", "apps", "removed", "revoked"] as const;

/**
 * Checks an index's fields and bounds, and every revocation it carries (one that does not verify refuses the index:
 * the store copied it, so a broken one is the store's fault). The signature and `expires` are `readAppStore`'s. An
 * unknown key of the index, a listing or a removal is ignored unless `strict`; a revocation is its publisher's signed
 * statement and keeps its exact keys.
 */
export function checkAppStoreIndex(value: unknown, options: AppFormatOptions = {}): Check {
  if (!isObject(value)) return { ok: false, reason: "bad-field", detail: "The index is not an object" };
  if (value.ghostlyStore !== undefined && value.ghostlyStore !== 1) return { ok: false, reason: "unsupported-format", detail: "ghostlyStore is not 1" };
  const keys = keysOf(value, STORE_REQUIRED, ["description"], options);
  if (!keys.ok) return keys;
  const bad = (field: string): Check => ({ ok: false, reason: "bad-field", detail: field });
  if (!isAppKey(value.key)) return bad("key");
  if (!isLine(value.name, APP_STORE_LIMITS.name, 1)) return bad("name");
  if (value.description !== undefined && !isText(value.description, APP_STORE_LIMITS.description)) return bad("description");
  if (!(APP_STORE_KINDS as readonly unknown[]).includes(value.kind)) return bad("kind");
  if (!isCount(value.sequence, 1)) return bad("sequence");
  if (!isCount(value.expires, 0)) return bad("expires");
  const { apps, removed, revoked } = value;
  if (!Array.isArray(apps) || apps.length > APP_STORE_LIMITS.apps) return bad("apps");
  const refs = new Set<string>();
  for (const listing of apps) {
    const checked = checkAppListing(listing, options);
    if (!checked.ok) return checked;
    const ref = (listing as { ref: string }).ref;
    if (refs.has(ref)) return { ok: false, reason: "duplicate-app", detail: ref };
    refs.add(ref);
  }
  if (!Array.isArray(removed) || removed.length > APP_STORE_LIMITS.removed) return bad("removed");
  for (const entry of removed) { const checked = checkRemoval(entry, options); if (!checked.ok) return checked; }
  if (!Array.isArray(revoked) || revoked.length > APP_STORE_LIMITS.revoked) return bad("revoked");
  for (const entry of revoked) {
    const read = readAppRevocation(entry);
    if (!read.ok) return { ok: false, reason: "bad-revocation", detail: read.detail ?? read.reason };
  }
  return fine;
}

export interface AppStoreReading {
  index: AppStoreIndex;
  /** SHA-256 of the index's bytes, base64url: what the update rule compares at one `sequence`. */
  digest: string;
  /** Past `expires`: it still installs, and the Apps page says when the store was last updated. */
  expired: boolean;
}

/**
 * Reads `ghostly-store.json` with its `ghostly-store.sig`, in this order: size, JSON, canonical bytes, fields and
 * revocations, the signature statement, the key the reader holds for this store (when it holds one), the signature,
 * then `expires` against `now` (seconds): more than 90 days ahead is refused, past is `expired`. A key it does not know
 * is ignored (a later store's optional field) and stays in the bytes the signature covers.
 */
export function readAppStore(indexBytes: Uint8Array, sigBytes: Uint8Array, now: number, heldKey?: string):
  { ok: true; store: AppStoreReading } | { ok: false; reason: AppStoreRefusal; detail?: string } {
  if (indexBytes.length > APP_STORE_LIMITS.indexBytes) return { ok: false, reason: "too-large" };
  const read = readCanonicalJson(indexBytes);
  if (!read.ok) return read;
  const checked = checkAppStoreIndex(read.value);
  if (!checked.ok) return checked;
  const index = read.value as unknown as AppStoreIndex;
  const statement = readAppSignature(sigBytes);
  if (!statement.ok) return statement;
  if (heldKey !== undefined && index.key !== heldKey) return { ok: false, reason: "store-key", detail: "Another key than the store's" };
  const signed = verifyAppSignature(APP_PREFIXES.store, indexBytes, statement.signature, index.key);
  if (!signed.ok) return signed;
  if (index.expires > now + APP_STORE_LIMITS.expiresAheadS) return { ok: false, reason: "expires-too-far" };
  return { ok: true, store: { index, digest: toBase64Url(sha256(indexBytes)), expired: index.expires < now } };
}

/**
 * Signs an index with the store key: its canonical bytes and the `ghostly-store.sig` bytes. Throws on a bad index, and
 * on a key this format does not define: a writer is strict, so a misspelt key is never signed.
 */
export async function signAppStore(index: AppStoreIndex, signer: Signer): Promise<{ indexBytes: Uint8Array; sigBytes: Uint8Array; signature: AppSignature }> {
  if (index.key !== toZ32(signer.publicKey)) throw new Error("A store index is signed by its own key");
  const checked = checkAppStoreIndex(JSON.parse(JSON.stringify(index)), { strict: true });
  if (!checked.ok) throw new Error(`Not a valid store index (${checked.reason}${checked.detail ? `: ${checked.detail}` : ""})`);
  const { bytes, signature } = await signAppObject(APP_PREFIXES.store, index, signer);
  return { indexBytes: bytes, sigBytes: canonicalJsonBytes(signature), signature };
}
