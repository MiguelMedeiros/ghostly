import { createPrivateKey, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { AppSignatureFastPath, PublicKeyFastPath } from "@ghostly/core";

/*
 * Node's Ed25519 (OpenSSL's): a signature in tens of microseconds, where the core's portable check takes most of a
 * millisecond, so a list of 4096 revocations is checked in a fraction of a second. OpenSSL verifies as RFC 8032 writes it
 * without the cofactor and compares R byte for byte, which is what the core's fast path asks (see AppSignatureFastPath).
 */

/** SubjectPublicKeyInfo of an Ed25519 key (RFC 8410), before its 32 bytes. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** PKCS #8 of an Ed25519 private key (RFC 8410), before its 32-byte seed. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** The key objects of the keys seen lately: a list repeats its publishers. */
const keys = new Map<string, KeyObject>();

export const nativeEd25519: AppSignatureFastPath = (signature, message, publicKey) => {
  const id = Buffer.from(publicKey).toString("hex");
  let key = keys.get(id);
  if (!key) {
    key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    if (keys.size >= 256) keys.clear();
    keys.set(id, key);
  }
  return verify(null, message, key, signature);
};

/**
 * A seed's public key by Node's Ed25519: ~0.08 ms, where noble's takes ~0.3 ms in a fresh process. A one-shot command
 * derives two for each chat of the profile at its start (its own seed and its participation seed): 400 at 200 chats.
 */
export const nativePublicKey: PublicKeyFastPath = (seed) =>
  createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
