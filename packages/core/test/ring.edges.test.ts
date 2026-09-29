import { describe, expect, it } from "vitest";
import { base64urlnopad } from "@scure/base";
import { createIdentity } from "../src/identity";
import { RING_LIFETIME, ringAuthorization, ringClaims, ringEvidence, validRingKey, verifyRingAuthorization, verifyRingEvidence } from "../src/pubkyRing";

// The retired Ring delegation: evidence a contact already accepted still verifies, exactly.
// covers: proofs.peer-proofs

const root = createIdentity(), delegate = createIdentity();
const iat = 1_800_000_000, exp = iat + RING_LIFETIME;
const statement = "the statement";
const authorization = ringAuthorization(ringClaims(statement, root.pubKeyZ32, delegate.pubKeyZ32, iat, exp), root.seed);
const enc = (s: string) => base64urlnopad.encode(new TextEncoder().encode(s));

describe("Ring authorizations", () => {
  it("verifies the exact authorization and returns its claims", () => {
    expect(verifyRingAuthorization(authorization, statement, root.pubKeyZ32, iat, exp)).toMatchObject({ iss: root.pubKeyZ32, cnf: delegate.pubKeyZ32 });
  });

  it("refuses to sign claims for an issuer that is not the signing key", () => {
    expect(() => ringAuthorization(ringClaims(statement, delegate.pubKeyZ32, delegate.pubKeyZ32, iat, exp), root.seed)).toThrow("Ring identity mismatch");
  });

  it("refuses a non-string, an oversized one, extra or missing parts and a foreign header", () => {
    const [h, p, s] = authorization.split(".");
    expect(() => verifyRingAuthorization(5 as unknown as string, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid Ring authorization");
    expect(() => verifyRingAuthorization("a".repeat(2401), statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid Ring authorization");
    for (const bad of [`${authorization}.x`, `${h}.${p}`, `${h}..${s}`, `${h}.${p}.`, `${enc('{"alg":"none"}')}.${p}.${s}`]) {
      expect(() => verifyRingAuthorization(bad, statement, root.pubKeyZ32, iat, exp)).toThrow("Unsupported Ring authorization");
    }
  });

  it("refuses claims that are not an object with a valid delegate key", () => {
    const [h, , s] = authorization.split(".");
    for (const claims of ["null", "5", JSON.stringify({ cnf: 5 }), JSON.stringify({ cnf: "not-a-key" })]) {
      expect(() => verifyRingAuthorization(`${h}.${enc(claims)}.${s}`, statement, root.pubKeyZ32, iat, exp)).toThrow("Ring did not authorize this exact conversation");
    }
  });

  it("refuses another statement, another lifetime, another issuer, and a re-encoded signature", () => {
    const expected = "Ring did not authorize this exact conversation";
    expect(() => verifyRingAuthorization(authorization, "another", root.pubKeyZ32, iat, exp)).toThrow(expected);
    expect(() => verifyRingAuthorization(authorization, statement, root.pubKeyZ32, iat, exp + 1)).toThrow(expected);
    expect(() => verifyRingAuthorization(authorization, statement, root.pubKeyZ32, iat + 1, exp + 1)).toThrow(expected);
    expect(() => verifyRingAuthorization(authorization, statement, "not-a-key", iat, exp)).toThrow();
    const [h, p, s] = authorization.split(".");
    const flipped = base64urlnopad.decode(s);
    flipped[0] ^= 1;
    expect(() => verifyRingAuthorization(`${h}.${p}.${base64urlnopad.encode(flipped)}`, statement, root.pubKeyZ32, iat, exp)).toThrow(expected);
    expect(() => verifyRingAuthorization(`${h}.${p}.${s.slice(0, -2)}`, statement, root.pubKeyZ32, iat, exp)).toThrow();
  });

  it("refuses evidence whose envelope, id or possession signature does not match", () => {
    const evidence = ringEvidence(authorization, statement, delegate.seed);
    verifyRingEvidence(evidence, statement, root.pubKeyZ32, iat, exp);
    for (const bad of [null, { ...evidence, scheme: "x" }, { ...evidence, signature: 5 }, { ...evidence, signature: evidence.signature.slice(1) }]) {
      expect(() => verifyRingEvidence(bad as typeof evidence, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid Ring proof");
    }
    expect(() => verifyRingEvidence({ ...evidence, id: "0".repeat(64) }, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid delegated proof of possession");
    const byRoot = ringEvidence(authorization, statement, root.seed);
    expect(() => verifyRingEvidence(byRoot, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid delegated proof of possession");
  });

  it("accepts only canonical, well-formed keys", () => {
    expect(validRingKey(root.pubKeyZ32)).toBe(true);
    expect(validRingKey(root.pubKeyZ32.slice(1))).toBe(false);
    expect(validRingKey("0".repeat(52))).toBe(false);
    // The last character carries four padding bits; a non-zero padding is another spelling of the same key.
    const last = root.pubKeyZ32.at(-1)!;
    const alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
    const alias = root.pubKeyZ32.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    expect(validRingKey(alias)).toBe(false);
  });
});
