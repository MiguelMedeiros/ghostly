import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { setVerifyFastPath, toZ32, utf8Encode, verify } from "../src";
// covers: core.crypto

/*
 * A host's faster Ed25519 check (the CLI's node:crypto) for every signature the engine checks never changes what
 * verifies: as for app signatures, it is asked only for a canonical key not of small order and an S below the group
 * order, and only its yes counts. So a fast path that says yes to everything still refuses every bad key and every S
 * out of range, and one that says no or throws leaves the strict check's answer.
 */

const seed = new Uint8Array(32).fill(9);
const publicKey = ed25519.getPublicKey(seed);
const message = utf8Encode("a group frame's signed bytes");
const good = ed25519.sign(message, seed);
const L = ed25519.Point.Fn.ORDER;

const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const withS = (sig: Uint8Array, s: bigint) => Uint8Array.from([...sig.subarray(0, 32), ...le(s)]);
const sOf = (sig: Uint8Array) => sig.subarray(32).reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);

/** Node's Ed25519, as the CLI gives it. */
const native = (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) =>
  nodeVerify(null, msg, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]), format: "der", type: "spki" }), sig);

// Keys the strict check refuses whatever the signature: the identity and a point of order 2 (small order), the identity
// again with y + p (not canonical), and a y that is on no point.
const identity = le(1n);
const badKeys = { identity, orderTwo: le((1n << 255n) - 20n), identityPlusP: le(1n + (1n << 255n) - 19n), offCurve: le(2n) };
// The signature a cofactorless check takes for the identity key: R the identity, S zero.
const identitySig = Uint8Array.from([...identity, ...le(0n)]);

afterEach(() => setVerifyFastPath(null));

describe("a signature's fast path", () => {
  it("answers as the strict check does, signature by signature", () => {
    const cases: [Uint8Array, Uint8Array][] = [
      [good, publicKey],
      [ed25519.sign(utf8Encode("other"), seed), publicKey],
      [withS(good, sOf(good) + L), publicKey],
      [identitySig, identity],
      ...Object.values(badKeys).map(key => [good, key] as [Uint8Array, Uint8Array]),
    ];
    const strict = cases.map(([sig, key]) => verify(sig, message, key));
    expect(strict).toEqual([true, false, false, false, false, false, false, false]);
    setVerifyFastPath(native);
    expect(cases.map(([sig, key]) => verify(sig, message, key))).toEqual(strict);
  });

  it("asks a fast path that says yes to everything only for a canonical key of large order and S below L", () => {
    const asked: string[] = [];
    setVerifyFastPath((_sig, _msg, key) => { asked.push(toZ32(key)); return true; });
    for (const key of Object.values(badKeys)) expect(verify(identitySig, message, key)).toBe(false);
    expect(verify(withS(good, sOf(good) + L), message, publicKey)).toBe(false);
    expect(verify(withS(good, L), message, publicKey)).toBe(false);
    expect(verify(good.subarray(0, 63), message, publicKey)).toBe(false);
    expect(asked).toEqual([]);
    expect(verify(withS(good, L - 1n), message, publicKey)).toBe(true);
    asked.length = 0;
    expect(verify(good, message, publicKey)).toBe(true);
    expect(asked).toEqual([toZ32(publicKey)]);
  });

  it("leaves the answer to the strict check when the fast path says no or throws", () => {
    setVerifyFastPath(() => false);
    expect(verify(good, message, publicKey)).toBe(true);
    expect(verify(withS(good, 0n), message, publicKey)).toBe(false);
    setVerifyFastPath(() => { throw new Error("no Ed25519 here"); });
    expect(verify(good, message, publicKey)).toBe(true);
    expect(verify(withS(good, 0n), message, publicKey)).toBe(false);
  });
});
