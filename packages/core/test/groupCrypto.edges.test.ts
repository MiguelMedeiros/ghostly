import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromBase64Url, toBase64Url, utf8Encode } from "../src/bytes";
import {
  confirmationMatches, confirmationTag, decryptText, edgeParams, encryptText, epochKeys, newEpochSecret, openSecret, sealSecret, sha256Hex,
} from "../src/groupCrypto";
import { createIdentity } from "../src/identity";

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

describe("epoch key schedule", () => {
  it("refuses an epoch secret that is not 32 bytes", () => {
    for (const n of [0, 16, 31, 33, 64]) expect(() => epochKeys(new Uint8Array(n), "g", 0)).toThrow("Invalid epoch secret");
  });

  it("is deterministic for one secret, group and epoch, and separates groups and epochs", () => {
    const secret = new Uint8Array(32).fill(3);
    const a = epochKeys(secret, "group-a", 4), again = epochKeys(secret.slice(), "group-a", 4);
    expect(hex(a.message)).toBe(hex(again.message));
    expect(hex(a.confirm)).toBe(hex(again.confirm));
    expect(a.message).toHaveLength(32);
    expect(hex(epochKeys(secret, "group-b", 4).message)).not.toBe(hex(a.message));
    expect(hex(epochKeys(secret, "group-a", 5).message)).not.toBe(hex(a.message));
    // "g/1" + epoch 1 and "g" + epoch 11 would collide without the separator: they do not.
    expect(hex(epochKeys(secret, "g/1", 1).message)).not.toBe(hex(epochKeys(secret, "g", 11).message));
  });

  it("hashes to lowercase hex of SHA-256", () => {
    expect(sha256Hex(utf8Encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array(0))).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("sealed epoch secrets", () => {
  const bob = createIdentity();
  const secret = newEpochSecret();
  const sealed = sealSecret(bob.pubKeyZ32, secret, "aad");

  it("uses a fresh ephemeral key and nonce each time", () => {
    const again = sealSecret(bob.pubKeyZ32, secret, "aad");
    expect(again.e).not.toBe(sealed.e);
    expect(again.n).not.toBe(sealed.n);
    expect(openSecret(bob.seed, bob.pubKeyZ32, again, "aad")).toEqual(secret);
  });

  it("refuses to seal to something that is not a member key", () => {
    expect(() => sealSecret("not-a-key", secret, "aad")).toThrow();
  });

  it("does not open when the recipient name it is bound to differs from the key opening it", () => {
    const carol = createIdentity();
    expect(openSecret(bob.seed, carol.pubKeyZ32, sealed, "aad")).toBeNull();
  });

  it("does not open with a wrong-length ephemeral key or nonce", () => {
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, e: toBase64Url(new Uint8Array(31)) }, "aad")).toBeNull();
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, e: sealed.e + "AA" }, "aad")).toBeNull();
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, n: toBase64Url(new Uint8Array(12)) }, "aad")).toBeNull();
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, n: "" }, "aad")).toBeNull();
  });

  it("does not open with a swapped ephemeral key or nonce", () => {
    const other = sealSecret(bob.pubKeyZ32, secret, "aad");
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, e: other.e }, "aad")).toBeNull();
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, n: other.n }, "aad")).toBeNull();
  });

  it("returns null, never throws, for fields that are not base64url", () => {
    for (const field of ["e", "n", "c"] as const) {
      expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, [field]: "!!!!" }, "aad")).toBeNull();
    }
    expect(openSecret(bob.seed, bob.pubKeyZ32, { ...sealed, c: "" }, "aad")).toBeNull();
  });

  it("opens only a 32-byte secret: a box that holds anything else is refused", () => {
    const short = sealSecret(bob.pubKeyZ32, new Uint8Array(16).fill(1), "aad");
    expect(openSecret(bob.seed, bob.pubKeyZ32, short, "aad")).toBeNull();
    const long = sealSecret(bob.pubKeyZ32, new Uint8Array(33).fill(1), "aad");
    expect(openSecret(bob.seed, bob.pubKeyZ32, long, "aad")).toBeNull();
  });

  it("never opens random boxes", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ minLength: 24, maxLength: 24 }), fc.uint8Array({ maxLength: 80 }),
      (e, n, c) => { expect(openSecret(bob.seed, bob.pubKeyZ32, { e: toBase64Url(e), n: toBase64Url(n), c: toBase64Url(c) }, "aad")).toBeNull(); }),
    { numRuns: 100 });
  });
});

describe("epoch message encryption", () => {
  const key = epochKeys(newEpochSecret(), "g", 1).message;

  it("round-trips any text under its header", () => {
    fc.assert(fc.property(fc.string({ maxLength: 100 }), fc.string({ maxLength: 20 }), (text, aad) => {
      const box = encryptText(key, aad, text);
      expect(fromBase64Url(box.n)).toHaveLength(24);
      expect(decryptText(key, aad, box.n, box.c)).toBe(text);
    }), { numRuns: 100 });
  });

  it("refuses a nonce of the wrong length, a truncated or bit-flipped box, and non-base64 input", () => {
    const box = encryptText(key, "h", "hello");
    expect(decryptText(key, "h", toBase64Url(new Uint8Array(23)), box.c)).toBeNull();
    expect(decryptText(key, "h", box.n + "AA", box.c)).toBeNull();
    expect(decryptText(key, "h", box.n, box.c.slice(0, -4))).toBeNull();
    const bytes = fromBase64Url(box.c);
    bytes[0] ^= 0x80;
    expect(decryptText(key, "h", box.n, toBase64Url(bytes))).toBeNull();
    expect(decryptText(key, "h", "!!", box.c)).toBeNull();
    expect(decryptText(key, "h", box.n, "!!")).toBeNull();
    expect(decryptText(key, "h", box.n, "")).toBeNull();
  });

  it("refuses a box whose plaintext is not valid UTF-8", async () => {
    const { xchacha20poly1305 } = await import("@noble/ciphers/chacha.js");
    const nonce = new Uint8Array(24);
    const c = xchacha20poly1305(key, nonce, utf8Encode("h")).encrypt(Uint8Array.of(0xff, 0xfe));
    expect(decryptText(key, "h", toBase64Url(nonce), toBase64Url(c))).toBeNull();
  });
});

describe("confirmation tags", () => {
  const confirm = epochKeys(newEpochSecret(), "g", 2).confirm;
  const tag = confirmationTag(confirm, "a".repeat(64));

  it("is 43 base64url characters and deterministic", () => {
    expect(tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(confirmationTag(confirm, "a".repeat(64))).toBe(tag);
  });

  it("refuses truncated, extended, bit-flipped and non-base64 tags without throwing", () => {
    expect(confirmationMatches(confirm, "a".repeat(64), tag.slice(0, -1))).toBe(false);
    expect(confirmationMatches(confirm, "a".repeat(64), tag + "A")).toBe(false);
    expect(confirmationMatches(confirm, "a".repeat(64), (tag[0] === "A" ? "B" : "A") + tag.slice(1))).toBe(false);
    expect(confirmationMatches(confirm, "a".repeat(64), "!".repeat(43))).toBe(false);
    expect(confirmationMatches(confirm, "a".repeat(64), "")).toBe(false);
  });
});

describe("pairwise edges", () => {
  it("is deterministic and never pins a side to its own key", () => {
    const a = createIdentity(), b = createIdentity();
    const one = edgeParams("g", a.seed, a.pubKeyZ32, b.pubKeyZ32), two = edgeParams("g", a.seed, a.pubKeyZ32, b.pubKeyZ32);
    expect(one).toEqual(two);
    expect(one.peerPubKeyZ32).not.toBe(a.pubKeyZ32);
    expect(one.peerPubKeyZ32).not.toBe(b.pubKeyZ32);
    expect(fromBase64Url(one.encKeyB64)).toHaveLength(32);
  });

  it("refuses a peer that is not a member key", () => {
    const a = createIdentity();
    expect(() => edgeParams("g", a.seed, a.pubKeyZ32, "short")).toThrow();
  });
});
