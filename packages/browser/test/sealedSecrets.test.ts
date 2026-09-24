import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentReview } from "@ghostly/core";
import { intentRepository, newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "../src/engine/paymentAdapters/persistence";
import type { SavedIntent } from "../src/engine/paymentAdapters/coordinator";
import { redact } from "../src/engine/paymentAdapters/providers/types";
import { STORES, transact } from "../src/shared/idb";
// covers: payments.chat.reconcile, wallet.ark.backup, wallet.usdt.backup

/**
 * PBKDF2 at 600,000 rounds costs about a second per call on a loaded machine. The derivation is run with
 * fewer rounds here, and the rounds the code asked for are recorded so the cost itself is still checked.
 */
const asked: number[] = [];
function fastKdf() {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  return vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => {
    asked.push(algorithm.iterations);
    return derive({ ...algorithm, iterations: 1_000 }, ...rest);
  }) as typeof crypto.subtle.deriveKey);
}
beforeEach(() => { asked.length = 0; fastKdf(); });
afterEach(() => { vi.restoreAllMocks(); });

const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("a wallet seed sealed under a password", () => {
  it("opens only with its password, with a fresh salt and nonce each time, and never shows the seed", async () => {
    const one = await sealSeed(SEED, "correct horse battery");
    const two = await sealSeed(SEED, "correct horse battery");
    expect(one.version).toBe(1);
    expect(one.salt).toHaveLength(16);
    expect(one.iv).toHaveLength(12);
    expect(one.salt).not.toEqual(two.salt);
    expect(one.iv).not.toEqual(two.iv);
    expect(JSON.stringify(one)).not.toContain("abandon");
    expect(new TextDecoder().decode(new Uint8Array(one.ciphertext))).not.toContain("abandon");
    expect(await unsealSeed(one, "correct horse battery")).toBe(SEED);
    expect(asked.every((n) => n === 600_000), "the key costs 600,000 PBKDF2-SHA256 rounds").toBe(true);
  });

  it("refuses a password shorter than 12 characters before sealing anything", async () => {
    await expect(sealSeed(SEED, "elevenchars")).rejects.toThrow("Use at least 12 characters for the wallet password");
    expect(asked).toEqual([]);
  });

  it("any change to the salt, the nonce or the ciphertext, or a cut, makes it fail to open instead of opening wrong", async () => {
    const sealed = await sealSeed(SEED, "correct horse battery");
    const flip = (bytes: number[], at = 0) => bytes.map((b, i) => (i === at ? b ^ 1 : b));
    const changed: EncryptedSeed[] = [
      { ...sealed, salt: flip(sealed.salt) },
      { ...sealed, iv: flip(sealed.iv, 11) },
      { ...sealed, ciphertext: flip(sealed.ciphertext, sealed.ciphertext.length - 1) },
      { ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) },
      { ...sealed, ciphertext: [] },
    ];
    for (const seed of changed) await expect(unsealSeed(seed, "correct horse battery")).rejects.toThrow("Could not unlock the wallet. Check the password and backup.");
    await expect(unsealSeed(sealed, "")).rejects.toThrow("Could not unlock the wallet");
  });

  it("a vault of another version is refused as such, without trying the password", async () => {
    const sealed = await sealSeed(SEED, "correct horse battery");
    asked.length = 0;
    await expect(unsealSeed({ ...sealed, version: 2 as 1 }, "correct horse battery")).rejects.toThrow("Unsupported wallet backup version");
    expect(asked).toEqual([]);
  });

  it("a device key is 256 random bits, different every time, and long enough to seal with", async () => {
    const keys = new Set(Array.from({ length: 20 }, newDeviceKey));
    expect(keys.size).toBe(20);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9+/]{43}$/);
    const key = [...keys][0];
    expect(await unsealSeed(await sealSeed(SEED, key), key)).toBe(SEED);
  });
});

describe("a payment is submitted once, or cancelled, never both", () => {
  let n = 0;
  function intent(over: Partial<PaymentReview> = {}): SavedIntent {
    return { review: { id: `i${++n}`, requestId: "ask-1", linkId: "alice", payee: "alice", method: "arkade", network: "regtest", provider: "http://127.0.0.1:43010", asset: "BTC", unit: "sat", address: "fixture", expiresAt: Date.now() + 60_000, createdAt: Date.now(), amount: 10, fee: 0, feeCap: 0, state: "pending", ...over } as PaymentReview, prepared: {} };
  }
  const usdt = (from: string, over: Partial<PaymentReview> = {}) => intent({ method: "usdt", network: "sepolia", chainId: 11155111, requestId: undefined, evm: { from, nonce: 0, gasLimit: "0", maxFeePerGas: "0", maxPriorityFeePerGas: "0", confirmations: 1 }, ...over } as Partial<PaymentReview>);
  const put = async (...intents: SavedIntent[]) => { for (const i of intents) await intentRepository.put(i); return intents; };
  const state = async (id: string) => (await intentRepository.get(id))?.review.state;

  beforeEach(async () => { await transact([STORES.intents], (s) => s[STORES.intents].clear()); });

  it("claims a pending payment and clears its last error; anything else is refused and left as it was", async () => {
    const [pending, settled] = await put(intent({ error: "timed out" }), intent({ state: "settled", requestId: "ask-2" }));
    const claimed = await intentRepository.claim(pending.review.id);
    expect(claimed.review).toMatchObject({ state: "submitted", error: undefined });
    expect(await state(pending.review.id)).toBe("submitted");
    await expect(intentRepository.claim(pending.review.id), "submitted already").rejects.toThrow("This payment was already submitted or could not be saved");
    await expect(intentRepository.claim(settled.review.id)).rejects.toThrow("already submitted");
    await expect(intentRepository.claim("never-saved")).rejects.toThrow("already submitted");
    expect(await state(settled.review.id)).toBe("settled");
  });

  it("a request already paid, being paid, or of unknown outcome is not paid again by another intent", async () => {
    for (const earlier of ["submitted", "settled", "unknown"] as const) {
      const [first, second] = await put(intent({ state: earlier, requestId: `ask-${earlier}` }), intent({ requestId: `ask-${earlier}` }));
      await expect(intentRepository.claim(second.review.id), earlier).rejects.toThrow("already submitted");
      expect(await state(second.review.id)).toBe("pending");
      expect(await state(first.review.id)).toBe(earlier);
    }
  });

  it("a request whose earlier attempt failed or was cancelled can be paid; the same request id from another contact is another request", async () => {
    const [, , retry] = await put(intent({ state: "failed", requestId: "ask-9" }), intent({ state: "cancelled", requestId: "ask-9" }), intent({ requestId: "ask-9" }));
    expect((await intentRepository.claim(retry.review.id)).review.state).toBe("submitted");
    const [, other] = await put(intent({ state: "settled", requestId: "ask-10", linkId: "alice" }), intent({ requestId: "ask-10", linkId: "bob" }));
    expect((await intentRepository.claim(other.review.id)).review.state).toBe("submitted");
  });

  it("a USDT payment waits while another from the same address and chain may still take its nonce", async () => {
    const from = "0x00000000000000000000000000000000000000aa";
    for (const earlier of ["submitted", "unknown"] as const) {
      await transact([STORES.intents], (s) => s[STORES.intents].clear());
      const [, next] = await put(usdt(from, { state: earlier }), usdt(from));
      await expect(intentRepository.claim(next.review.id), earlier).rejects.toThrow("already submitted");
    }
    await transact([STORES.intents], (s) => s[STORES.intents].clear());
    const [, , , free] = await put(usdt(from, { state: "settled" }), usdt("0x00000000000000000000000000000000000000bb", { state: "submitted" }), usdt(from, { state: "submitted", chainId: 1 } as Partial<PaymentReview>), usdt(from));
    expect((await intentRepository.claim(free.review.id)).review.state).toBe("submitted");
  });

  it("only a pending payment can be cancelled; a submitted one is reconciled instead", async () => {
    const [pending, submitted] = await put(intent(), intent({ state: "submitted", requestId: "ask-3" }));
    expect((await intentRepository.cancel(pending.review.id)).review.state).toBe("cancelled");
    expect(await state(pending.review.id)).toBe("cancelled");
    await expect(intentRepository.claim(pending.review.id), "cancelled is final").rejects.toThrow("already submitted");
    await expect(intentRepository.cancel(submitted.review.id)).rejects.toThrow("A submitted payment cannot be cancelled; reconcile it instead");
    await expect(intentRepository.cancel("never-saved")).rejects.toThrow("cannot be cancelled");
    expect(await state(submitted.review.id)).toBe("submitted");
  });
});

describe("an error message fit to show and store", () => {
  it("blanks every secret the source was given, wherever and however often a library echoed it", () => {
    const secrets = { uri: "nostr+walletconnect://abc?secret=deadbeef", rune: "rune-XYZ123" };
    const error = new Error(`connect ${secrets.uri} failed; retry ${secrets.uri} with rune-XYZ123`);
    const shown = redact(error, secrets);
    expect(shown).toBe("connect ••• failed; retry ••• with •••");
    expect(shown).not.toContain("deadbeef");
  });

  it("leaves words alone for secrets too short to be one, reads non-errors, and stays short", () => {
    expect(redact(new Error("bad pin 123 at id"), { pin: "123", empty: "", id: "id" })).toBe("bad pin 123 at id");
    expect(redact("plain string", {})).toBe("plain string");
    expect(redact({ toString: () => "an object" })).toBe("an object");
    expect(redact(new Error("x".repeat(1_000)))).toHaveLength(300);
    // A secret longer than the message's first 300 characters is still blanked before the cut.
    const long = "s".repeat(400);
    expect(redact(new Error(`key ${long}`), { long })).toBe("key •••");
  });
});
