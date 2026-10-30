import { createPublicKey, verify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { APP_PREFIXES, appSignedBytes, setAppSignatureFastPath, toBase64Url, toZ32, utf8Encode, verifyAppSignature, type AppSignature } from "../src";

/*
 * A host's faster Ed25519 check (the CLI's node:crypto) never changes what verifies: it is asked only for a canonical
 * key not of small order and an S below the group order, and only its yes counts. So a fast path that says yes to
 * everything still refuses every bad key and every S out of range, and one that throws leaves the strict check's answer.
 */

const seed = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(seed);
const canonical = utf8Encode('{"ghostlyRevoke":1}');
const message = appSignedBytes(APP_PREFIXES.revoke, canonical);
const good = ed25519.sign(message, seed);
const L = ed25519.Point.Fn.ORDER;

const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const withS = (sig: Uint8Array, s: bigint) => Uint8Array.from([...sig.subarray(0, 32), ...le(s)]);
const sOf = (sig: Uint8Array) => sig.subarray(32).reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
const check = (sig: Uint8Array, key: Uint8Array) =>
  verifyAppSignature(APP_PREFIXES.revoke, canonical, { alg: "ed25519", key: toZ32(key), sig: toBase64Url(sig) } as AppSignature, toZ32(key)).ok;

/** Node's Ed25519, as the CLI gives it. */
const native = (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) =>
  verify(null, msg, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]), format: "der", type: "spki" }), sig);

// Keys the strict check refuses whatever the signature: the identity and a point of order 2 (small order), the identity
// again with y + p (not canonical), and a y that is on no point.
const identity = le(1n);
const orderTwo = le((1n << 255n) - 20n);
const identityPlusP = le(1n + (1n << 255n) - 19n);
const offCurve = le(2n);
const badKeys = { identity, orderTwo, identityPlusP, offCurve };
// The signature a cofactorless check takes for the identity key: R the identity, S zero.
const identitySig = Uint8Array.from([...identity, ...le(0n)]);

afterEach(() => setAppSignatureFastPath(null));

describe("an app signature's fast path", () => {
  it("answers as the strict check does, signature by signature", () => {
    const cases: [string, Uint8Array, Uint8Array][] = [
      ["good", good, publicKey],
      ["another message's", ed25519.sign(utf8Encode("other"), seed), publicKey],
      ["S + L", withS(good, sOf(good) + L), publicKey],
      ["the identity key's", identitySig, identity],
      ...Object.entries(badKeys).map(([name, key]) => [name, good, key] as [string, Uint8Array, Uint8Array]),
    ];
    const strict = cases.map(([, sig, key]) => check(sig, key));
    expect(strict).toEqual([true, false, false, false, false, false, false, false]);
    setAppSignatureFastPath(native);
    expect(cases.map(([, sig, key]) => check(sig, key))).toEqual(strict);
  });

  it("asks a fast path that says yes to everything only for a canonical key of large order and S below L", () => {
    const asked: string[] = [];
    setAppSignatureFastPath((_sig, _msg, key) => { asked.push(toZ32(key)); return true; });
    for (const key of Object.values(badKeys)) expect(check(identitySig, key)).toBe(false);
    expect(check(withS(good, sOf(good) + L), publicKey)).toBe(false);
    expect(check(withS(good, L), publicKey)).toBe(false);
    expect(asked).toEqual([]);
    expect(check(withS(good, L - 1n), publicKey)).toBe(true);
    asked.length = 0;
    expect(check(good, publicKey)).toBe(true);
    expect(asked).toEqual([toZ32(publicKey)]);
  });

  it("leaves the answer to the strict check when the fast path says no or throws", () => {
    setAppSignatureFastPath(() => false);
    expect(check(good, publicKey)).toBe(true);
    setAppSignatureFastPath(() => { throw new Error("no Ed25519 here"); });
    expect(check(good, publicKey)).toBe(true);
    expect(check(withS(good, 0n), publicKey)).toBe(false);
  });
});
