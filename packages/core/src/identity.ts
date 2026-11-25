import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, fromZ32, randomBytes, toBase64Url, toZ32 } from "./bytes";

/**
 * A Ghostly identity is an Ed25519 keypair. The public key, z-base-32 encoded,
 * is the peer's Pkarr address. Today every link (chat) uses its own identity,
 * exactly like Ghostly Desktop.
 */
export interface Identity {
  seed: Uint8Array;
  seedB64: string;
  publicKey: Uint8Array;
  pubKeyZ32: string;
}

/** How many public keys `identityFromSeed` keeps however long ago they were used: a start with 50 chats and 20 groups derives about 400 distinct ones. */
export const IDENTITY_MEMO_SIZE = 1024;
/**
 * Past `IDENTITY_MEMO_SIZE`, a key is let go only once it has not been asked for this long: a start asks for all of a
 * profile's keys within seconds (a 600-chat one, ~4,000 of them), then asks again for the running links' ones.
 */
export const IDENTITY_MEMO_IDLE_MS = 10 * 60_000;
/** The most keys kept, used or not: ~410 bytes each in V8 (its id, its key and when it was used), ~6.7 MB in all. */
export const IDENTITY_MEMO_MAX = 16_384;
/**
 * Public keys already derived, by the SHA-256 of their seed, the most recently used last. A chat's start derives the
 * same few seeds' keys again and again (its link, its delivery, its capability record): ~0.25 ms each in V8, ~3.4x
 * that in JSC. The seed itself is never kept, so a seed its owner zeroes leaves nothing behind here.
 */
const publicKeys = new Map<string, { key: Uint8Array; at: number }>();

/**
 * A faster derivation of a seed's Ed25519 public key a host may give (the CLI gives node:crypto's, ~4x noble's): each
 * process starts with an empty memo, so a one-shot command derives every chat's keys again. A throw, or an answer that
 * is not 32 bytes, leaves the key to noble.
 */
export type PublicKeyFastPath = (seed: Uint8Array) => Uint8Array;

let publicKeyFastPath: PublicKeyFastPath | null = null;

/** Gives (or, with `null`, takes back) the faster derivation of every public key `identityFromSeed` derives. */
export function setPublicKeyFastPath(derive: PublicKeyFastPath | null): void {
  publicKeyFastPath = derive;
}

function derivePublicKey(seed: Uint8Array): Uint8Array {
  if (publicKeyFastPath) {
    try {
      const key = publicKeyFastPath(seed);
      if (key.length === 32) return Uint8Array.from(key);
    } catch { /* noble's below */ }
  }
  return ed25519.getPublicKey(seed);
}

function publicKeyOf(seed: Uint8Array): Uint8Array {
  const id = toBase64Url(sha256(seed));
  const now = Date.now();
  let entry = publicKeys.get(id);
  if (entry) {
    publicKeys.delete(id);
    entry.at = now;
  } else {
    entry = { key: derivePublicKey(seed), at: now };
    for (const [oldest, { at }] of publicKeys) {
      if (publicKeys.size < IDENTITY_MEMO_SIZE) break;
      if (publicKeys.size < IDENTITY_MEMO_MAX && now - at < IDENTITY_MEMO_IDLE_MS) break;
      publicKeys.delete(oldest);
    }
  }
  publicKeys.set(id, entry);
  // A copy: a caller that writes over its key never changes another's.
  return entry.key.slice();
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error("Seed must be exactly 32 bytes");
  const publicKey = publicKeyOf(seed);
  return {
    seed,
    seedB64: toBase64Url(seed),
    publicKey,
    pubKeyZ32: toZ32(publicKey),
  };
}

export function identityFromSeedB64(seedB64: string): Identity {
  return identityFromSeed(fromBase64Url(seedB64));
}

export function createIdentity(): Identity {
  return identityFromSeed(randomBytes(32));
}

export function publicKeyFromZ32(z32: string): Uint8Array {
  if (z32.length !== 52) throw new Error("Invalid public key: expected 52 z-base-32 characters");
  const bytes = fromZ32(z32);
  // One key, one spelling: a 52-character string whose four padding bits are not zero decodes to the same 32 bytes
  // as the canonical one but is not it, and keys are compared as strings (WISP 02).
  if (toZ32(bytes) !== z32) throw new Error("Invalid public key: not canonical z-base-32");
  return bytes;
}

export function sign(message: Uint8Array, seed: Uint8Array): Uint8Array {
  return ed25519.sign(message, seed);
}

/**
 * A faster Ed25519 check a host may give (the CLI gives node:crypto's): RFC 8032's verification without the cofactor,
 * which compares the signature's R with the encoding of the [S]B - [k]A it computes, as OpenSSL's does. It is asked only
 * when the key is the canonical encoding of a point not of small order and S is below the group order
 * (`ed25519FastPathTakes`), and only its yes counts: R is then the canonical encoding of that point, so the strict check
 * says yes too. Its no, or a throw, leaves the answer to the strict check, so what verifies is exactly what verifies
 * without it.
 */
export type VerifyFastPath = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;

let verifyFastPath: VerifyFastPath | null = null;

/**
 * Gives (or, with `null`, takes back) the faster check of every signature `verify` checks: noble's takes ~1-3 ms, and a
 * community member checks one for each frame it takes (a catch-up of 256 frames, each message of a busy group).
 */
export function setVerifyFastPath(check: VerifyFastPath | null): void {
  verifyFastPath = check;
}

/** The group order L, little-endian: an S at or above it is refused by the strict check. */
const GROUP_ORDER = Uint8Array.from([
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
]);
/** The most keys `keysFit` holds: a community's 256 members, with room for the chats' and records' keys. */
const KEYS_FIT_MAX = 1024;
/** Whether each key seen lately is a canonical encoding of a point not of small order: the same signers come back. */
const keysFit = new Map<string, boolean>();

/**
 * Whether a fast path may be asked about this signature and key (`VerifyFastPath`). App signatures keep their own twin
 * in `appStatements.ts`: the website copies that file alone (`apps/website/lib/store-core`).
 */
export function ed25519FastPathTakes(signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  let below = false;
  for (let i = 31; i >= 0; i--) {
    if (signature[32 + i] !== GROUP_ORDER[i]) { below = signature[32 + i] < GROUP_ORDER[i]; break; }
  }
  if (!below) return false;
  const id = toBase64Url(publicKey);
  let fit = keysFit.get(id);
  if (fit === undefined) {
    try { fit = !ed25519.Point.fromBytes(publicKey, false).isSmallOrder(); } catch { fit = false; }
    if (keysFit.size >= KEYS_FIT_MAX) keysFit.clear();
    keysFit.set(id, fit);
  }
  return fit;
}

/**
 * Ed25519 verification as RFC 8032 writes it (`zip215: false`): canonical encodings only, and no key of small order,
 * which no secret key goes with and which "verifies" a constant signature of any message.
 */
export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (verifyFastPath && ed25519FastPathTakes(signature, publicKey)) {
    try { if (verifyFastPath(signature, message, publicKey)) return true; } catch { /* the strict check answers */ }
  }
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
