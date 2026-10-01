import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentPreflightError, type PaymentAdapter, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { intentRepository, newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "../src/engine/paymentAdapters/persistence";
import { PaymentCoordinator, type SavedIntent } from "../src/engine/paymentAdapters/coordinator";
import { redact } from "../src/engine/paymentAdapters/providers/types";
import { STORES, transact } from "../src/shared/idb";
import { phraseLeaks, TEST_PHRASE } from "./helpers/phraseLeaks";
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

const SEED = TEST_PHRASE;

describe("a wallet seed sealed under a password", () => {
  it("opens only with its password, with a fresh salt and nonce each time, and never shows the seed", async () => {
    const one = await sealSeed(SEED, "correct horse battery");
    const two = await sealSeed(SEED, "correct horse battery");
    expect(one.version).toBe(1);
    expect(one.salt).toHaveLength(16);
    expect(one.iv).toHaveLength(12);
    expect(one.salt).not.toEqual(two.salt);
    expect(one.iv).not.toEqual(two.iv);
    expect(phraseLeaks(JSON.stringify(one))).toEqual([]);
    expect(phraseLeaks(new TextDecoder().decode(new Uint8Array(one.ciphertext)))).toEqual([]);
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
  const evm = (from: string, nonce: number) => ({ from, nonce, gasLimit: "0", maxFeePerGas: "0", maxPriorityFeePerGas: "0", confirmations: 2 });
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

  it("a USDT review made at a nonce another payment from the same address and chain still holds is refused", async () => {
    const from = "0x00000000000000000000000000000000000000aa";
    for (const earlier of ["submitted", "unknown"] as const) {
      await transact([STORES.intents], (s) => s[STORES.intents].clear());
      const [, same, lower] = await put(usdt(from, { state: earlier, evm: evm(from, 4) }), usdt(from, { evm: evm(from, 4) }), usdt(from, { evm: evm(from, 3) }));
      await expect(intentRepository.claim(same.review.id), earlier).rejects.toThrow("A payment from this wallet was sent after this review was made. Create a new review");
      await expect(intentRepository.claim(lower.review.id), earlier).rejects.toThrow("Create a new review");
      expect(await state(same.review.id)).toBe("pending");
    }
    await transact([STORES.intents], (s) => s[STORES.intents].clear());
    const [, , , free] = await put(usdt(from, { state: "settled" }), usdt("0x00000000000000000000000000000000000000bb", { state: "submitted" }), usdt(from, { state: "submitted", chainId: 1 } as Partial<PaymentReview>), usdt(from));
    expect((await intentRepository.claim(free.review.id)).review.state).toBe("submitted");
  });

  it("a second, distinct USDT payment made while the first confirms takes the next nonce and goes", async () => {
    const from = "0x00000000000000000000000000000000000000Aa";
    const [first, second, third] = await put(usdt(from, { state: "submitted", evm: evm(from, 7) }), usdt(from.toLowerCase(), { evm: evm(from.toLowerCase(), 8) }), usdt(from, { evm: evm(from, 9) }));
    expect((await intentRepository.claim(second.review.id)).review.state).toBe("submitted");
    expect((await intentRepository.claim(third.review.id)).review.state, "a third one after both").toBe("submitted");
    expect(await state(first.review.id)).toBe("submitted");
    await expect(intentRepository.claim(second.review.id), "the same payment again").rejects.toThrow("This payment was already submitted or could not be saved");
  });

  it("an app that stopped between sending and saving leaves the payment submitted: it is not sent again, and its nonce stays taken", async () => {
    const from = "0x00000000000000000000000000000000000000aa";
    const [crashed] = await put(usdt(from, { evm: evm(from, 2) }));
    // claim() is the write before the broadcast; the app stops before the result is saved.
    await intentRepository.claim(crashed.review.id);
    const [before, after] = await put(usdt(from, { evm: evm(from, 2) }), usdt(from, { evm: evm(from, 3) }));
    await expect(intentRepository.claim(crashed.review.id)).rejects.toThrow("already submitted");
    await expect(intentRepository.claim(before.review.id)).rejects.toThrow("Create a new review");
    expect((await intentRepository.claim(after.review.id)).review.state).toBe("submitted");
  });

  it("a USDT row with no nonce holds the account, and a review with none waits", async () => {
    const from = "0x00000000000000000000000000000000000000aa";
    const [, next] = await put(usdt(from, { state: "unknown", evm: { ...evm(from, 0), nonce: undefined } } as unknown as Partial<PaymentReview>), usdt(from, { evm: evm(from, 5) }));
    await expect(intentRepository.claim(next.review.id)).rejects.toThrow("Create a new review");
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

describe("USDT payments back to back, through the coordinator and the saved intents", () => {
  const from = "0x00000000000000000000000000000000000000aa";
  const target = (): PaymentTarget => ({ method: "usdt", network: "evm-local", provider: "http://127.0.0.1:8545", asset: "TEST-USDT", unit: "token-base", address: "0x00000000000000000000000000000000000000bb", chainId: 31337, token: "0x00000000000000000000000000000000000000cc", decimals: 6, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  /** A chain whose account nonce moves when a transaction is sent, and whose payments take a while to confirm. */
  function chain() {
    const node = { pending: 4, sent: [] as number[], stopAfterSend: false };
    const adapter: PaymentAdapter<{ nonce: number }> = {
      method: "usdt",
      prepare: async () => ({ fee: 1, prepared: { nonce: node.pending }, evm: { from, nonce: node.pending, gasLimit: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "0", confirmations: 2 } }),
      execute: async (_review, prepared, persist) => {
        if (prepared.nonce !== node.pending) throw new PaymentPreflightError("Account nonce changed. Create a new review");
        await persist!();
        node.sent.push(prepared.nonce); node.pending++;
        if (node.stopAfterSend) throw new Error("the app stopped");
        return { txid: `0x${prepared.nonce}`, settled: false, pending: true };
      },
      reconcile: async (_review, prepared) => ({ txid: `0x${prepared.nonce}`, settled: false, pending: true }),
    };
    return { node, coordinator: new PaymentCoordinator(intentRepository, [adapter]) };
  }
  const pay = (c: PaymentCoordinator, n: number) => c.prepare(target(), n, 10, { payee: "bob", linkId: "bob" });

  beforeEach(async () => { await transact([STORES.intents], (s) => s[STORES.intents].clear()); });

  it("a second payment made while the first is unconfirmed is sent at the next nonce", async () => {
    const { node, coordinator } = chain();
    const first = await coordinator.approve((await pay(coordinator, 1_000_000)).id);
    expect(first.state).toBe("submitted");
    const second = await coordinator.approve((await pay(coordinator, 2_000_000)).id);
    expect(second.state).toBe("submitted");
    expect(node.sent).toEqual([4, 5]);
    await expect(coordinator.approve(first.id), "the first one again").rejects.toThrow("cannot be submitted again");
    expect(node.sent).toEqual([4, 5]);
  });

  it("a review made before the first payment went is refused, nothing is sent, and a new review goes", async () => {
    const { node, coordinator } = chain();
    const [a, b] = [await pay(coordinator, 1), await pay(coordinator, 2)];
    await coordinator.approve(a.id);
    await expect(coordinator.approve(b.id)).rejects.toThrow("A payment from this wallet was sent after this review was made. Create a new review");
    expect(node.sent).toEqual([4]);
    expect((await coordinator.approve((await pay(coordinator, 2)).id)).state).toBe("submitted");
    expect(node.sent).toEqual([4, 5]);
  });

  it("a payment whose outcome was not saved is never sent again, and the next payment still goes", async () => {
    const { node, coordinator } = chain();
    node.stopAfterSend = true;
    const lost = await coordinator.approve((await pay(coordinator, 1)).id);
    expect(lost.state).toBe("unknown");
    node.stopAfterSend = false;
    await expect(coordinator.approve(lost.id)).rejects.toThrow("cannot be submitted again");
    expect((await coordinator.approve((await pay(coordinator, 2)).id)).state).toBe("submitted");
    expect(node.sent).toEqual([4, 5]);
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

describe("the check that a recovery phrase is not stored (helpers/phraseLeaks)", () => {
  it("uses a valid phrase none of whose words is in the structure around a sealed secret", async () => {
    expect(validateMnemonic(TEST_PHRASE, wordlist)).toBe(true);
    const envelope = JSON.stringify({ format: "ghostly-bark-encrypted", version: 1, vault: await sealSeed(TEST_PHRASE, "correct horse battery") });
    const settings = JSON.stringify([{ providerId: "breez", config: {}, secrets: ["mnemonic", "apiKey"], sealed: { version: 1, salt: "c2FsdA", iv: "aXY" }, network: "regtest", main: "ghost", state: "ready" }]);
    for (const text of [envelope, settings, "ghostly-breez-regtest-0123456789abcdef", "ghostly-breez-mainnet-fedcba9876543210"]) expect(phraseLeaks(text)).toEqual([]);
  });

  it("finds the phrase in every shape it could be stored in", () => {
    const words = TEST_PHRASE.split(" ");
    const entropy = mnemonicToEntropy(TEST_PHRASE, wordlist), seed = mnemonicToSeedSync(TEST_PHRASE);
    expect(phraseLeaks(JSON.stringify({ mnemonic: TEST_PHRASE.toUpperCase() }))).toContain("the phrase");
    expect(phraseLeaks(JSON.stringify(words))).toContain("the phrase");
    expect(phraseLeaks(words.join("\n"))).toContain("the phrase");
    expect(phraseLeaks(`{"words":"${words[3]} ${words[4]}"}`)).toEqual(["words 4 and 5 in a row", "word 4", "word 5"]);
    expect(phraseLeaks(`{"last":"${words[11]}"}`)).toEqual(["word 12"]);
    expect(phraseLeaks(`{"hint":"${words[0]}s"}`), "a word inside a longer one is not that word").toEqual([]);
    expect(phraseLeaks(Buffer.from(entropy).toString("hex").toUpperCase())).toEqual(["the entropy as hex"]);
    expect(phraseLeaks(JSON.stringify({ entropy: [...entropy] }))).toContain("the entropy as a byte list");
    expect(phraseLeaks(JSON.stringify({ seed }))).toContain("the seed as a Uint8Array");
    expect(phraseLeaks(Buffer.from(seed).toString("base64"))).toContain("the seed as base64");
    expect(phraseLeaks(Buffer.from(seed).toString("base64url"))).toContain("the seed as base64url");
  });
});
