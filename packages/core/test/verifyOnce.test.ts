import { describe, expect, it } from "vitest";
import * as identity from "../src/identity";
import { verifyOnce } from "./support/verifyOnce";

/*
 * The slow community tests check each signature once (`verifyOnce`): what they test must not change. A
 * signature, message or key that differs from one already answered by a single byte is checked again, and a forged one
 * stays refused however often the real one was checked.
 */

describe("verifyOnce", () => {
  const signer = identity.createIdentity(), other = identity.createIdentity();
  const message = new TextEncoder().encode("a commit");
  const signature = identity.sign(message, signer.seed);

  it("checks a signature, message and key once, and answers the same bytes again from that", () => {
    let calls = 0;
    const { verify } = verifyOnce({ ...identity, verify: (...args) => { calls++; return identity.verify(...args); } });
    for (let i = 0; i < 5; i++) expect(verify(signature, message, signer.publicKey)).toBe(true);
    // Equal bytes in other arrays are the same question.
    expect(verify(Uint8Array.from(signature), Uint8Array.from(message), Uint8Array.from(signer.publicKey))).toBe(true);
    expect(calls).toBe(1);
  });

  it("still refuses a forged signature, message or key after the real one was answered", () => {
    let calls = 0;
    const { verify } = verifyOnce({ ...identity, verify: (...args) => { calls++; return identity.verify(...args); } });
    expect(verify(signature, message, signer.publicKey)).toBe(true);
    const flipped = (bytes: Uint8Array, at: number) => { const copy = Uint8Array.from(bytes); copy[at] ^= 1; return copy; };
    expect(verify(flipped(signature, 10), message, signer.publicKey)).toBe(false);
    expect(verify(signature, flipped(message, 0), signer.publicKey)).toBe(false);
    expect(verify(signature, message.subarray(1), signer.publicKey)).toBe(false);
    expect(verify(signature, message, other.publicKey)).toBe(false);
    // A refusal is kept as one too, and the real one still verifies.
    expect(verify(signature, message, other.publicKey)).toBe(false);
    expect(verify(signature, message, signer.publicKey)).toBe(true);
    expect(calls).toBe(5);
  });

  it("keeps what it answered from the caller's arrays changing after", () => {
    const { verify } = verifyOnce(identity);
    const mutable = Uint8Array.from(message);
    expect(verify(signature, mutable, signer.publicKey)).toBe(true);
    mutable[0] ^= 1;
    expect(verify(signature, mutable, signer.publicKey)).toBe(false);
  });
});
