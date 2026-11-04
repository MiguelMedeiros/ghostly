import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProfileKey, isSealedField, openField, rewrapProfileKey, sealField, unlockProfileKey, type FieldBinding, type ProfileKeyRecord } from "../src/shared/profileKey";
import { fromBase64Url, toBase64Url } from "../src/backup/codec";

/**
 * PBKDF2 at 600,000 rounds costs about a second per call on a loaded machine. The derivation runs with fewer rounds
 * here, and the rounds the code asked for are recorded so the cost itself is still checked.
 */
const asked: number[] = [];
beforeEach(() => {
  asked.length = 0;
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => {
    asked.push(algorithm.iterations);
    return derive({ ...algorithm, iterations: 1_000 }, ...rest);
  }) as typeof crypto.subtle.deriveKey);
});
afterEach(() => { vi.restoreAllMocks(); });

const PASS = "throwaway passphrase 1", OTHER = "another passphrase 22";
const SECRET = "seed-for-a-test-profile-only";
const at: FieldBinding = { db: "ghostly", store: "links", key: "link-1", field: "seed" };

describe("the data key wrapped under the passphrase", () => {
  it("is written in the WISP 04 shape at 600,000 PBKDF2-SHA256 rounds, and the passphrase opens it", async () => {
    const { record, key } = await createProfileKey(PASS, "p2");
    expect(record).toMatchObject({ format: "ghostly-profile-key", version: 1, kdf: { name: "PBKDF2-SHA256", iterations: 600_000 }, cipher: { name: "AES-256-GCM" }, profile: "p2" });
    expect(fromBase64Url(record.kdf.salt)).toHaveLength(16);
    expect(fromBase64Url(record.cipher.iv)).toHaveLength(12);
    expect(fromBase64Url(record.ciphertext), "32 key bytes and the tag").toHaveLength(48);
    expect(key.extractable, "the DK can't be read back from memory").toBe(false);
    const opened = await unlockProfileKey(record, PASS, "p2");
    expect(opened.extractable).toBe(false);
    expect(await openField(opened, at, await sealField(key, at, SECRET)), "the unlocked key is the same DK").toBe(SECRET);
    expect(asked.every((n) => n === 600_000)).toBe(true);
  });

  it("refuses a passphrase under 12 characters before deriving anything", async () => {
    await expect(createProfileKey("elevenchars", "")).rejects.toThrow("Use at least 12 characters for the profile passphrase");
    expect(asked).toEqual([]);
  });

  it("a fresh DK, salt and nonce each time", async () => {
    const one = await createProfileKey(PASS, ""), two = await createProfileKey(PASS, "");
    expect(one.record.kdf.salt).not.toBe(two.record.kdf.salt);
    expect(one.record.cipher.iv).not.toBe(two.record.cipher.iv);
    await expect(openField(two.key, at, await sealField(one.key, at, SECRET))).rejects.toThrow("could not be opened");
  });

  it("a wrong passphrase opens nothing, with one error", async () => {
    const { record } = await createProfileKey(PASS, "");
    await expect(unlockProfileKey(record, OTHER, "")).rejects.toThrow(/^Wrong passphrase$/);
    await expect(unlockProfileKey(record, "", "")).rejects.toThrow(/^Wrong passphrase$/);
  });

  it("any change to the clear header, the nonce or the ciphertext makes it fail to open", async () => {
    const { record } = await createProfileKey(PASS, "");
    const flip = (b64: string, i = 0) => { const b = fromBase64Url(b64); b[i] ^= 1; return toBase64Url(b); };
    const changed: ProfileKeyRecord[] = [
      { ...record, kdf: { ...record.kdf, salt: flip(record.kdf.salt) } },
      { ...record, kdf: { ...record.kdf, iterations: 600_001 } },
      { ...record, cipher: { ...record.cipher, iv: flip(record.cipher.iv, 11) } },
      { ...record, ciphertext: flip(record.ciphertext, 47) },
      { ...record, ciphertext: flip(record.ciphertext, 3) },
    ];
    for (const r of changed) await expect(unlockProfileKey(r, PASS, "")).rejects.toThrow("Wrong passphrase");
  });

  it("a record copied into another profile's slot fails there, even with its header rewritten", async () => {
    const { record } = await createProfileKey(PASS, "work");
    asked.length = 0;
    await expect(unlockProfileKey(record, PASS, "")).rejects.toThrow("This profile key belongs to another profile");
    expect(asked, "refused before the KDF").toEqual([]);
    await expect(unlockProfileKey({ ...record, profile: "" }, PASS, ""), "the profile is in the associated data").rejects.toThrow("Wrong passphrase");
  });

  it("refuses an unknown format, version, KDF, cipher or iterations out of bounds without trying the passphrase", async () => {
    const { record } = await createProfileKey(PASS, "");
    asked.length = 0;
    const cases: [unknown, string][] = [
      [{ ...record, format: "ghostly-backup" }, "This is not a Ghostly profile key"],
      [null, "This is not a Ghostly profile key"],
      [{ ...record, version: 2 }, "This profile key comes from a newer Ghostly; update to open it"],
      [{ ...record, kdf: { ...record.kdf, name: "Argon2id" } }, "Unsupported profile key encryption"],
      [{ ...record, kdf: { ...record.kdf, iterations: 599_999 } }, "Unsupported profile key encryption"],
      [{ ...record, kdf: { ...record.kdf, iterations: 10_000_001 } }, "Unsupported profile key encryption"],
      [{ ...record, kdf: { ...record.kdf, iterations: "600000" } }, "Unsupported profile key encryption"],
      [{ ...record, cipher: { ...record.cipher, name: "AES-128-GCM" } }, "Unsupported profile key encryption"],
      [{ ...record, kdf: { ...record.kdf, salt: toBase64Url(new Uint8Array(8)) } }, "Unsupported profile key encryption"],
      [{ ...record, ciphertext: record.ciphertext.slice(0, -4) }, "Unsupported profile key encryption"],
    ];
    for (const [r, error] of cases) await expect(unlockProfileKey(r as ProfileKeyRecord, PASS, "")).rejects.toThrow(error);
    expect(asked).toEqual([]);
  });

  it("a passphrase change keeps the DK: fields sealed before open after, and only the new passphrase opens it", async () => {
    const { record, key } = await createProfileKey(PASS, "p3");
    const sealed = await sealField(key, at, SECRET);
    const next = await rewrapProfileKey(record, PASS, OTHER, "p3");
    expect(next.kdf.salt).not.toBe(record.kdf.salt);
    expect(next.ciphertext).not.toBe(record.ciphertext);
    expect(await openField(await unlockProfileKey(next, OTHER, "p3"), at, sealed)).toBe(SECRET);
    await expect(unlockProfileKey(next, PASS, "p3")).rejects.toThrow("Wrong passphrase");
    await expect(rewrapProfileKey(record, OTHER, PASS, "p3"), "the old passphrase is checked").rejects.toThrow("Wrong passphrase");
    await expect(rewrapProfileKey(record, PASS, "short", "p3")).rejects.toThrow("Use at least 12 characters");
  });
});

describe("a field sealed under the data key (version 2)", () => {
  it("is v2 with a fresh 96-bit nonce, holds no plaintext and runs no KDF", async () => {
    const { key } = await createProfileKey(PASS, "");
    asked.length = 0;
    const one = await sealField(key, at, SECRET), two = await sealField(key, at, SECRET);
    expect(one.v).toBe(2);
    expect(fromBase64Url(one.iv)).toHaveLength(12);
    expect(one.iv).not.toBe(two.iv);
    expect(one.ct).not.toBe(two.ct);
    expect(JSON.stringify(one)).not.toContain(SECRET);
    expect(isSealedField(one)).toBe(true);
    expect(await openField(key, at, one)).toBe(SECRET);
    expect(await openField(key, at, await sealField(key, at, ""))).toBe("");
    expect(asked).toEqual([]);
  });

  it("moved to another database, store, record or field, it fails to open instead of being read as that one", async () => {
    const { key } = await createProfileKey(PASS, "");
    const sealed = await sealField(key, at, SECRET);
    const elsewhere: FieldBinding[] = [
      { ...at, db: "local" },
      { ...at, store: "groups" },
      { ...at, key: "link-2" },
      { ...at, field: "inviteCode" },
      { ...at, key: "link-1\nseed", field: "seed" },
    ];
    for (const where of elsewhere) await expect(openField(key, where, sealed)).rejects.toThrow("A sealed field could not be opened: it was changed, or it belongs to another record");
  });

  it("sealed under another profile's DK, it fails to open", async () => {
    const mine = await createProfileKey(PASS, ""), theirs = await createProfileKey(PASS, "work");
    await expect(openField(theirs.key, at, await sealField(mine.key, at, SECRET))).rejects.toThrow("could not be opened");
  });

  it("a changed nonce or ciphertext, a cut, or another version fails to open", async () => {
    const { key } = await createProfileKey(PASS, "");
    const sealed = await sealField(key, at, SECRET);
    const ct = fromBase64Url(sealed.ct); ct[0] ^= 1;
    for (const bad of [{ ...sealed, ct: toBase64Url(ct) }, { ...sealed, ct: sealed.ct.slice(0, -2) }, { ...sealed, iv: toBase64Url(new Uint8Array(16)) }, { ...sealed, iv: "not base64!" }]) await expect(openField(key, at, bad)).rejects.toThrow("could not be opened");
    await expect(openField(key, at, { ...sealed, v: 1 } as never)).rejects.toThrow("Unsupported sealed field version");
    expect(isSealedField({ version: 1, salt: [], iv: [], ciphertext: [] }), "a version 1 seed is not a v2 field").toBe(false);
  });

  it("refuses a binding whose code-given parts are empty or hold a newline", async () => {
    const { key } = await createProfileKey(PASS, "");
    for (const where of [{ ...at, db: "" }, { ...at, store: "a\nb" }, { ...at, field: "x\ny" }]) await expect(sealField(key, where, SECRET)).rejects.toThrow("Invalid sealed field binding");
  });
});
