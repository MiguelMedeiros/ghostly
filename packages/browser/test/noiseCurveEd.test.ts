import { expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import curve from "../src/platform/noiseCurveEd";
// covers: transport.hyperdht-relay

/** The original, on libsodium (sodium-native under Node): what the browser's stand-in must equal. */
const libsodium = (await import("noise-curve-ed")).default as typeof curve;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const random = () => crypto.getRandomValues(new Uint8Array(32));

it("makes libsodium's key pairs from a seed", () => {
  for (let i = 0; i < 50; i++) {
    const seed = random(), ours = curve.generateKeyPair(seed), theirs = libsodium.generateKeyPair(Buffer.from(seed));
    expect(same(ours.publicKey, theirs.publicKey) && same(ours.secretKey, theirs.secretKey)).toBe(true);
  }
  expect(curve.generateKeyPair().secretKey).toHaveLength(64);
  expect([curve.DHLEN, curve.PKLEN, curve.SCALARLEN, curve.SKLEN, curve.ALG]).toEqual([libsodium.DHLEN, libsodium.PKLEN, libsodium.SCALARLEN, libsodium.SKLEN, libsodium.ALG]);
});

it("agrees with libsodium's crypto_scalarmult_ed25519_noclamp on every shared secret", () => {
  for (let i = 0; i < 100; i++) {
    const a = libsodium.generateKeyPair(), b = curve.generateKeyPair();
    const theirs = libsodium.dh(b.publicKey, a), ours = curve.dh(b.publicKey, a);
    expect(same(ours, theirs)).toBe(true);
    // Both ends of a Noise DH get the same secret, whichever implementation each side runs.
    expect(same(curve.dh(a.publicKey, b), theirs)).toBe(true);
    // A tweaked key hands its scalar over directly.
    const scalar = random();
    let expected: Uint8Array | Error, got: Uint8Array | Error;
    try { expected = libsodium.dh(b.publicKey, { scalar: Buffer.from(scalar) }); } catch (error) { expected = error as Error; }
    try { got = curve.dh(b.publicKey, { scalar }); } catch (error) { got = error as Error; }
    if (expected instanceof Error) expect(got).toBeInstanceOf(Error);
    else expect(same(got as Uint8Array, expected)).toBe(true);
  }
});

it("refuses what libsodium refuses: small-order, non-canonical and mixed-order points", () => {
  const smallOrder = "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa";
  const bad = [
    new Uint8Array(32), // y = 0
    Buffer.from("01".padEnd(64, "0"), "hex"), // the identity
    Buffer.from("ec" + "ff".repeat(30) + "7f", "hex"), // y = p - 1, a small-order point
    Buffer.from(smallOrder, "hex"),
    Buffer.from("ed" + "ff".repeat(30) + "7f", "hex"), // y = p, not canonical
    ed25519.Point.BASE.multiply(12345n).add(ed25519.Point.fromBytes(Buffer.from(smallOrder, "hex"), true)).toBytes(),
  ];
  const keys = libsodium.generateKeyPair();
  for (const point of bad) {
    expect(() => libsodium.dh(Buffer.from(point), keys)).toThrow();
    expect(() => curve.dh(point, keys)).toThrow();
  }
  expect(() => curve.dh(new Uint8Array(31), keys)).toThrow();
  expect(() => curve.dh(keys.publicKey, { secretKey: new Uint8Array(32) })).toThrow();
});
