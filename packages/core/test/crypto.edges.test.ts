import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  bytesEqual, concatBytes, fromBase64, fromBase64Url, fromZ32, toBase64, toBase64Url, toZ32, utf8Decode, utf8Encode,
} from "../src/bytes";
import { decrypt, encrypt, generateEncryptionKey, tryDecrypt } from "../src/crypto";
import { createIdentity, identityFromSeed, identityFromSeedB64, publicKeyFromZ32, sign, verify } from "../src/identity";

describe("bytes codecs", () => {
  it("round-trips any bytes through base64, base64url and z-base-32", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 96 }), bytes => {
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
      const url = toBase64Url(bytes);
      expect(url).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(url)).toEqual(bytes);
      expect(fromZ32(toZ32(bytes))).toEqual(bytes);
    }), { numRuns: 200 });
  });

  it("encodes buffers larger than one conversion chunk without losing bytes", () => {
    const big = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i & 0xff);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });

  it("refuses characters outside the z-base-32 alphabet", () => {
    expect(() => fromZ32("ybndr0")).toThrow("Invalid z-base-32 character: 0");
    expect(() => fromZ32("YBNDR")).toThrow(/Invalid z-base-32 character/);
    expect(fromZ32("")).toEqual(new Uint8Array(0));
  });

  it("refuses invalid UTF-8 instead of replacing it", () => {
    expect(() => utf8Decode(Uint8Array.of(0xff, 0xfe))).toThrow();
    expect(() => utf8Decode(Uint8Array.of(0xe2, 0x82))).toThrow();
    expect(utf8Decode(utf8Encode("ghost \u{1f47b}"))).toBe("ghost \u{1f47b}");
  });

  it("compares bytes by length and content", () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(false);
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("concatenates nothing into an empty buffer and keeps order otherwise", () => {
    expect(concatBytes()).toEqual(new Uint8Array(0));
    expect(concatBytes(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3))).toEqual(Uint8Array.of(1, 2, 3));
  });
});

describe("secretbox", () => {
  const key = generateEncryptionKey();

  it("round-trips any text and never reuses a nonce", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), text => {
      const a = encrypt(text, key), b = encrypt(text, key);
      expect(a).not.toBe(b);
      expect(decrypt(a, key)).toBe(text);
    }), { numRuns: 100 });
  });

  it("refuses keys that are not 32 bytes, both ways", () => {
    const box = encrypt("hi", key);
    for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)]) {
      expect(() => encrypt("hi", bad)).toThrow("Invalid key length: expected 32 bytes");
      expect(() => decrypt(box, bad)).toThrow("Invalid key length: expected 32 bytes");
      expect(tryDecrypt(box, bad)).toBeNull();
    }
  });

  it("refuses a ciphertext shorter than a nonce and one byte", () => {
    expect(() => decrypt(toBase64(new Uint8Array(24)), key)).toThrow("Invalid ciphertext: too short");
    expect(() => decrypt("", key)).toThrow("Invalid ciphertext: too short");
  });

  it("returns null for the wrong key, a flipped bit, a truncated box or non-base64 input", () => {
    const box = encrypt("secret", key);
    expect(tryDecrypt(box, generateEncryptionKey())).toBeNull();
    const bytes = fromBase64(box);
    for (const i of [0, 23, 24, bytes.length - 1]) {
      const flipped = bytes.slice();
      flipped[i] ^= 1;
      expect(tryDecrypt(toBase64(flipped), key)).toBeNull();
    }
    expect(tryDecrypt(toBase64(bytes.subarray(0, bytes.length - 1)), key)).toBeNull();
    expect(tryDecrypt("not base64 at all!", key)).toBeNull();
    expect(tryDecrypt(box, key)).toBe("secret");
  });

  it("never throws from tryDecrypt, whatever a peer publishes", () => {
    fc.assert(fc.property(fc.string({ maxLength: 120 }), garbage => {
      expect(tryDecrypt(garbage, key)).toBeNull();
    }), { numRuns: 200 });
  });
});

describe("identity", () => {
  it("derives the same identity from a seed, deterministically, and from its base64url form", () => {
    const seed = new Uint8Array(32).fill(7);
    const a = identityFromSeed(seed), b = identityFromSeedB64(toBase64Url(seed));
    expect(a.pubKeyZ32).toBe(b.pubKeyZ32);
    expect(a.pubKeyZ32).toHaveLength(52);
    expect(publicKeyFromZ32(a.pubKeyZ32)).toEqual(a.publicKey);
  });

  it("refuses seeds that are not 32 bytes", () => {
    expect(() => identityFromSeed(new Uint8Array(31))).toThrow("Seed must be exactly 32 bytes");
    expect(() => identityFromSeed(new Uint8Array(33))).toThrow("Seed must be exactly 32 bytes");
    expect(() => identityFromSeedB64(toBase64Url(new Uint8Array(16)))).toThrow("Seed must be exactly 32 bytes");
  });

  it("refuses public keys of the wrong length or alphabet", () => {
    const key = createIdentity().pubKeyZ32;
    expect(() => publicKeyFromZ32(key.slice(1))).toThrow("expected 52 z-base-32 characters");
    expect(() => publicKeyFromZ32(key + "y")).toThrow("expected 52 z-base-32 characters");
    expect(() => publicKeyFromZ32("0" + key.slice(1))).toThrow(/Invalid z-base-32 character/);
  });

  it("verifies only the exact message, under the signer's key", () => {
    const alice = createIdentity(), bob = createIdentity();
    const message = utf8Encode("hello");
    const sig = sign(message, alice.seed);
    expect(verify(sig, message, alice.publicKey)).toBe(true);
    expect(verify(sig, message, bob.publicKey)).toBe(false);
    expect(verify(sig, utf8Encode("hellO"), alice.publicKey)).toBe(false);
    const tampered = sig.slice();
    tampered[10] ^= 1;
    expect(verify(tampered, message, alice.publicKey)).toBe(false);
  });

  it("answers false, never throws, for malformed signatures and keys", () => {
    const alice = createIdentity(), message = utf8Encode("x");
    const sig = sign(message, alice.seed);
    expect(verify(new Uint8Array(10), message, alice.publicKey)).toBe(false);
    expect(verify(new Uint8Array(0), message, alice.publicKey)).toBe(false);
    expect(verify(sig, message, new Uint8Array(31))).toBe(false);
    expect(verify(sig, message, new Uint8Array(32).fill(0xff))).toBe(false);
  });
});
