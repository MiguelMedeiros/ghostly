import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/**
 * `noise-curve-ed` for browsers: the Ed25519 Noise curve HyperDHT's handshake runs on (WISP 103).
 * The original calls libsodium's `crypto_scalarmult_ed25519_noclamp`, which sodium-javascript (the
 * browser build of sodium-universal) does not have, so a browser's handshake died on its first message.
 * The browser builds swap this module in for it (packages/browser/vite-plugin.ts). Same keys, same
 * shared secrets, same refusals as libsodium (checked against it in test/noiseCurveEd.test.ts).
 */
export const DHLEN = 32;
export const PKLEN = 32;
export const SCALARLEN = 32;
export const SKLEN = 64;
export const ALG = "Ed25519";
export const name = ALG;

export interface CurveKeyPair { publicKey: Uint8Array; secretKey: Uint8Array }

const Point = ed25519.Point;
const ORDER = Point.Fn.ORDER;

/** libsodium's layout: the 32-byte seed, then the public key. */
export function generateKeyPair(privKey?: Uint8Array): CurveKeyPair {
  const seed = privKey ? privKey.subarray(0, 32) : randomBytes(32);
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(SKLEN);
  secretKey.set(seed); secretKey.set(publicKey, 32);
  return { publicKey, secretKey };
}

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/**
 * `crypto_scalarmult_ed25519_noclamp(scalar, publicKey)`: the point must be a canonical encoding in the
 * prime-order subgroup (so the scalar can be taken modulo the group order), and the result may not be
 * the identity. The scalar of a secret key is libsodium's clamped hash of its seed.
 */
export function dh(publicKey: Uint8Array, { scalar, secretKey }: { scalar?: Uint8Array; secretKey?: Uint8Array }): Uint8Array {
  if (!scalar) {
    if (secretKey?.byteLength !== SKLEN) throw new Error("Invalid secret key");
    const hash = sha512(secretKey.subarray(0, 32));
    hash[0] &= 248; hash[31] &= 127; hash[31] |= 64;
    scalar = hash.subarray(0, 32);
  }
  if (scalar.byteLength !== SCALARLEN || publicKey.byteLength !== PKLEN) throw new Error("Invalid key length");
  const point = Point.fromBytes(publicKey, false);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error("Invalid public key");
  const clamped = Uint8Array.from(scalar);
  clamped[31] &= 127;
  const n = littleEndian(clamped) % ORDER;
  if (n === 0n) throw new Error("Invalid scalar");
  return point.multiply(n).toBytes();
}

export default { DHLEN, PKLEN, SCALARLEN, SKLEN, ALG, name, generateKeyPair, dh };
