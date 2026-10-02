import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, MintOperationError, OutputData, getEncodedToken, getTokenMetadata, type Proof, type SerializedSwapPreview, type SwapPreview } from "@cashu/cashu-ts";
import { CashuWallet, SwapUnsettledError } from "../src/engine/wallet";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { PendingMelt, PendingSwap, StoredPayment, StoredProof, StoredQuote, WalletTx } from "../src/shared/types";
// covers: wallet.cashu.receive-token, wallet.cashu.receive-lightning, payments.cashu.send, wallet.cashu.pay-invoice, payments.chat.reconcile

/**
 * Every swap the wallet makes at a mint is written down before the mint is asked, and finished from what was written
 * down when the answer does not arrive: on the spot, after a restart, or not at all when the mint never made it.
 * On real IndexedDB semantics, with the mint scripted call by call.
 */
const mintApi = vi.hoisted(() => ({
  sendOffline: vi.fn(), prepareSend: vi.fn(), prepareReceive: vi.fn(), completeSwap: vi.fn(), restore: vi.fn(), getKeys: vi.fn(), checkProofsStates: vi.fn(),
  checkMeltQuoteBolt11: vi.fn(), prepareMelt: vi.fn(), completeMelt: vi.fn(),
  checkMintQuoteBolt11: vi.fn(), prepareMint: vi.fn(), completeMint: vi.fn(),
}));
vi.mock("@cashu/cashu-ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@cashu/cashu-ts")>();
  return {
    ...real,
    Wallet: class {
      constructor(readonly url: string) {}
      async loadMint(): Promise<void> {}
      sendOffline = (...args: unknown[]) => mintApi.sendOffline(...args);
      getFeesForProofs = () => real.Amount.zero();
      prepareSwapToSend = (...args: unknown[]) => mintApi.prepareSend(...args);
      prepareSwapToReceive = (...args: unknown[]) => mintApi.prepareReceive(...args);
      completeSwap = (preview: unknown) => mintApi.completeSwap(preview);
      mint = { restore: (request: unknown) => mintApi.restore(request), getKeys: () => mintApi.getKeys() };
      checkProofsStates = (proofs: unknown) => mintApi.checkProofsStates(proofs);
      checkMeltQuoteBolt11 = (quote: unknown) => mintApi.checkMeltQuoteBolt11(quote);
      prepareMelt = (...args: unknown[]) => mintApi.prepareMelt(...args);
      completeMelt = (preview: unknown) => mintApi.completeMelt(preview);
      checkMintQuoteBolt11 = (quote: unknown) => mintApi.checkMintQuoteBolt11(quote);
      prepareMint = (...args: unknown[]) => mintApi.prepareMint(...args);
      completeMint = (preview: unknown) => mintApi.completeMint(preview);
    },
  };
});

const MINT = "https://mint.example";
const KEYSET = "009a1f293253e41e";
const C = `02${"ab".repeat(32)}`;
/** As long as a request the wallet gave up on may still reach the mint (SWAP_SETTLED_MS), and a round more. */
const SETTLED_MS = 120_000 + 30_000;
const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;
const stored = (amount: number, secret: string, over: Partial<StoredProof> = {}): StoredProof => ({ mint: MINT, id: KEYSET, amount, secret, C, ...over });
const all = async <T>(name: string) => wrap<T[]>((await store(name, "readonly")).getAll());
const proofs = () => all<StoredProof>(STORES.proofs);
const swaps = () => all<PendingSwap>(STORES.swaps);
const balance = async () => (await proofs()).filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);
const outputs = (...amounts: number[]) => amounts.map((amount) => OutputData.createSingleRandomData(amount, KEYSET));

/** The wallet holds 64 + 8. Sending 40: the 64 goes in, 32 + 8 come out to send, 16 comes back, 8 is the mint's fee. */
const sendPreview = (): SwapPreview => ({ amount: Amount.from(40), fees: Amount.from(8), keysetId: KEYSET, inputs: [proof(64, "a")], keepOutputs: outputs(16), sendOutputs: outputs(32, 8) }) as SwapPreview;
const sendAnswer = () => ({ keep: [proof(16, "k")], send: [proof(32, "s1"), proof(8, "s2")] });
/** A token of 64 redeemed: 62 come in, 2 are the mint's fee. */
const TOKEN = getEncodedToken({ mint: MINT, unit: "sat", proofs: [proof(64, "t1")] });
const receivePreview = (): SwapPreview => ({ amount: Amount.from(62), fees: Amount.from(2), keysetId: KEYSET, inputs: [proof(64, "t1")], keepOutputs: outputs(32, 16, 8, 4, 2) }) as SwapPreview;
const receiveAnswer = () => ({ keep: [proof(32, "r1"), proof(16, "r2"), proof(8, "r3"), proof(4, "r4"), proof(2, "r5")], send: [] });
const incoming = (amount: number, mint: string): StoredPayment => ({ id: "p1", linkId: "l1", kind: "payment", direction: "in", amount, unit: "sat", state: "settled", createdAt: 9, mint });

/** The mint's NUT-09 answer for a written-down swap: it signed every output of it. */
const signed = (swap: PendingSwap) => {
  const saved = swap.swap as SerializedSwapPreview;
  const made = [...(saved.keepOutputs ?? []), ...(saved.sendOutputs ?? [])];
  return { outputs: made.map((o) => ({ B_: o.blindedMessage.B_ })), signatures: made.map((o) => ({ id: o.blindedMessage.id, amount: o.blindedMessage.amount, C_: C })) };
};
const UNSIGNED = { outputs: [], signatures: [] };
/** Unblinding is the library's (and needs the mint's real keys): each output becomes the proof it stands for. */
const unblindable = () => vi.spyOn(OutputData.prototype, "toProof").mockImplementation(function (this: OutputData) {
  return { id: KEYSET, amount: Amount.from(this.blindedMessage.amount), secret: new TextDecoder().decode(this.secret), C } as Proof;
});
const lost = () => new TypeError("Failed to fetch");
/** The database works on real turns of the event loop, which the fake clock does not make: let what is queued finish. */
const idle = async () => { for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve)); };
/** Time passes, a round of the wallet at a time, each with the database work it starts. */
async function pass(ms: number) {
  await idle();
  for (let left = ms; left > 0; left -= 30_000) { await vi.advanceTimersByTimeAsync(Math.min(left, 30_000)); await idle(); }
}

function setup() {
  const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() };
  return { wallet: new CashuWallet(() => [MINT], events), events };
}
/** The app opened again: a wallet that knows nothing but what is stored. */
async function reopened() {
  const next = setup();
  next.wallet.start();
  await pass(0);
  return next;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  await transact([STORES.proofs], (s) => { s[STORES.proofs].put(stored(64, "a")); s[STORES.proofs].put(stored(8, "b")); });
  mintApi.sendOffline.mockImplementation(() => { throw new Error("No exact coins"); });
  mintApi.prepareSend.mockImplementation(async () => sendPreview());
  mintApi.prepareReceive.mockImplementation(async () => receivePreview());
  mintApi.getKeys.mockResolvedValue({ keysets: [{ id: KEYSET, unit: "sat", keys: {} }] });
  mintApi.restore.mockResolvedValue(UNSIGNED);
  unblindable();
});
afterEach(() => { vi.useRealTimers(); });

describe("redeeming a token", () => {
  it("is written down, with its history line and its payment, before the mint is asked", async () => {
    mintApi.completeSwap.mockImplementation(async (preview: SwapPreview) => {
      const [swap] = await swaps();
      expect(swap).toMatchObject({ mint: MINT, kind: "receive", token: TOKEN, tx: { kind: "ecash-in", amount: 62, fee: 2, note: "rent" }, payment: { id: "p1", amount: 62, state: "settled" } });
      // What is sent is what was saved: the mint signs these outputs and no others.
      expect(preview.keepOutputs?.map((o) => o.blindedMessage.B_)).toEqual((swap.swap as SerializedSwapPreview).keepOutputs?.map((o) => o.blindedMessage.B_));
      return receiveAnswer();
    });
    const { wallet, events } = setup();
    await expect(wallet.receiveToken(TOKEN, "ecash-in", "rent", { payment: incoming })).resolves.toEqual({ amount: 62, mint: MINT });
    expect(await balance()).toBe(72 + 62);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "ecash-in", amount: 62, fee: 2 }]);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "p1", amount: 62 }]);
    expect(await swaps(), "stored and deleted in one transaction").toEqual([]);
    expect(events.onSwapSettled, "the caller has its answer").not.toHaveBeenCalled();
  });

  it("an answer that never arrives is asked for again on the spot, and the ecash is in the wallet", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockImplementation(async () => signed((await swaps())[0]));
    const { wallet } = setup();
    await expect(wallet.receiveToken(TOKEN, "ecash-in", undefined, { payment: incoming })).resolves.toEqual({ amount: 62, mint: MINT });
    expect(await balance()).toBe(72 + 62);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "p1", amount: 62, state: "settled" }]);
    expect(await all<WalletTx>(STORES.walletTx)).toHaveLength(1);
    expect(await swaps()).toEqual([]);
  });

  it("with a mint that cannot be asked it stays written down, and the next start brings the ecash and its payment, once", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockRejectedValue(lost());
    const first = setup();
    const failure = await first.wallet.receiveToken(TOKEN, "ecash-in", "rent", { payment: incoming }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(SwapUnsettledError);
    expect((failure as Error).message, "never read as a spent token").not.toMatch(/spent/i);
    expect(await balance()).toBe(72);
    expect(await all(STORES.payments)).toEqual([]);
    const [kept] = await swaps();
    expect(kept.attemptEndedAt).toBeTypeOf("number");

    // The mint had made the swap. The app opens again and asks.
    mintApi.restore.mockImplementation(async () => signed(kept));
    const { events } = await reopened();
    await vi.waitFor(() => expect(events.onSwapSettled).toHaveBeenCalledOnce());
    expect(events.onSwapSettled.mock.calls[0]).toMatchObject([{ id: kept.id, payment: { id: "p1" } }, true]);
    expect(await balance()).toBe(72 + 62);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "p1", amount: 62, state: "settled" }]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "ecash-in", amount: 62, fee: 2, note: "rent" }]);
    expect(await swaps()).toEqual([]);
    expect(mintApi.completeSwap, "asked, never swapped again").toHaveBeenCalledOnce();

    // And again: nothing is left to finish, so nothing is credited twice.
    const again = await reopened();
    await pass(SETTLED_MS);
    expect(again.events.onSwapSettled).not.toHaveBeenCalled();
    expect(await balance()).toBe(72 + 62);
    expect(await all<WalletTx>(STORES.walletTx)).toHaveLength(1);
  });

  it("the app closed while the mint was being asked: the next start finishes the redeem", async () => {
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => { asked = resolve; });
    mintApi.completeSwap.mockImplementation(() => { asked(); return new Promise(() => {}); });
    void setup().wallet.receiveToken(TOKEN, "ecash-in", undefined, { payment: incoming }).catch(() => {});
    await reached;
    const [kept] = await swaps();
    expect(kept.attemptEndedAt).toBeUndefined();

    mintApi.restore.mockResolvedValue(signed(kept));
    const { events } = await reopened();
    await vi.waitFor(() => expect(events.onSwapSettled).toHaveBeenCalledWith(expect.objectContaining({ id: kept.id }), true));
    expect(await balance()).toBe(72 + 62);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "p1" }]);
  });

  it("redeeming the same token again finishes the swap that is written down, and makes no other", async () => {
    mintApi.completeSwap.mockRejectedValueOnce(lost());
    mintApi.restore.mockRejectedValue(lost());
    const { wallet } = setup();
    await expect(wallet.receiveToken(TOKEN)).rejects.toBeInstanceOf(SwapUnsettledError);
    const [kept] = await swaps();

    // The second try reaches a mint that already made the swap: it refuses the inputs, and has the signatures.
    mintApi.completeSwap.mockRejectedValueOnce(new MintOperationError(11001, "Token already spent"));
    mintApi.restore.mockResolvedValue(signed(kept));
    await expect(wallet.receiveToken(TOKEN)).resolves.toEqual({ amount: 62, mint: MINT });
    expect(mintApi.prepareReceive, "one set of outputs for one token").toHaveBeenCalledOnce();
    const sent = mintApi.completeSwap.mock.calls.map(([preview]) => (preview as SwapPreview).keepOutputs?.map((o) => o.blindedMessage.B_));
    expect(sent[1]).toEqual(sent[0]);
    expect(await balance()).toBe(72 + 62);
    expect(await swaps()).toEqual([]);
  });

  it("a token someone else spent is refused as it always was, and nothing stays written down", async () => {
    mintApi.completeSwap.mockRejectedValue(new MintOperationError(11001, "Token already spent"));
    mintApi.checkProofsStates.mockResolvedValue([{ state: "SPENT" }]);
    const { wallet } = setup();
    await expect(wallet.receiveToken(TOKEN, "reclaimed")).rejects.toThrow("Token already spent");
    expect(mintApi.restore, "the mint is asked first whether it signed this wallet's outputs").toHaveBeenCalled();
    expect(await balance()).toBe(72);
    expect(await swaps()).toEqual([]);
  });

  it("a redeem the mint never made is dropped only once no request of it can still arrive", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.checkProofsStates.mockResolvedValue([{ state: "UNSPENT" }]);
    const { wallet, events } = setup();
    await expect(wallet.receiveToken(TOKEN, "ecash-in", undefined, { payment: incoming })).rejects.toBeInstanceOf(SwapUnsettledError);
    expect(await swaps(), "unspent and unsigned now says nothing about a request still on its way").toHaveLength(1);
    await pass(60_000);
    expect(await swaps()).toHaveLength(1);
    await pass(SETTLED_MS);
    expect(await swaps()).toEqual([]);
    expect(events.onSwapSettled).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ id: "p1" }) }), false);
    expect(await balance()).toBe(72);
    expect(await all(STORES.payments)).toEqual([]);
  });

  it("a mint that holds the token pending is asked again, and one without NUT-09 gives nothing back", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockRejectedValue(new MintOperationError(0, "Not supported"));
    mintApi.checkProofsStates.mockResolvedValue([{ state: "PENDING" }]);
    const { wallet, events } = setup();
    await expect(wallet.receiveToken(TOKEN)).rejects.toBeInstanceOf(SwapUnsettledError);
    await pass(SETTLED_MS);
    expect(await swaps(), "pending is no answer").toHaveLength(1);
    mintApi.checkProofsStates.mockResolvedValue([{ state: "SPENT" }]);
    await pass(30_000);
    expect(await swaps()).toEqual([]);
    expect(events.onSwapSettled).toHaveBeenCalledWith(expect.anything(), false);
    expect(await balance()).toBe(72);
  });
});

describe("splitting ecash for a token", () => {
  const outbox = (token: string, mint: string): StoredPayment => ({ id: "out1", linkId: "l1", kind: "payment", direction: "out", amount: 40, unit: "sat", state: "pending", createdAt: 1, mint, token });

  it("reserves its inputs and writes the swap down in one transaction, before the mint is asked", async () => {
    mintApi.completeSwap.mockImplementation(async () => {
      expect(await swaps()).toMatchObject([{ mint: MINT, kind: "send" }]);
      expect((await proofs()).find((p) => p.secret === "a")?.reserved).toBe(true);
      expect(await balance(), "only the inputs of the swap are held").toBe(8);
      return sendAnswer();
    });
    const { wallet } = setup();
    const { token } = await wallet.createToken(40, undefined, "lunch", outbox);
    expect(Number(getTokenMetadata(token).amount)).toBe(40);
    expect((await proofs()).map((p) => p.secret).sort()).toEqual(["b", "k"]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "ecash-out", amount: 40, fee: 8, note: "lunch" }]);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "out1", token }]);
    expect(await swaps()).toEqual([]);
  });

  it("coins that add up exactly go out as they are: no mint, nothing to write down", async () => {
    await transact([STORES.proofs], (s) => { s[STORES.proofs].put(stored(32, "c")); });
    mintApi.sendOffline.mockReturnValue({ keep: [proof(64, "a")], send: [proof(32, "c"), proof(8, "b")] });
    const { wallet } = setup();
    const { token } = await wallet.createToken(40, undefined, undefined, outbox);
    expect(Number(getTokenMetadata(token).amount)).toBe(40);
    expect(mintApi.prepareSend).not.toHaveBeenCalled();
    expect(mintApi.completeSwap).not.toHaveBeenCalled();
    expect((await proofs()).map((p) => p.secret)).toEqual(["a"]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "ecash-out", amount: 40, fee: 0 }]);
  });

  it("an answer that never arrives is asked for again on the spot, and the token goes out as if it had", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockImplementation(async () => signed((await swaps())[0]));
    const { wallet } = setup();
    const { token } = await wallet.createToken(40, undefined, undefined, outbox);
    expect(Number(getTokenMetadata(token).amount)).toBe(40);
    expect(await balance()).toBe(8 + 16);
    expect((await proofs()).some((p) => p.secret === "a"), "the spent input is gone").toBe(false);
    expect(await all<StoredPayment>(STORES.payments)).toMatchObject([{ id: "out1", token }]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "ecash-out", amount: 40, fee: 8 }]);
    expect(await swaps()).toEqual([]);
  });

  it("with a mint that cannot be asked the inputs stay held, and the next start brings back everything the swap made", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockRejectedValue(lost());
    const first = setup();
    await expect(first.wallet.createToken(40, undefined, undefined, outbox)).rejects.toBeInstanceOf(SwapUnsettledError);
    expect(await balance(), "held, so no other payment picks them").toBe(8);
    expect(await all(STORES.payments)).toEqual([]);
    expect(await all(STORES.walletTx)).toEqual([]);
    const [kept] = await swaps();

    mintApi.restore.mockImplementation(async () => signed(kept));
    const { events } = await reopened();
    await vi.waitFor(() => expect(events.onSwapSettled).toHaveBeenCalledWith(expect.objectContaining({ id: kept.id }), true));
    const now = await proofs();
    expect(now.some((p) => p.secret === "a"), "the spent input is gone").toBe(false);
    expect(now.every((p) => !p.reserved)).toBe(true);
    // The payment was never made: what would have been sent is the wallet's too. Only the mint's fee left.
    expect(await balance()).toBe(72 - 8);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ id: kept.id, kind: "fee", amount: 0, fee: 8 }]);
    expect(await all(STORES.payments)).toEqual([]);
    expect(await swaps()).toEqual([]);

    await reopened();
    await pass(SETTLED_MS);
    expect(await balance(), "stored once").toBe(72 - 8);
  });

  it("the app closed while the mint was being asked: the next start settles it either way", async () => {
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => { asked = resolve; });
    mintApi.completeSwap.mockImplementation(() => { asked(); return new Promise(() => {}); });
    void setup().wallet.createToken(40).catch(() => {});
    await reached;
    expect(await balance()).toBe(8);

    // The mint never saw it: unspent, unsigned. Its inputs are free once no request can still arrive.
    mintApi.checkProofsStates.mockResolvedValue([{ state: "UNSPENT" }]);
    const { events } = await reopened();
    expect(await balance(), "not yet").toBe(8);
    await pass(SETTLED_MS);
    expect(events.onSwapSettled).toHaveBeenCalledWith(expect.anything(), false);
    expect(await balance()).toBe(72);
    expect((await proofs()).every((p) => !p.reserved)).toBe(true);
    expect(await all(STORES.walletTx)).toEqual([]);
    expect(await swaps()).toEqual([]);
  });

  it("a swap the mint refuses frees its inputs at once, less any the mint reads spent", async () => {
    mintApi.prepareSend.mockImplementation(async () => ({ ...sendPreview(), inputs: [proof(64, "a"), proof(8, "b")] }));
    mintApi.completeSwap.mockRejectedValue(new MintOperationError(11001, "Token already spent"));
    mintApi.checkProofsStates.mockResolvedValue([{ state: "UNSPENT" }, { state: "SPENT" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wallet } = setup();
    await expect(wallet.createToken(40)).rejects.toThrow("Token already spent");
    expect(await proofs(), "the spent proof no longer counts, the other is free").toEqual([stored(64, "a")]);
    expect(await swaps()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("one mint's swaps wait for each other: a second payment never picks held inputs", async () => {
    let release!: (answer: unknown) => void;
    mintApi.completeSwap.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { wallet } = setup();
    const first = wallet.createToken(40);
    const second = wallet.createToken(4).catch((e: Error) => e);
    await vi.waitFor(() => expect(mintApi.completeSwap).toHaveBeenCalledOnce());
    expect(mintApi.prepareSend, "the second waits for the mint's lock").toHaveBeenCalledOnce();
    release(sendAnswer());
    await first;
    await second;
    const offered = mintApi.prepareSend.mock.calls[1][1] as StoredProof[];
    expect(offered.map((p) => p.secret).sort()).toEqual(["b", "k"]);
  });
});

describe("splitting ecash for a Lightning payment", () => {
  beforeEach(() => {
    mintApi.checkMeltQuoteBolt11.mockResolvedValue({ quote: "q1", request: "lnbc1", amount: Amount.from(38), fee_reserve: Amount.from(2), state: "UNPAID" });
    mintApi.prepareMelt.mockImplementation(async (method: string, quote: unknown, inputs: unknown[]) => ({ method, inputs, outputData: [], keysetId: KEYSET, quote }));
  });

  it("the split is finished in the transaction that writes the payment down", async () => {
    mintApi.completeSwap.mockResolvedValue(sendAnswer());
    mintApi.completeMelt.mockImplementation(async () => {
      expect(await swaps(), "the split is over before the mint sees the payment").toEqual([]);
      expect(await all<PendingMelt>(STORES.melts)).toMatchObject([{ quote: "q1", secrets: ["s1", "s2"], outlay: 48 }]);
      return { quote: { state: "PAID" }, change: [] };
    });
    const { wallet } = setup();
    await expect(wallet.payQuote("q1", MINT)).resolves.toBe(true);
    expect((await proofs()).map((p) => p.secret).sort()).toEqual(["b", "k"]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "lightning-out", amount: 38, fee: 10 }]);
  });

  it("a split whose answer never arrives is recovered at the next start: nothing was paid, and the sats are in the wallet", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockRejectedValue(lost());
    const first = setup();
    await expect(first.wallet.payQuote("q1", MINT)).rejects.toBeInstanceOf(SwapUnsettledError);
    expect(mintApi.completeMelt).not.toHaveBeenCalled();
    expect(await all(STORES.melts)).toEqual([]);
    expect(await balance()).toBe(8);
    const [kept] = await swaps();

    mintApi.restore.mockImplementation(async () => signed(kept));
    const { events } = await reopened();
    await vi.waitFor(() => expect(events.onSwapSettled).toHaveBeenCalledWith(expect.objectContaining({ id: kept.id }), true));
    expect(await balance()).toBe(72 - 8);
    expect((await proofs()).some((p) => p.secret === "a")).toBe(false);
    expect(await swaps()).toEqual([]);
  });

  it("a split asked for again on the spot lets the payment go on", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockImplementation(async () => signed((await swaps())[0]));
    mintApi.completeMelt.mockResolvedValue({ quote: { state: "PAID" }, change: [] });
    const { wallet } = setup();
    await expect(wallet.payQuote("q1", MINT)).resolves.toBe(true);
    expect(await balance()).toBe(8 + 16);
    expect(await swaps()).toEqual([]);
    expect(await all(STORES.melts)).toEqual([]);
  });
});

describe("the ecash of a paid invoice", () => {
  const quote: StoredQuote = { quote: "q1", mint: MINT, amount: 40, invoice: "lnbc400n1", createdAt: 1, expiresAt: null };
  const quotes = () => all<StoredQuote>(STORES.quotes);
  const sentOutputs = () => mintApi.completeMint.mock.calls.map(([preview]) => (preview as { outputData: OutputData[] }).outputData.map((o) => o.blindedMessage.B_));
  /** The mint's NUT-09 answer for the outputs written down with a quote. */
  const issuedFor = (saved: StoredQuote) => {
    const made = saved.outputs as { blindedMessage: { B_: string; id: string; amount: string } }[];
    return { outputs: made.map((o) => ({ B_: o.blindedMessage.B_ })), signatures: made.map((o) => ({ id: o.blindedMessage.id, amount: o.blindedMessage.amount, C_: C })) };
  };
  beforeEach(async () => {
    await transact([STORES.quotes], (s) => { s[STORES.quotes].put(quote); });
    mintApi.checkMintQuoteBolt11.mockResolvedValue({ quote: "q1", state: "PAID" });
    mintApi.prepareMint.mockImplementation(async (method: string, _amount: number, of: unknown) => ({ method, payload: { quote: "q1", outputs: [] }, outputData: outputs(32, 8), keysetId: KEYSET, quote: of }));
  });

  it("is asked for with outputs that are written down first", async () => {
    mintApi.completeMint.mockImplementation(async (preview: { outputData: OutputData[] }) => {
      const [saved] = await quotes();
      expect(saved.paid).toBe(true);
      expect((saved.outputs as { blindedMessage: { B_: string } }[]).map((o) => o.blindedMessage.B_)).toEqual(preview.outputData.map((o) => o.blindedMessage.B_));
      return [proof(32, "m1"), proof(8, "m2")];
    });
    const { wallet, events } = setup();
    await wallet.checkQuotes();
    expect(await balance()).toBe(72 + 40);
    expect(await quotes()).toEqual([]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "lightning-in", amount: 40, fee: 0 }]);
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
  });

  it("issued with no answer: the next round asks for the signatures of the outputs it wrote down", async () => {
    mintApi.completeMint.mockRejectedValue(lost());
    const { wallet, events } = setup();
    await wallet.checkQuotes([MINT]);
    expect(await balance()).toBe(72);
    const [saved] = await quotes();
    expect(saved.outputs).toHaveLength(2);

    mintApi.checkMintQuoteBolt11.mockResolvedValue({ quote: "q1", state: "ISSUED" });
    mintApi.restore.mockResolvedValue(issuedFor(saved));
    await wallet.checkQuotes([MINT]);
    expect(await balance()).toBe(72 + 40);
    expect(await quotes()).toEqual([]);
    expect(await all<WalletTx>(STORES.walletTx)).toMatchObject([{ kind: "lightning-in", amount: 40 }]);
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
    expect(mintApi.completeMint, "never minted a second time").toHaveBeenCalledOnce();
  });

  it("still only paid: the same outputs are sent again, so whichever request the mint acts on issues the same ecash", async () => {
    mintApi.completeMint.mockRejectedValueOnce(lost());
    mintApi.completeMint.mockResolvedValueOnce([proof(32, "m1"), proof(8, "m2")]);
    const { wallet } = setup();
    await wallet.checkQuotes([MINT]);
    await wallet.checkQuotes([MINT]);
    const sent = sentOutputs();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(await balance()).toBe(72 + 40);
  });

  it("outputs the mint refuses while the invoice is still only paid are replaced on the next round", async () => {
    mintApi.completeMint.mockRejectedValueOnce(lost());
    mintApi.completeMint.mockRejectedValueOnce(new MintOperationError(12002, "Keyset is inactive"));
    mintApi.completeMint.mockResolvedValueOnce([proof(32, "m1"), proof(8, "m2")]);
    const { wallet } = setup();
    await wallet.checkQuotes([MINT]);
    await wallet.checkQuotes([MINT]);
    expect((await quotes())[0], "kept as paid, with no outputs").toMatchObject({ paid: true });
    expect((await quotes())[0].outputs).toBeUndefined();
    await wallet.checkQuotes([MINT]);
    const sent = sentOutputs();
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2]).not.toEqual(sent[0]);
    expect(await balance()).toBe(72 + 40);
  });

  it("issued, and the mint has no signatures to give back: the quote is kept as the trace of it, as before", async () => {
    mintApi.completeMint.mockRejectedValue(lost());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wallet } = setup();
    await wallet.checkQuotes([MINT]);
    mintApi.checkMintQuoteBolt11.mockResolvedValue({ quote: "q1", state: "ISSUED" });
    await wallet.checkQuotes([MINT]);
    expect(await quotes()).toMatchObject([{ quote: "q1", issuedUnclaimed: true }]);
    expect(await balance()).toBe(72);
    expect(warn).toHaveBeenCalled();
  });
});

describe("removing a wallet", () => {
  it("asks its mints once more about a swap still written down, then lets it go with the rest", async () => {
    mintApi.completeSwap.mockRejectedValue(lost());
    mintApi.restore.mockRejectedValue(lost());
    const { wallet } = setup();
    await expect(wallet.receiveToken(TOKEN)).rejects.toBeInstanceOf(SwapUnsettledError);
    const asked = mintApi.restore.mock.calls.length;
    await wallet.forget([MINT]);
    expect(mintApi.restore.mock.calls.length).toBeGreaterThan(asked);
    expect(await swaps()).toEqual([]);
    expect(await proofs()).toEqual([]);
  });
});
