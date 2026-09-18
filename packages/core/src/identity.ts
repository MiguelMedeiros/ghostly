import { ed25519 } from "@noble/curves/ed25519.js";
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

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error("Seed must be exactly 32 bytes");
  const publicKey = ed25519.getPublicKey(seed);
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
  if (bytes.length !== 32) throw new Error("Invalid public key length");
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
