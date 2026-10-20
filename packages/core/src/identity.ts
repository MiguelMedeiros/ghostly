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

/** How many public keys `identityFromSeed` keeps: a start with 50 chats and 20 groups derives about 400 distinct ones. */
export const IDENTITY_MEMO_SIZE = 1024;
/**
 * Public keys already derived, by the SHA-256 of their seed, the most recently used last. A chat's start derives the
 * same few seeds' keys again and again (its link, its delivery, its capability record): ~0.25 ms each in V8, ~3.4x
 * that in JSC. The seed itself is never kept, so a seed its owner zeroes leaves nothing behind here.
 */
const publicKeys = new Map<string, Uint8Array>();

function publicKeyOf(seed: Uint8Array): Uint8Array {
  const id = toBase64Url(sha256(seed));
  let key = publicKeys.get(id);
  if (key) publicKeys.delete(id);
  else {
    key = ed25519.getPublicKey(seed);
    if (publicKeys.size >= IDENTITY_MEMO_SIZE) publicKeys.delete(publicKeys.keys().next().value!);
  }
  publicKeys.set(id, key);
  // A copy: a caller that writes over its key never changes another's.
  return key.slice();
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

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
