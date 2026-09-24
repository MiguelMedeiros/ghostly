import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, MeltChangeError, MintOperationError, PaymentRequest, getEncodedToken, getTokenMetadata, type Proof } from "@cashu/cashu-ts";
import { CashuWallet, assertAmount, normalizeMintUrl } from "../src/engine/wallet";
import { TEST_MINT } from "../src/shared/mints";
import type { PendingMelt, StoredPayment, StoredProof, StoredQuote, WalletTx } from "../src/shared/types";
import { FakeWallet, failures, mint, resetDb, rows, seed as seedRows } from "./fakes";

/** What the scripted mint answers beyond `mint` in fakes.ts: its keys and info, and melt quotes. */
const extra = vi.hoisted(() => ({
  loadMint: vi.fn(async (_url: string) => {}),
  info: vi.fn((_url: string) => ({ name: "", version: "", motd: undefined as string | undefined, isSupported: (_nut: number) => ({ params: [] as unknown[] }) })),
  keysets: vi.fn((_url: string) => [] as { isActive: boolean; fee: number }[]),
  createMeltQuoteBolt11: vi.fn(),
}));

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
vi.mock("@cashu/cashu-ts", async (importOriginal) => {
  const { FakeWallet: Base } = await import("./fakes");
  class Wallet extends Base {
    async loadMint(): Promise<void> { await extra.loadMint(this.url); }
    getMintInfo = () => extra.info(this.url);
    keyChain = { getKeysets: () => extra.keysets(this.url) };
    createMeltQuoteBolt11 = (invoice: string) => extra.createMeltQuoteBolt11(this.url, invoice);
  }
  return { ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), Wallet };
});

const MINT = "https://mint.example";
const POOR = "https://poor.example";
const KEYSET = "009a1f293253e41e";
const C = `02${"ab".repeat(32)}`;

const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;
const stored = (amount: number, secret: string, at = MINT, reserved?: boolean): StoredProof => ({ mint: at, id: KEYSET, amount, secret, C, ...(reserved ? { reserved } : {}) });
const tokenFrom = (at: string, amounts: number[], unit = "sat") => getEncodedToken({ mint: at, unit, proofs: amounts.map((a, i) => proof(a, `t${i}-${a}`)) });
const balance = () => rows<StoredProof>("proofs").filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);
/** Typed rows into the in-memory stores. */
const seed = (name: string, values: object[]) => seedRows(name, values as Record<string, unknown>[]);
const secrets = () => rows<StoredProof>("proofs").map((p) => p.secret).sort();

function setup(mints: string[] = [MINT], known: string[] = mints) {
  const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(async (_mint: string) => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };
  const wallet = new CashuWallet(() => mints, events, () => known);
  return { wallet, events };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDb();
  vi.resetAllMocks();
  // Timers never fire by themselves: a poll's next round runs only when a test advances the clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("amounts and mint addresses", () => {
  it("accepts only a whole, positive number of sats up to the limit", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => assertAmount(bad), String(bad)).toThrow("Enter an amount in sats");
    expect(() => assertAmount(1_000_001)).toThrow("are not supported");
    expect(() => assertAmount(1)).not.toThrow();
    expect(() => assertAmount(1_000_000)).not.toThrow();
    seed("proofs", [stored(64, "a")]);
    await expect(setup().wallet.createToken(0)).rejects.toThrow("Enter an amount");
    await expect(setup().wallet.receiveLightning(2_000_000)).rejects.toThrow("not supported");
    expect(mint.send).not.toHaveBeenCalled();
    expect(mint.createMintQuoteBolt11).not.toHaveBeenCalled();
  });

  it("takes only https mints, or plain http on this very machine, and drops the trailing slash", () => {
    expect(normalizeMintUrl("  https://mint.example/Bitcoin//  ")).toBe("https://mint.example/Bitcoin");
    expect(normalizeMintUrl("http://localhost:3338/")).toBe("http://localhost:3338");
    expect(normalizeMintUrl("http://127.0.0.1:3338")).toBe("http://127.0.0.1:3338");
    expect(() => normalizeMintUrl("http://mint.example")).toThrow("Mints must use https");
    expect(() => normalizeMintUrl("ftp://localhost")).toThrow("Mints must use https");
    expect(() => normalizeMintUrl("mint dot example")).toThrow("not a valid mint URL");
  });
});

describe("checking a mint before it is added", () => {
  it("says which place did not answer, and asks it again next time instead of remembering the failure", async () => {
    extra.loadMint.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { wallet } = setup();
    const error = await wallet.checkMint("https://mint.example/").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Could not reach mint.example. Check the address: it should be a Cashu mint.");
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    await expect(wallet.checkMint(MINT)).resolves.toEqual({ url: MINT, name: "mint.example" });
    expect(extra.loadMint).toHaveBeenCalledTimes(2);
  });

  it("shows the mint's name, cheapest active fee and Lightning limits once it answered", async () => {
    extra.info.mockReturnValue({
      name: "Friendly Mint", version: "", motd: "   hello   ",
      isSupported: (nut: number) => ({ params: nut === 4 ? [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: null }, { method: "bolt11", unit: "usd", min_amount: 5 }] : [{ method: "bolt12", unit: "sat" }] }),
    });
    extra.keysets.mockReturnValue([{ isActive: true, fee: 2 }, { isActive: true, fee: 1 }, { isActive: false, fee: 0 }]);
    const { wallet, events } = setup();
    wallet.start();
    await vi.waitFor(() => expect(events.onChange).toHaveBeenCalled());
    const [shown] = (await wallet.view()).mints;
    expect(shown).toEqual({ url: MINT, name: "Friendly Mint", balance: 0, info: { version: undefined, motd: "hello", inputFeePpk: 1, receive: { min: 1, max: null }, send: null } });
  });

  it("a mint that is down at start stays nameless, and nothing breaks", async () => {
    extra.loadMint.mockRejectedValue(new Error("down"));
    const { wallet, events } = setup();
    wallet.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onChange).not.toHaveBeenCalled();
    expect((await wallet.view()).mints).toEqual([{ url: MINT, name: "mint.example", balance: 0, info: null }]);
  });
});

describe("the balance and history shown", () => {
  it("counts neither reserved proofs nor the other mode's mints, and shows the latest 100 records with every fee", async () => {
    seed("proofs", [stored(64, "a"), stored(32, "held", MINT, true), stored(500, "test", TEST_MINT)]);
    seed("walletTx", Array.from({ length: 120 }, (_, i) => ({ id: `tx${i}`, timestamp: i, mint: MINT, kind: "ecash-in", amount: 1, fee: 1 })));
    const { wallet } = setup([MINT], [MINT, TEST_MINT]);
    const view = await wallet.view();
    expect(view.balance).toBe(64);
    expect(view.mints.map((m) => m.url)).toEqual([MINT]);
    expect(view.history).toHaveLength(100);
    expect(view.history[0].timestamp).toBe(119);
    expect(view.feesPaid).toBe(120);
    // Kept, and counted where it belongs, but never spent from this mode.
    expect(await wallet.balanceAt(TEST_MINT)).toBe(500);
    await expect(wallet.createToken(100, [TEST_MINT])).rejects.toThrow("You share no mint with this contact");
  });
});

describe("ecash in", () => {
  it("refuses text that is not a sat token, before asking any mint", async () => {
    const { wallet } = setup();
    await expect(wallet.receiveToken("cashuBnotatoken")).rejects.toThrow("That is not a valid ecash token");
    await expect(wallet.receiveToken(tokenFrom(MINT, [8], "usd"))).rejects.toThrow("That is not a valid ecash token");
    expect(mint.receive).not.toHaveBeenCalled();
  });

  it("refuses ecash from a mint the user did not choose, and never adds that mint", async () => {
    const { wallet, events } = setup();
    await expect(wallet.receiveToken(tokenFrom("https://evil.example", [8]))).rejects.toThrow("Ecash from evil.example is not accepted");
    expect(events.onTestMintNeeded).not.toHaveBeenCalled();
    expect(mint.receive).not.toHaveBeenCalled();
  });

  it("test-mint ecash the user pastes adds the test mint; the same ecash in a contact's payment does not", async () => {
    const known = [MINT];
    const { wallet, events } = setup([MINT], known);
    events.onTestMintNeeded.mockImplementation(async (url) => void known.push(url));
    mint.receive.mockResolvedValue([proof(8, "fresh")]);

    await expect(wallet.receiveToken(tokenFrom(TEST_MINT, [8]), "ecash-in", undefined, { addTestMint: false })).rejects.toThrow("is not accepted");
    expect(events.onTestMintNeeded).not.toHaveBeenCalled();

    await expect(wallet.receiveToken(tokenFrom(`${TEST_MINT}/`, [8]))).resolves.toEqual({ amount: 8, mint: TEST_MINT });
    expect(events.onTestMintNeeded).toHaveBeenCalledWith(TEST_MINT);
    expect(rows<StoredProof>("proofs")).toMatchObject([{ mint: TEST_MINT, secret: "fresh" }]);
  });

  it("a token the mint says is spent credits nothing and records nothing", async () => {
    mint.receive.mockRejectedValue(new MintOperationError(11001, "Token already spent"));
    const payment = vi.fn();
    const { wallet, events } = setup();
    await expect(wallet.receiveToken(tokenFrom(MINT, [64]), "ecash-in", undefined, { payment })).rejects.toThrow("already spent");
    expect(payment).not.toHaveBeenCalled();
    expect(rows("proofs")).toEqual([]);
    expect(rows("walletTx")).toEqual([]);
    expect(events.onChange).not.toHaveBeenCalled();
  });

  it("credits what the mint gave, books the redeem fee, and stores the chat payment with the ecash", async () => {
    mint.receive.mockResolvedValue([proof(64, "x"), proof(32, "y")]);
    const payment = vi.fn((amount: number, at: string): StoredPayment => ({ id: "p1", linkId: "l1", kind: "payment", direction: "in", amount, unit: "sat", state: "settled", createdAt: 0, mint: at }));
    const { wallet } = setup();
    await expect(wallet.receiveToken(tokenFrom(MINT, [64, 32, 4]), "ecash-in", "x".repeat(200), { payment })).resolves.toEqual({ amount: 96, mint: MINT });
    expect(payment).toHaveBeenCalledWith(96, MINT);
    expect(rows<StoredPayment>("payments")).toMatchObject([{ id: "p1", amount: 96 }]);
    const [tx] = rows<WalletTx>("walletTx");
    expect(tx).toMatchObject({ kind: "ecash-in", amount: 96, fee: 4 });
    expect(tx.note).toHaveLength(140);
  });

  it("when the ecash cannot be stored, neither is the payment that says it arrived", async () => {
    mint.receive.mockResolvedValue([proof(8, "x")]);
    failures.nextTransact = true;
    const payment = vi.fn((amount: number, at: string): StoredPayment => ({ id: "p1", linkId: "l1", kind: "payment", direction: "in", amount, unit: "sat", state: "settled", createdAt: 0, mint: at }));
    await expect(setup().wallet.receiveToken(tokenFrom(MINT, [8]), "ecash-in", undefined, { payment })).rejects.toThrow("QuotaExceeded");
    expect(rows("payments")).toEqual([]);
    expect(rows("walletTx")).toEqual([]);
  });
});

describe("ecash out", () => {
  it("pays from the first preferred mint that holds enough, and books the fees beyond the amount", async () => {
    seed("proofs", [stored(8, "p", POOR), stored(64, "a")]);
    mint.send.mockResolvedValue({ keep: [proof(16, "k")], send: [proof(32, "s1"), proof(8, "s2"), proof(4, "s3")] });
    const { wallet, events } = setup([POOR, MINT]);
    const { token, mint: used } = await wallet.createToken(40, [`${POOR}/`, `${MINT}/`], "lunch");
    expect(used).toBe(MINT);
    expect(getTokenMetadata(token)).toMatchObject({ mint: MINT, amount: Amount.from(44) });
    expect(secrets()).toEqual(["k", "p"]);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "ecash-out", amount: 40, fee: 8, note: "lunch" }]);
    expect(events.onChange).toHaveBeenCalledOnce();
  });

  it("says why nothing could be sent: no shared mint, or not enough sats that are not reserved", async () => {
    seed("proofs", [stored(64, "a", MINT, true), stored(8, "b")]);
    const { wallet } = setup();
    await expect(wallet.createToken(10, ["https://theirs.example"])).rejects.toThrow("You share no mint with this contact");
    await expect(wallet.createToken(10)).rejects.toThrow("Not enough sats in your wallet");
    await expect(wallet.createToken(10, [MINT])).rejects.toThrow("Not enough sats in your wallet");
    expect(mint.send).not.toHaveBeenCalled();
  });

  it("two payments at once never hand the mint the same proofs", async () => {
    seed("proofs", [stored(64, "a")]);
    mint.send
      .mockResolvedValueOnce({ keep: [proof(32, "k1")], send: [proof(32, "s1")] })
      .mockResolvedValueOnce({ keep: [proof(16, "k2")], send: [proof(16, "s2")] });
    const { wallet } = setup();
    await Promise.all([wallet.createToken(32), wallet.createToken(16)]);
    const inputs = mint.send.mock.calls.map(([, proofs]) => (proofs as StoredProof[]).map((p) => p.secret));
    expect(inputs).toEqual([["a"], ["k1"]]);
    expect(secrets()).toEqual(["k2"]);
  });
});

describe("Lightning in", () => {
  const paidQuote = (): StoredQuote => ({ quote: "q1", mint: MINT, amount: 100, invoice: "lnbc100", createdAt: 0, expiresAt: Date.now() + 600_000, paymentId: "ask-1" });

  it("with no mint there is nowhere to create an invoice", async () => {
    await expect(setup([]).wallet.receiveLightning(10)).rejects.toThrow("No mint could create an invoice: No mint configured");
  });

  it("keeps the invoice with its expiry and the request it answers", async () => {
    mint.createMintQuoteBolt11.mockResolvedValue({ quote: "q1", request: "lnbc100", expiry: 1_900_000_000 });
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "UNPAID" });
    const quote = await setup().wallet.receiveLightning(100, "ask-1");
    expect(quote).toMatchObject({ quote: "q1", mint: MINT, invoice: "lnbc100", expiresAt: 1_900_000_000_000, paymentId: "ask-1" });
    expect(rows<StoredQuote>("quotes")).toMatchObject([{ quote: "q1", paymentId: "ask-1" }]);
  });

  it("mints a paid invoice once, even when two rounds ask at the same time", async () => {
    seed("quotes", [paidQuote()]);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
    const { wallet, events } = setup();
    await Promise.all([wallet.checkQuotes(), wallet.checkQuotes()]);
    expect(mint.mintProofsBolt11).toHaveBeenCalledOnce();
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
    expect(events.onQuotePaid).toHaveBeenCalledWith(expect.objectContaining({ quote: "q1", paymentId: "ask-1" }));
    expect(balance()).toBe(100);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "lightning-in", amount: 100, fee: 0, note: "Request paid over Lightning" }]);
  });

  it("asks again every few seconds only while an invoice is open", async () => {
    seed("quotes", [paidQuote()]);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "UNPAID" });
    const { wallet, events } = setup();
    await wallet.checkQuotes();
    expect(vi.getTimerCount()).toBe(1);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(await wallet.mintQuoteState(MINT, "q1")).toBe("PAID");
  });
});

describe("Lightning out", () => {
  const meltQuote = (state: string, extra: object = {}) => ({ quote: "m1", request: "lnbc90", amount: Amount.from(90), fee_reserve: Amount.from(10), unit: "sat", state, expiry: 0, ...extra });
  const unspent = [{ state: "UNSPENT" }, { state: "UNSPENT" }, { state: "UNSPENT" }];

  beforeEach(() => {
    // 108 sats; paying 90 + 10 reserve hands 64 + 32 + 4 to the mint and keeps 8.
    seed("proofs", [stored(64, "a"), stored(32, "b"), stored(8, "c"), stored(4, "d")]);
    mint.send.mockResolvedValue({ keep: [proof(8, "c")], send: [proof(64, "a"), proof(32, "b"), proof(4, "d")] });
  });

  it("quotes from the first mint that can afford the invoice, and says why when none can", async () => {
    extra.createMeltQuoteBolt11.mockImplementation(async () => meltQuote("UNPAID"));
    seed("proofs", [stored(8, "p", POOR)]);
    await expect(setup([POOR, MINT]).wallet.quoteInvoice("  lnbc90  ")).resolves.toEqual({ quote: "m1", mint: MINT, amount: 90, feeReserve: 10 });
    expect(extra.createMeltQuoteBolt11).toHaveBeenCalledWith(POOR, "lnbc90");
    await expect(setup([POOR]).wallet.quoteInvoice("lnbc90")).rejects.toThrow("Not enough sats in your wallet");
    await expect(setup([]).wallet.quoteInvoice("lnbc90")).rejects.toThrow("Add a mint in Settings first");
    extra.createMeltQuoteBolt11.mockRejectedValue("invoice expired");
    await expect(setup().wallet.quoteInvoice("lnbc90")).rejects.toThrow("invoice expired");
  });

  it("writes the payment down before the mint sees the proofs: a record that cannot be written never reaches the mint", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    failures.nextTransact = true;
    const { wallet, events } = setup();
    await expect(wallet.payQuote("m1", MINT)).rejects.toThrow("QuotaExceeded");
    expect(mint.completeMelt).not.toHaveBeenCalled();
    expect(rows("melts")).toEqual([]);
    expect(events.onChange).toHaveBeenCalled();
  });

  it("a payment that could not be prepared gives back everything the swap returned", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    vi.spyOn(FakeWallet.prototype, "prepareMelt").mockRejectedValueOnce(new Error("keyset gone"));
    await expect(setup().wallet.payQuote("m1", MINT)).rejects.toThrow("keyset gone");
    expect(mint.completeMelt).not.toHaveBeenCalled();
    expect(rows("melts")).toEqual([]);
    expect(balance()).toBe(108);
  });

  it("refuses the same invoice under another quote while the first payment is in flight", async () => {
    seed("melts", [{ quote: "earlier", mint: MINT, request: "lnbc90", amount: 90, secrets: [], outlay: 100, outputs: [], createdAt: 0 } satisfies PendingMelt]);
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    await expect(setup().wallet.payQuote("m1", MINT)).rejects.toThrow("This invoice is already being paid");
    expect(mint.send).not.toHaveBeenCalled();
  });

  it("a paid payment keeps the change the route did not cost, and books only the real fee", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PAID"), change: [proof(4, "change")] });
    const { wallet } = setup();
    expect(await wallet.payQuote("m1", MINT, "coffee")).toBe(true);
    expect(secrets()).toEqual(["c", "change"]);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "lightning-out", amount: 90, fee: 6, note: "coffee" }]);
    expect(rows("melts")).toEqual([]);
  });

  it("a payment settled later unblinds its change, on a keyset the wallet fetches first", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PENDING"), change: [] });
    const { wallet, events } = setup();
    expect(await wallet.payQuote("m1", MINT)).toBe(false);

    const ensure = vi.spyOn(FakeWallet.prototype, "ensureOperableKeysets");
    vi.spyOn(FakeWallet.prototype, "createMeltChangeProofs").mockReturnValue([proof(4, "change")]);
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PAID", { change: [{ id: "00newkeyset00001", amount: 4, C_: C }, { id: "00zero0000000001", amount: 0, C_: C }] }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(ensure).toHaveBeenCalledWith(["00newkeyset00001"]);
    expect(secrets()).toEqual(["c", "change"]);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ fee: 6 }]);
    expect(events.onMeltResolved).toHaveBeenCalledWith(expect.objectContaining({ quote: "m1" }), true);
  });

  it("change that cannot be unblinded does not undo a payment that went through", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PENDING"), change: [] });
    const { wallet, events } = setup();
    await wallet.payQuote("m1", MINT);
    vi.spyOn(FakeWallet.prototype, "createMeltChangeProofs").mockImplementation(() => { throw new Error("bad signature"); });
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PAID", { change: [{ id: KEYSET, amount: 4, C_: C }] }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.onMeltResolved).toHaveBeenCalledWith(expect.anything(), true);
    expect(secrets()).toEqual(["c"]);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ fee: 10 }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be unblinded"), expect.any(Error));
  });

  it("an unpaid payment whose proofs are partly spent gives back only the unspent ones", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PENDING"), change: [] });
    const { wallet, events } = setup();
    await wallet.payQuote("m1", MINT);
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.checkProofsStates.mockResolvedValue([{ state: "SPENT" }, { state: "UNSPENT" }, { state: "UNSPENT" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(secrets()).toEqual(["b", "c", "d"]);
    expect(balance()).toBe(44);
    expect(events.onMeltResolved).toHaveBeenCalledWith(expect.anything(), false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 of its proofs are spent"));
  });

  it("a refusal the mint cannot be asked about afterwards stays pending: never reported failed, never re-paid", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValueOnce(meltQuote("UNPAID")).mockRejectedValue(new TypeError("Failed to fetch"));
    mint.completeMelt.mockRejectedValue(new MintOperationError(20000, "lightning backend error"));
    const { wallet, events } = setup();
    expect(await wallet.payQuote("m1", MINT)).toBe(false);
    expect(rows<PendingMelt>("melts")).toMatchObject([{ quote: "m1" }]);
    expect(balance()).toBe(8);

    // Every round while the mint is away changes nothing and pays nothing.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mint.completeMelt).toHaveBeenCalledOnce();
    expect(rows("melts")).toHaveLength(1);
    expect(events.onMeltResolved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a change error means the mint took the proofs: its word decides, and a paid quote is paid", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValueOnce(meltQuote("UNPAID")).mockResolvedValue(meltQuote("PAID"));
    mint.completeMelt.mockRejectedValue(new MeltChangeError([], meltQuote("PAID") as never));
    expect(await setup().wallet.payQuote("m1", MINT)).toBe(true);
    expect(secrets()).toEqual(["c"]);
  });

  it("a melt the mint answers as unpaid gives the sats back and says so", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("UNPAID"), change: [] });
    mint.checkProofsStates.mockResolvedValue(unspent);
    const { wallet } = setup();
    await expect(wallet.payQuote("m1", MINT)).rejects.toThrow("The Lightning payment did not go through. The sats are back in your wallet.");
    expect(balance()).toBe(108);
    expect(rows("melts")).toEqual([]);
    expect(await wallet.meltQuoteState(MINT, "m1")).toBe("UNPAID");
  });
});

describe("reading ecash and backing it up", () => {
  it("reads tokens and payment requests without contacting a mint", () => {
    const { wallet } = setup([MINT], [MINT]);
    expect(wallet.inspect(` ${tokenFrom(`${MINT}/`, [8, 2])} `)).toMatchObject({ kind: "token", amount: 10, unit: "sat", mint: MINT, accepted: true });
    expect(wallet.inspect(tokenFrom("https://evil.example", [8]))).toMatchObject({ accepted: false });
    expect(wallet.inspect(tokenFrom(TEST_MINT, [8]))).toMatchObject({ accepted: true });
    const request = new PaymentRequest(undefined, "r1", 21, "sat", [MINT], "for pizza").toEncodedCreqA();
    expect(wallet.inspect(request)).toEqual({ kind: "request", amount: 21, unit: "sat", mints: [MINT], description: "for pizza" });
    expect(wallet.inspect(new PaymentRequest(undefined, "r2").toEncodedCreqA())).toEqual({ kind: "request", amount: null, unit: "sat", mints: [], description: undefined });
    expect(wallet.inspect("cashuBgarbage")).toBeNull();
    expect(wallet.inspect("hello")).toBeNull();
    expect(mint.receive).not.toHaveBeenCalled();
  });

  it("exports one token per mint with every spendable proof, leaving reserved ones out", async () => {
    seed("proofs", [stored(64, "a"), stored(8, "b"), stored(32, "held", MINT, true), stored(16, "p", POOR, true)]);
    const exported = await setup().wallet.exportTokens();
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ mint: MINT, amount: 72 });
    expect(Number(getTokenMetadata(exported[0].token).amount)).toBe(72);
  });
});
