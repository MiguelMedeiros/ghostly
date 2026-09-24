import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createIdentity } from "../src/identity";
import { fitSignedPairedSignal, signPairedSignal, verifyPairedSignal } from "../src/pairedSignal";

const owner = createIdentity(), attacker = createIdentity();
const from = createIdentity().pubKeyZ32, to = createIdentity().pubKeyZ32;
const base = { t: "o", ts: 100, u: "ufrag", p: "password", f: "a".repeat(64), s: "actpass" };
const signal = (c: string[] = []) => JSON.stringify({ ...base, c });

describe("signed discovery signals: refusals", () => {
  it("refuses to sign a signal that is not a valid compact signal", () => {
    expect(() => signPairedSignal("not json", owner.seedB64, from, to)).toThrow(/Invalid outgoing signal/);
    expect(() => signPairedSignal(JSON.stringify({ ...base, s: "evil\r\na=x" , c: [] }), owner.seedB64, from, to)).toThrow(/Invalid outgoing/);
    expect(() => fitSignedPairedSignal("{}", owner.seedB64, from, to, () => true)).toThrow(/Invalid outgoing/);
  });

  it("refuses an input one byte over 4096 before parsing it, and still reads one at the limit", () => {
    const signed = signPairedSignal(signal(), owner.seedB64, from, to);
    const padded = (n: number) => signed + " ".repeat(n - signed.length);
    expect(verifyPairedSignal(padded(4096), from, to, owner.pubKeyZ32, true)).toBe(signal());
    expect(verifyPairedSignal(padded(4097), from, to, owner.pubKeyZ32, true)).toBeNull();
  });

  it("refuses non-JSON, non-signals and malformed authentication without throwing", () => {
    const signed = JSON.parse(signPairedSignal(signal(), owner.seedB64, from, to));
    const cases = [
      "", "{", "null", "[]", "42", JSON.stringify({ t: "x" }),
      JSON.stringify({ ...signed, auth: { key: 7, sig: signed.auth.sig } }),
      JSON.stringify({ ...signed, auth: { key: signed.auth.key, sig: 7 } }),
      JSON.stringify({ ...signed, auth: { key: signed.auth.key, sig: signed.auth.sig.slice(1) } }),
      JSON.stringify({ ...signed, auth: { key: signed.auth.key, sig: signed.auth.sig + "A" } }),
      JSON.stringify({ ...signed, auth: { key: signed.auth.key, sig: "+".repeat(86) } }),
      // A key that is not a z-base-32 public key makes verification throw internally.
      JSON.stringify({ ...signed, auth: { key: "not-a-key", sig: signed.auth.sig } }),
      JSON.stringify({ ...signed, auth: { key: "0".repeat(52), sig: signed.auth.sig } }),
    ];
    for (const input of cases) expect(verifyPairedSignal(input, from, to, undefined, true)).toBeNull();
  });

  it("refuses a correctly signed signal from a key other than the pinned one, and accepts it without a pin", () => {
    const forged = signPairedSignal(signal(), attacker.seedB64, from, to);
    expect(verifyPairedSignal(forged, from, to, owner.pubKeyZ32)).toBeNull();
    expect(verifyPairedSignal(forged, from, to)).toBe(signal());
  });

  it("refuses a signature swapped in from another signed signal by the same key", () => {
    const one = JSON.parse(signPairedSignal(signal(), owner.seedB64, from, to));
    const two = JSON.parse(signPairedSignal(JSON.stringify({ ...base, ts: 101, c: [] }), owner.seedB64, from, to));
    expect(verifyPairedSignal(JSON.stringify({ ...one, auth: two.auth }), from, to, owner.pubKeyZ32, true)).toBeNull();
  });

  it("refuses a signature whose single character changed, wherever it changed", () => {
    const signed = JSON.parse(signPairedSignal(signal(), owner.seedB64, from, to));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    fc.assert(fc.property(fc.nat(85), fc.nat(63), (at, pick) => {
      const sig: string = signed.auth.sig;
      const replacement = alphabet[pick] === sig[at] ? alphabet[(pick + 1) % 64] : alphabet[pick];
      const tampered = sig.slice(0, at) + replacement + sig.slice(at + 1);
      // The last character carries 2 padding bits: two encodings can decode to the same bytes.
      const result = verifyPairedSignal(JSON.stringify({ ...signed, auth: { ...signed.auth, sig: tampered } }), from, to, owner.pubKeyZ32, true);
      if (at < 85) expect(result).toBeNull();
    }), { numRuns: 100 });
  });

  it("never throws and never accepts arbitrary text as a signed signal", () => {
    fc.assert(fc.property(fc.string({ maxLength: 600 }), text => {
      expect(verifyPairedSignal(text, from, to, owner.pubKeyZ32, true)).toBeNull();
    }), { numRuns: 200 });
    fc.assert(fc.property(fc.jsonValue(), value => {
      expect(verifyPairedSignal(JSON.stringify(value), from, to, owner.pubKeyZ32, true)).toBeNull();
    }), { numRuns: 200 });
  });
});

describe("fitting a signed signal into the discovery packet", () => {
  const kinds = (signed: string) => (JSON.parse(signed).c as string[]).map(c => c.split(",")[0]);

  it("drops duplicate candidate types first, then host, then server-reflexive, keeping relay last", () => {
    const c = ["h,10.0.0.1,1", "h,10.0.0.2,2", "s,203.0.113.1,3", "s,203.0.113.2,4", "r,203.0.113.3,5"];
    const seen: string[][] = [];
    const fitted = fitSignedPairedSignal(signal(c), owner.seedB64, from, to, signed => {
      seen.push(kinds(signed));
      return kinds(signed).length === 1;
    });
    expect(seen).toEqual([
      ["h", "h", "s", "s", "r"],
      ["h", "s", "s", "r"],
      ["h", "s", "r"],
      ["s", "r"],
      ["r"],
    ]);
    // Every attempt is signed afresh over what it carries, never truncated after signing.
    expect(verifyPairedSignal(fitted, from, to, owner.pubKeyZ32, true)).toBe(signal(["r,203.0.113.3,5"]));
  });

  it("drops the later of two relay candidates when only relays remain", () => {
    const fitted = fitSignedPairedSignal(signal(["r,203.0.113.1,1", "r,203.0.113.2,2"]), owner.seedB64, from, to,
      signed => kinds(signed).length === 1);
    expect(JSON.parse(fitted).c).toEqual(["r,203.0.113.1,1"]);
  });

  it("returns the signal untouched when it already fits", () => {
    const c = ["h,10.0.0.1,1", "s,203.0.113.1,3"];
    expect(JSON.parse(fitSignedPairedSignal(signal(c), owner.seedB64, from, to, () => true)).c).toEqual(c);
  });

  it("refuses rather than sending no candidate at all", () => {
    expect(() => fitSignedPairedSignal(signal(["h,10.0.0.1,1", "s,203.0.113.1,3"]), owner.seedB64, from, to, () => false))
      .toThrow(/exceed the discovery packet budget/);
    expect(() => fitSignedPairedSignal(signal([]), owner.seedB64, from, to, () => false)).toThrow(/budget/);
  });
});
