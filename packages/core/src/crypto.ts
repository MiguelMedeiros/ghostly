import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { concatBytes, fromBase64, randomBytes, toBase64, utf8Decode, utf8Encode } from "./bytes";

const NONCE_LENGTH = 24;
const KEY_LENGTH = 32;

export function generateEncryptionKey(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

/**
 * NaCl secretbox (XSalsa20-Poly1305). Wire format matches the Rust
 * implementation in `src-tauri/src/crypto.rs`: base64(nonce || box).
 */
export function encrypt(plaintext: string, key: Uint8Array): string {
  if (key.length !== KEY_LENGTH) throw new Error("Invalid key length: expected 32 bytes");
  const nonce = randomBytes(NONCE_LENGTH);
  const box = xsalsa20poly1305(key, nonce).encrypt(utf8Encode(plaintext));
  return toBase64(concatBytes(nonce, box));
}

export function decrypt(encoded: string, key: Uint8Array): string {
  if (key.length !== KEY_LENGTH) throw new Error("Invalid key length: expected 32 bytes");
  const combined = fromBase64(encoded);
  if (combined.length < NONCE_LENGTH + 1) throw new Error("Invalid ciphertext: too short");
  const nonce = combined.subarray(0, NONCE_LENGTH);
  const box = combined.subarray(NONCE_LENGTH);
  return utf8Decode(xsalsa20poly1305(key, nonce).decrypt(box));
}

export function tryDecrypt(encoded: string, key: Uint8Array): string | null {
  try {
    return decrypt(encoded, key);
  } catch {
    return null;
  }
}
