import { ed25519 } from "@noble/curves/ed25519.js";
import { sign } from "./identity";

/*
 * A signer (WISP 06 § Terms): an Ed25519 key that signs without the caller holding its seed. The device signing key
 * is non-extractable where WebCrypto offers Ed25519, so the app has no bytes to sign with; where it does not, the key
 * is a stored seed. Both are this one interface, and so is a chat's participation seed when a session is given one.
 *
 * Signing is asynchronous because WebCrypto is. The public key is known at once: a session puts it in its offer
 * before it signs anything.
 */
export interface Signer {
  /** The Ed25519 public key, 32 bytes. */
  readonly publicKey: Uint8Array;
  /** The 64-byte signature of `bytes`. */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** A seed held by the app, as every key of a profile is today. */
export function seedSigner(seed: Uint8Array): Signer {
  if (seed.length !== 32) throw new Error("Seed must be exactly 32 bytes");
  const publicKey = ed25519.getPublicKey(seed);
  return { publicKey, sign: async (bytes) => sign(bytes, seed) };
}

/**
 * A WebCrypto Ed25519 private key, non-extractable or not, with its raw public key. The app never sees the private
 * bytes: `crypto.subtle` signs.
 */
export function webCryptoSigner(privateKey: CryptoKey, publicKey: Uint8Array): Signer {
  if (publicKey.length !== 32) throw new Error("An Ed25519 public key is 32 bytes");
  return {
    publicKey,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new Uint8Array(bytes))),
  };
}
