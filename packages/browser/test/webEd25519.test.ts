// covers: core.crypto
import { afterEach, describe, expect, it } from "vitest";
import { identityFromSeed, setAsyncVerifyFastPath, sign, utf8Encode, verifyAsync } from "@ghostly/core";
import { installWebEd25519, webCryptoEd25519 } from "../src/platform/webEd25519";

/*
 * A page's engine checks a community frame's signature by WebCrypto's Ed25519 when the page has it and it answers as it
 * should: yes to a good signature, no to a bad one. Otherwise noble's check answers, as before.
 */

const seed = new Uint8Array(32).fill(3);
const { publicKey } = identityFromSeed(seed);
const message = utf8Encode("a frame");
const good = sign(message, seed);
const bad = Uint8Array.from(good);
bad[40] ^= 1;

/** Node's WebCrypto, counting what is asked of it. */
function counted(overrides: Partial<Pick<SubtleCrypto, "verify" | "importKey">> = {}) {
  const calls = { importKey: 0, verify: 0 };
  const subtle = {
    importKey: (...args: Parameters<SubtleCrypto["importKey"]>) => { calls.importKey++; return (overrides.importKey ?? crypto.subtle.importKey.bind(crypto.subtle))(...args); },
    verify: (...args: Parameters<SubtleCrypto["verify"]>) => { calls.verify++; return (overrides.verify ?? crypto.subtle.verify.bind(crypto.subtle))(...args); },
  } as unknown as SubtleCrypto;
  return { subtle, calls };
}

afterEach(() => setAsyncVerifyFastPath(null));

describe("the page's Ed25519 check", () => {
  it("is given when WebCrypto has Ed25519 and answers as it should, and imports each key once", async () => {
    const { subtle, calls } = counted();
    expect(await installWebEd25519(subtle)).toBe(true);
    calls.importKey = calls.verify = 0;
    expect(await verifyAsync(good, message, publicKey)).toBe(true);
    expect(await verifyAsync(bad, message, publicKey)).toBe(false);
    expect(await verifyAsync(sign(utf8Encode("another"), seed), utf8Encode("another"), publicKey)).toBe(true);
    expect(calls).toEqual({ importKey: 1, verify: 3 });
  });

  it("is not given where WebCrypto has no Ed25519, says yes to a bad signature, or no to a good one", async () => {
    expect(await installWebEd25519(null)).toBe(false);
    const noEd25519 = counted({ importKey: () => Promise.reject(new DOMException("Unrecognized name", "NotSupportedError")) });
    expect(await installWebEd25519(noEd25519.subtle)).toBe(false);
    expect(await installWebEd25519(counted({ verify: () => Promise.resolve(true) }).subtle)).toBe(false);
    expect(await installWebEd25519(counted({ verify: () => Promise.resolve(false) }).subtle)).toBe(false);
    // None was given: a check that says yes to everything would have let this one through.
    expect(await verifyAsync(bad, message, publicKey)).toBe(false);
  });

  it("imports a key again after its import failed", async () => {
    let fail = true;
    const { subtle, calls } = counted({ importKey: (...args: Parameters<SubtleCrypto["importKey"]>) => fail ? Promise.reject(new Error("busy")) : crypto.subtle.importKey(...args) });
    const check = webCryptoEd25519(subtle);
    await expect(check(good, message, publicKey)).rejects.toThrow("busy");
    await Promise.resolve();
    fail = false;
    expect(await check(good, message, publicKey)).toBe(true);
    expect(calls.importKey).toBe(2);
  });
});
