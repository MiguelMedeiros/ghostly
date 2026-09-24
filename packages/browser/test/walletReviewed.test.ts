import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, OutputData, getTokenMetadata, type Proof, type SwapPreview } from "@cashu/cashu-ts";
import type { PaymentReview } from "@ghostly/core";
import { CashuWallet, type CashuPrepared } from "../src/engine/wallet";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredPayment, StoredProof, WalletTx } from "../src/shared/types";
// covers: payments.chat.review, payments.cashu.send, payments.chat.reconcile

/**
 * The reviewed Cashu payment (prepare, approve, execute, recover) on real IndexedDB semantics: it reserves
 * its inputs in a raw transaction, which the in-memory fakes of fakes.ts do not model.
 */
const mintApi = vi.hoisted(() => ({ prepare: vi.fn(), completeSwap: vi.fn(), restore: vi.fn(), getKeys: vi.fn(), checkProofsStates: vi.fn() }));
vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cashu/cashu-ts")>()),
  Wallet: class {
    constructor(readonly url: string) {}
    async loadMint(): Promise<void> {}
    ops = { send: (amount: number, proofs: unknown[]) => ({ includeFees: (on: boolean) => ({ prepare: () => mintApi.prepare(amount, proofs, on) }) }) };
    completeSwap = (preview: unknown) => mintApi.completeSwap(preview);
    mint = { restore: (request: unknown) => mintApi.restore(request), getKeys: () => mintApi.getKeys() };
    checkProofsStates = (proofs: unknown) => mintApi.checkProofsStates(proofs);
  },
}));

const MINT = "https://mint.example";
const KEYSET = "009a1f293253e41e";
const C = `02${"ab".repeat(32)}`;
const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;
const stored = (amount: number, secret: string, over: Partial<StoredProof> = {}): StoredProof => ({ mint: MINT, id: KEYSET, amount, secret, C, ...over });
const all = async <T>(name: string) => wrap<T[]>((await store(name, "readonly")).getAll());

/** 64 sats in; 40 sent as 32 + 8; 16 kept; 8 of fees. */
function preview(over: Partial<SwapPreview> = {}): SwapPreview {
  return {
    amount: Amount.from(40), fees: Amount.from(8), keysetId: KEYSET, inputs: [proof(64, "a")],
    keepOutputs: [OutputData.createSingleRandomData(16, KEYSET)],
    sendOutputs: [OutputData.createSingleRandomData(32, KEYSET), OutputData.createSingleRandomData(8, KEYSET)],
    ...over,
  } as SwapPreview;
}
const review = (over: Partial<PaymentReview> = {}): PaymentReview => ({
  id: "r1", linkId: "l1", requestId: "ask-1", payee: "bob", method: "cashu", network: "bitcoin", provider: MINT, asset: "BTC", unit: "sat",
  address: "creqA", expiresAt: Date.now() + 60_000, amount: 40, fee: 8, feeCap: 20, createdAt: 1, state: "submitted", memo: "rent", ...over,
} as PaymentReview);

function setup() {
  const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };
  return { wallet: new CashuWallet(() => [MINT], events), events };
}
async function prepared(p = preview()) {
  mintApi.prepare.mockResolvedValue(p);
  return (await setup().wallet.prepareReviewedCashu(MINT, 40)).prepared;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  await transact([STORES.proofs, STORES.payments, STORES.walletTx], (s) => { s[STORES.proofs].clear(); s[STORES.payments].clear(); s[STORES.walletTx].clear(); });
  await transact([STORES.proofs], (s) => { s[STORES.proofs].put(stored(64, "a")); s[STORES.proofs].put(stored(8, "b")); s[STORES.proofs].put(stored(4, "r", { reserved: true })); });
});

describe("preparing a reviewed Cashu payment", () => {
  it("asks only a configured mint, with its spendable proofs, and shows every sat that leaves beyond the amount", async () => {
    const { wallet } = setup();
    await expect(wallet.prepareReviewedCashu("https://other.example", 40)).rejects.toThrow("Select a configured mint");
    await expect(wallet.prepareReviewedCashu(MINT, 0)).rejects.toThrow("Enter an amount");
    mintApi.prepare.mockResolvedValue(preview());
    const { fee, prepared: saved } = await wallet.prepareReviewedCashu(MINT, 40);
    expect(fee).toBe(8);
    expect(saved.mint).toBe(MINT);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    const [amount, proofs, includeFees] = mintApi.prepare.mock.calls[0];
    expect(amount).toBe(40);
    expect((proofs as StoredProof[]).map((p) => p.secret).sort()).toEqual(["a", "b"]);
    expect(includeFees).toBe(true);
    // Preparing moves nothing.
    expect((await all<StoredProof>(STORES.proofs)).filter((p) => p.reserved).map((p) => p.secret)).toEqual(["r"]);
  });

  it("refuses a preview whose numbers do not add up", async () => {
    mintApi.prepare.mockResolvedValue(preview({ keepOutputs: [OutputData.createSingleRandomData(32, KEYSET)] }));
    await expect(setup().wallet.prepareReviewedCashu(MINT, 40)).rejects.toThrow("Invalid Cashu prepared fee");
  });
});

describe("executing it after approval", () => {
  it("refuses to pay anything other than what was reviewed", async () => {
    const saved = await prepared();
    const { wallet } = setup();
    for (const changed of [{ amount: 41 }, { fee: 7 }, { provider: "https://other.example" }]) {
      await expect(wallet.executeReviewedCashu(review(changed), saved), JSON.stringify(changed)).rejects.toThrow("Cashu preview does not match review");
    }
    expect(mintApi.completeSwap).not.toHaveBeenCalled();
    expect((await all<StoredProof>(STORES.proofs)).find((p) => p.secret === "a")?.reserved).toBeUndefined();
  });

  it("never swaps inputs that changed since the review, and reserves none of them", async () => {
    const saved = await prepared(preview({ inputs: [proof(64, "a"), proof(8, "b")], keepOutputs: [OutputData.createSingleRandomData(24, KEYSET)] }));
    await transact([STORES.proofs], (s) => s[STORES.proofs].put(stored(8, "b", { reserved: true })));
    const { wallet } = setup();
    await expect(wallet.executeReviewedCashu(review(), saved)).rejects.toThrow("Prepared Cashu inputs are no longer available");
    expect(mintApi.completeSwap).not.toHaveBeenCalled();
    expect((await all<StoredProof>(STORES.proofs)).find((p) => p.secret === "a")?.reserved, "the transaction rolled back as a whole").toBeUndefined();

    await transact([STORES.proofs], (s) => { s[STORES.proofs].delete("b"); s[STORES.proofs].put(stored(64, "a", { C: `03${"cd".repeat(32)}` })); });
    await expect(wallet.executeReviewedCashu(review(), saved)).rejects.toThrow("no longer available");
    expect(mintApi.completeSwap).not.toHaveBeenCalled();
  });

  it("stores the token, the payment and the history in the transaction that spends the inputs", async () => {
    const saved = await prepared();
    mintApi.completeSwap.mockImplementation(async () => {
      // The inputs are reserved before the mint is asked: a crash here leaves them out of the balance.
      const a = (await all<StoredProof>(STORES.proofs)).find((p) => p.secret === "a");
      expect(a?.reserved).toBe(true);
      return { keep: [proof(16, "k")], send: [proof(32, "s1"), proof(8, "s2")] };
    });
    const { wallet, events } = setup();
    const token = await wallet.executeReviewedCashu(review(), saved);
    expect(getTokenMetadata(token)).toMatchObject({ mint: MINT, amount: Amount.from(40) });
    expect(saved.token).toBe(token);
    expect((await all<StoredProof>(STORES.proofs)).map((p) => p.secret).sort()).toEqual(["b", "k", "r"]);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "r1", linkId: "l1", direction: "out", amount: 40, state: "pending", mint: MINT, token, requestId: "ask-1", memo: "rent" }]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ id: "r1", kind: "ecash-out", amount: 40, fee: 8 }]);
    expect(events.onChange).toHaveBeenCalledOnce();
  });

  it("a swap with no answer keeps its inputs reserved and records no payment, so it can only be recovered", async () => {
    const saved = await prepared();
    mintApi.completeSwap.mockRejectedValue(new TypeError("Failed to fetch"));
    const { wallet } = setup();
    await expect(wallet.executeReviewedCashu(review(), saved)).rejects.toThrow("Failed to fetch");
    expect((await all<StoredProof>(STORES.proofs)).find((p) => p.secret === "a")?.reserved).toBe(true);
    expect(await all(STORES.payments)).toEqual([]);
    // Approving again does not swap the reserved inputs a second time.
    await expect(wallet.executeReviewedCashu(review(), saved)).rejects.toThrow("no longer available");
    expect(mintApi.completeSwap).toHaveBeenCalledOnce();
  });
});

describe("recovering a swap whose answer was lost", () => {
  /** Unblinding is the library's (and needs the mint's real keys): each output becomes the proof it stands for. */
  const unblindable = () => vi.spyOn(OutputData.prototype, "toProof").mockImplementation(function (this: OutputData) {
    return { id: KEYSET, amount: Amount.from(this.blindedMessage.amount), secret: new TextDecoder().decode(this.secret), C } as Proof;
  });
  const recovered = (saved: CashuPrepared, over: (s: { id: string; amount: string; C_: string }, i: number) => object = () => ({})) => {
    const outputs = [...(saved.swap.keepOutputs ?? []), ...(saved.swap.sendOutputs ?? [])].map((o) => ({ B_: o.blindedMessage.B_ }));
    return { outputs, signatures: outputs.map((_, i) => { const o = [...(saved.swap.keepOutputs ?? []), ...(saved.swap.sendOutputs ?? [])][i]; const s = { id: o.blindedMessage.id, amount: o.blindedMessage.amount, C_: C }; return { ...s, ...over(s, i) }; }) };
  };

  it("hands back a token already stored, without asking the mint", async () => {
    const saved = await prepared();
    await transact([STORES.payments], (s) => s[STORES.payments].put({ id: "r1", linkId: "l1", kind: "payment", direction: "out", amount: 40, unit: "sat", state: "pending", createdAt: 0, token: "cashuBstored" } satisfies StoredPayment));
    await expect(setup().wallet.recoverReviewedCashu(review(), saved)).resolves.toBe("cashuBstored");
    expect(mintApi.restore).not.toHaveBeenCalled();
  });

  it("an answer that does not cover every output recovers nothing, and writes nothing", async () => {
    const saved = await prepared();
    const partial = recovered(saved);
    mintApi.restore.mockResolvedValue({ outputs: partial.outputs.slice(1), signatures: partial.signatures.slice(1) });
    await expect(setup().wallet.recoverReviewedCashu(review(), saved)).resolves.toBeUndefined();
    expect(await all(STORES.payments)).toEqual([]);
  });

  it("refuses signatures that do not match the reviewed outputs", async () => {
    const saved = await prepared();
    unblindable();
    mintApi.getKeys.mockResolvedValue({ keysets: [{ id: KEYSET, unit: "sat", keys: {} }, { id: "00ffffffffffffff", unit: "sat", keys: {} }] });
    mintApi.restore.mockResolvedValue(recovered(saved, (_, i) => (i === 2 ? { amount: "16" } : {})));
    await expect(setup().wallet.recoverReviewedCashu(review(), saved)).rejects.toThrow("Mint restore does not match reviewed outputs");
    mintApi.restore.mockResolvedValue(recovered(saved, (_, i) => (i === 0 ? { id: "00ffffffffffffff" } : {})));
    await expect(setup().wallet.recoverReviewedCashu(review(), saved)).rejects.toThrow("Mint restore does not match reviewed outputs");
    expect(await all(STORES.payments)).toEqual([]);
  });

  it("rebuilds the exact outputs and books the payment once, as the lost answer would have", async () => {
    const saved = await prepared();
    mintApi.completeSwap.mockRejectedValue(new TypeError("Failed to fetch"));
    const { wallet } = setup();
    await expect(wallet.executeReviewedCashu(review(), saved)).rejects.toThrow();
    mintApi.getKeys.mockResolvedValue({ keysets: [{ id: KEYSET, unit: "sat", keys: {} }] });
    mintApi.restore.mockResolvedValue(recovered(saved));
    unblindable();
    const token = await wallet.recoverReviewedCashu(review(), saved);
    expect(Number(getTokenMetadata(token!).amount)).toBe(40);
    const proofs = await all<StoredProof>(STORES.proofs);
    expect(proofs.find((p) => p.secret === "a"), "the reserved input is spent").toBeUndefined();
    expect(proofs.filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0)).toBe(8 + 16);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "r1", token }]);
    // Asked again: the stored token, nothing restored twice.
    await expect(wallet.recoverReviewedCashu(review(), saved)).resolves.toBe(token);
    expect(mintApi.restore).toHaveBeenCalledOnce();
  });

  it("says the token was spent only when the mint says every sent proof is", async () => {
    const saved = await prepared();
    const { wallet } = setup();
    mintApi.checkProofsStates.mockResolvedValue([{ state: "SPENT" }, { state: "SPENT" }]);
    expect(await wallet.reviewedCashuSpent(saved)).toBe(true);
    mintApi.checkProofsStates.mockResolvedValue([{ state: "SPENT" }, { state: "UNSPENT" }]);
    expect(await wallet.reviewedCashuSpent(saved)).toBe(false);
    mintApi.checkProofsStates.mockResolvedValue([{ state: "SPENT" }]);
    expect(await wallet.reviewedCashuSpent(saved)).toBe(false);
    mintApi.checkProofsStates.mockResolvedValue([]);
    expect(await wallet.reviewedCashuSpent({ ...saved, swap: { ...saved.swap, sendOutputs: [] } })).toBe(false);
  });
});
