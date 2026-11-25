import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it } from "vitest";
import { setAsyncVerifyFastPath, setVerifyFastPath, toZ32, utf8Encode, verify, verifyAsync } from "../src";
// covers: core.crypto

/*
 * A page's WebCrypto Ed25519 for the signatures a community frame brings (`verifyAsync`): as for the sync fast path, it
 * is asked only for a canonical key not of small order, an S below the group order and an R written canonically, and
 * only its yes counts. A browser's check may compare R as a point: an R written as y + p, or as -0, is then never asked.
 */

const seed = new Uint8Array(32).fill(9);
const { scalar: a, pointBytes: publicKey } = ed25519.utils.getExtendedPublicKey(seed);
const message = utf8Encode("a community frame's signed bytes");
const good = ed25519.sign(message, seed);
const L = ed25519.Point.Fn.ORDER;

const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const leToN = (u: Uint8Array) => u.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
const withS = (sig: Uint8Array, s: bigint) => Uint8Array.from([...sig.subarray(0, 32), ...le(s)]);
const sOf = (sig: Uint8Array) => leToN(sig.subarray(32));
/** A signature by `seed` whose R is these bytes for the identity point: [S]B - [k]A is the identity when S = k·a. */
const identityR = (r: Uint8Array) => {
  const k = leToN(sha512(Uint8Array.from([...r, ...publicKey, ...message]))) % L;
  return Uint8Array.from([...r, ...le((k * a) % L)]);
};
const p = (1n << 255n) - 19n;
// The identity written as y = 1 + p, and as y = 1 with the sign bit (x = 0 as -0): the strict check refuses both, a
// check that decodes R and compares points takes both.
const rPlusP = identityR(le(1n + p));
const rNegZero = identityR(le(1n | (1n << 255n)));
// The point (0, -1) as -0 too.
const minusOneNegZero = Uint8Array.from([...le((p - 1n) | (1n << 255n)), ...good.subarray(32)]);

/** Node's WebCrypto, as a page's. */
const subtle = async (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) =>
  crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "Ed25519" }, false, ["verify"]), new Uint8Array(sig), new Uint8Array(msg));

afterEach(() => { setAsyncVerifyFastPath(null); setVerifyFastPath(null); });

describe("a signature's async fast path", () => {
  it("answers as the strict check does", async () => {
    const cases = [good, ed25519.sign(utf8Encode("other"), seed), withS(good, sOf(good) + L), rPlusP, rNegZero, minusOneNegZero];
    const strict = cases.map(sig => verify(sig, message, publicKey));
    expect(strict).toEqual([true, false, false, false, false, false]);
    setAsyncVerifyFastPath(subtle);
    expect(await Promise.all(cases.map(sig => verifyAsync(sig, message, publicKey)))).toEqual(strict);
  });

  it("is never asked about an R written other than canonically, an S out of range or a key of small order", async () => {
    const asked: string[] = [];
    setAsyncVerifyFastPath(async (_sig, _msg, key) => { asked.push(toZ32(key)); return true; });
    for (const sig of [rPlusP, rNegZero, minusOneNegZero, withS(good, L), withS(good, sOf(good) + L)]) expect(await verifyAsync(sig, message, publicKey)).toBe(false);
    expect(await verifyAsync(good, message, le(1n))).toBe(false);
    expect(asked).toEqual([]);
    expect(await verifyAsync(good, message, publicKey)).toBe(true);
    expect(asked).toEqual([toZ32(publicKey)]);
  });

  it("keeps a sign bit on a canonical R that is not x = 0", async () => {
    const asked: number[] = [];
    setAsyncVerifyFastPath(async () => { asked.push(1); return false; });
    // Signatures until one whose R has the sign bit set: the fast path is asked about it.
    let sig = good;
    for (let i = 0; !(sig[31] & 0x80); i++) sig = ed25519.sign(utf8Encode(`message ${i}`), seed);
    await verifyAsync(sig, message, publicKey);
    expect(asked).toEqual([1]);
  });

  it("leaves the answer to the strict check when the fast path says no or throws", async () => {
    setAsyncVerifyFastPath(async () => false);
    expect(await verifyAsync(good, message, publicKey)).toBe(true);
    expect(await verifyAsync(withS(good, 0n), message, publicKey)).toBe(false);
    setAsyncVerifyFastPath(() => Promise.reject(new Error("no Ed25519 here")));
    expect(await verifyAsync(good, message, publicKey)).toBe(true);
    expect(await verifyAsync(withS(good, 0n), message, publicKey)).toBe(false);
  });

  it("gates the sync fast path the same way", () => {
    setVerifyFastPath(() => true);
    for (const sig of [rPlusP, rNegZero, minusOneNegZero]) expect(verify(sig, message, publicKey)).toBe(false);
  });
});
