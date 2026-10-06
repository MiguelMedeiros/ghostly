import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, fromZ32, toBase64Url, toZ32, utf8Encode } from "./bytes";
import { canonicalJsonBytes, readCanonicalJson, type CanonicalJsonRefusal, type JsonValue } from "./canonicalJson";
import { verify } from "./identity";
import type { Signer } from "./signer";

/*
 * Signed statements of WISP 1200 (Apps · Signatures): every signed object is signed the same way, Ed25519 over the
 * bytes `<prefix>`, a zero byte, then the SHA-256 of the object's canonical JSON (RFC 8785). The prefix says what the
 * object is, so no signature can be replayed as another kind. The signature travels as a statement of its own,
 * `{"alg":"ed25519","key":"<z-base32>","sig":"<base64url>"}`, itself canonical.
 *
 * A revocation (`ghostly-revoke/1`) is the publisher's: it names digests of its app, or every version up to a
 * `sequence`, and travels as `{"statement": {...}, "signature": {...}}` in `ghostly-revoke.json` and, verbatim, in a
 * store index's `revoked`.
 */

/** The prefixes of phase 1. The others of the WISP (reports, reviews, licences, rotation, publisher proofs) come later. */
export const APP_PREFIXES = {
  app: "ghostly-app/1",
  store: "ghostly-store/1",
  revoke: "ghostly-revoke/1",
} as const;
export type AppPrefix = typeof APP_PREFIXES[keyof typeof APP_PREFIXES];

export const APP_STATEMENT_LIMITS = {
  /** A signature statement's canonical bytes: 52 + 86 characters of values and the keys around them. */
  signatureBytes: 1024,
  /** Digests named by one revocation. */
  revokeDigests: 64,
  /** A revocation's reason, in characters. */
  reason: 200,
  /** Revocations in one `ghostly-revoke.json`. */
  revocations: 4096,
} as const;

/** A z-base32 Ed25519 public key: 52 characters that decode to 32 bytes and encode back to the same text. */
export function isAppKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(value)) return false;
  const bytes = fromZ32(value);
  return bytes.length === 32 && toZ32(bytes) === value;
}

/** A SHA-256 in base64url without padding: 43 characters that decode to 32 bytes and encode back to the same text. */
export function isAppHash(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return toBase64Url(fromBase64Url(value)) === value;
}

/** An app reference, `<publisher key>/<name>`. */
export const APP_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export function isAppRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const slash = value.indexOf("/");
  return slash === 52 && isAppKey(value.slice(0, 52)) && APP_NAME.test(value.slice(53));
}
export function appRef(publisher: string, name: string): string {
  return `${publisher}/${name}`;
}
/** The publisher key of a reference. */
export function appRefPublisher(ref: string): string {
  return ref.slice(0, 52);
}

/**
 * The publisher fingerprint people see: the first 16 z-base32 characters of the key (80 bits), in four groups.
 */
export function appFingerprint(key: string): string {
  return (key.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

/** The bytes a signature covers: the prefix, a zero byte, then the SHA-256 of the object's canonical bytes. */
export function appSignedBytes(prefix: AppPrefix, canonical: Uint8Array): Uint8Array {
  const p = utf8Encode(prefix);
  const out = new Uint8Array(p.length + 1 + 32);
  out.set(p, 0);
  out.set(sha256(canonical), p.length + 1);
  return out;
}

export interface AppSignature { alg: "ed25519"; key: string; sig: string }

/** Signs an object under a prefix: its canonical bytes and the signature statement. */
export async function signAppObject(prefix: AppPrefix, value: unknown, signer: Signer): Promise<{ bytes: Uint8Array; signature: AppSignature }> {
  const bytes = canonicalJsonBytes(value);
  const sig = await signer.sign(appSignedBytes(prefix, bytes));
  return { bytes, signature: { alg: "ed25519", key: toZ32(signer.publicKey), sig: toBase64Url(sig) } };
}

export type AppSignatureRefusal = "bad-signature-statement" | "signature-key" | "bad-signature";

const exactKeys = (value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, JsonValue> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const have = Object.keys(value);
  return keys.every((k) => have.includes(k)) && have.every((k) => keys.includes(k) || optional.includes(k));
};

/** Checks the shape of a signature statement: exactly `alg`, `key` and `sig`, a 64-byte signature. */
export function isAppSignature(value: unknown): value is AppSignature {
  if (!exactKeys(value, ["alg", "key", "sig"])) return false;
  if (value.alg !== "ed25519" || !isAppKey(value.key)) return false;
  return typeof value.sig === "string" && /^[A-Za-z0-9_-]{86}$/.test(value.sig) && toBase64Url(fromBase64Url(value.sig)) === value.sig;
}

/** Reads a signature statement from its bytes, which must be canonical. */
export function readAppSignature(bytes: Uint8Array): { ok: true; signature: AppSignature } | { ok: false; reason: "bad-signature-statement"; detail?: string } {
  if (bytes.length > APP_STATEMENT_LIMITS.signatureBytes) return { ok: false, reason: "bad-signature-statement", detail: "Too large" };
  const read = readCanonicalJson(bytes);
  if (!read.ok) return { ok: false, reason: "bad-signature-statement", detail: read.reason };
  if (!isAppSignature(read.value)) return { ok: false, reason: "bad-signature-statement", detail: "Not {alg, key, sig}" };
  return { ok: true, signature: read.value };
}

/**
 * Verifies a signature over an object's canonical bytes under a prefix, made by `key`: `signature-key` when the
 * statement names another key, `bad-signature` when it does not verify.
 */
export function verifyAppSignature(prefix: AppPrefix, canonical: Uint8Array, signature: AppSignature, key: string): { ok: true } | { ok: false; reason: AppSignatureRefusal } {
  if (!isAppSignature(signature)) return { ok: false, reason: "bad-signature-statement" };
  if (signature.key !== key) return { ok: false, reason: "signature-key" };
  return verify(fromBase64Url(signature.sig), appSignedBytes(prefix, canonical), fromZ32(key)) ? { ok: true } : { ok: false, reason: "bad-signature" };
}

/** Verifies a signed object given as bytes: they must be canonical, then the signature as above. */
export function verifyAppStatementBytes(prefix: AppPrefix, bytes: Uint8Array, signature: AppSignature, key: string): { ok: true; value: JsonValue } | { ok: false; reason: CanonicalJsonRefusal | AppSignatureRefusal } {
  const read = readCanonicalJson(bytes);
  if (!read.ok) return read;
  const checked = verifyAppSignature(prefix, bytes, signature, key);
  return checked.ok ? { ok: true, value: read.value } : checked;
}

// ---------- revocations ----------

/** A publisher's revocation: the listed digests of its app, or every version up to `upTo` (inclusive). */
export type AppRevokeStatement =
  | { ghostlyRevoke: 1; app: string; digests: string[]; reason?: string }
  | { ghostlyRevoke: 1; app: string; upTo: number; reason?: string };
export interface SignedAppRevocation { statement: AppRevokeStatement; signature: AppSignature }

export type AppRevocationRefusal = "bad-revocation" | AppSignatureRefusal;

const isSequence = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isPlainLine = (v: unknown, max: number): v is string => typeof v === "string" && [...v].length <= max && !/\p{Cc}/u.test(v);

/** Checks a revocation statement's shape; the reason it is refused, or null. */
export function checkAppRevokeStatement(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "Not an object";
  const v = value as Record<string, unknown>;
  const byDigests = "digests" in v;
  if (!exactKeys(v, ["ghostlyRevoke", "app", byDigests ? "digests" : "upTo"], ["reason"])) return "Keys are not ghostlyRevoke, app, and exactly one of digests and upTo (reason optional)";
  if (v.ghostlyRevoke !== 1) return "ghostlyRevoke is not 1";
  if (!isAppRef(v.app)) return "app is not a reference";
  if (byDigests) {
    const d = v.digests;
    if (!Array.isArray(d) || d.length < 1 || d.length > APP_STATEMENT_LIMITS.revokeDigests) return "digests is not 1 to 64 digests";
    if (!d.every(isAppHash) || new Set(d).size !== d.length) return "digests holds a bad or repeated digest";
  } else if (!isSequence(v.upTo)) return "upTo is not a sequence";
  if (v.reason !== undefined && !isPlainLine(v.reason, APP_STATEMENT_LIMITS.reason)) return "reason is not one line of 200 characters";
  return null;
}

/** Signs a revocation with the publisher's key. */
export async function signAppRevocation(statement: AppRevokeStatement, signer: Signer): Promise<SignedAppRevocation> {
  const problem = checkAppRevokeStatement(statement);
  if (problem) throw new Error(`Not a revocation: ${problem}`);
  if (toZ32(signer.publicKey) !== appRefPublisher(statement.app)) throw new Error("A revocation is signed by its app's publisher");
  const { signature } = await signAppObject(APP_PREFIXES.revoke, statement, signer);
  return { statement, signature };
}

/**
 * Reads one signed revocation (a parsed value, from `ghostly-revoke.json` or a store index's `revoked`): its shape, then
 * the signature under `ghostly-revoke/1` by the publisher its `app` names.
 */
export function readAppRevocation(value: unknown): { ok: true; revocation: SignedAppRevocation } | { ok: false; reason: AppRevocationRefusal; detail?: string } {
  if (!exactKeys(value, ["statement", "signature"])) return { ok: false, reason: "bad-revocation", detail: "Keys are not statement and signature" };
  const problem = checkAppRevokeStatement(value.statement);
  if (problem) return { ok: false, reason: "bad-revocation", detail: problem };
  if (!isAppSignature(value.signature)) return { ok: false, reason: "bad-signature-statement" };
  const statement = value.statement as unknown as AppRevokeStatement;
  const checked = verifyAppSignature(APP_PREFIXES.revoke, canonicalJsonBytes(statement), value.signature, appRefPublisher(statement.app));
  if (!checked.ok) return checked;
  return { ok: true, revocation: { statement, signature: value.signature } };
}

/**
 * Reads `ghostly-revoke.json`: canonical bytes holding a list of signed revocations. One that does not verify refuses the
 * file, as a store index's `revoked` does.
 */
export function readAppRevocations(bytes: Uint8Array): { ok: true; revocations: SignedAppRevocation[] } | { ok: false; reason: CanonicalJsonRefusal | AppRevocationRefusal; detail?: string } {
  const read = readCanonicalJson(bytes);
  if (!read.ok) return read;
  if (!Array.isArray(read.value) || read.value.length > APP_STATEMENT_LIMITS.revocations) return { ok: false, reason: "bad-revocation", detail: "Not a list of at most 4096 revocations" };
  const revocations: SignedAppRevocation[] = [];
  for (const entry of read.value) {
    const one = readAppRevocation(entry);
    if (!one.ok) return one;
    revocations.push(one.revocation);
  }
  return { ok: true, revocations };
}
