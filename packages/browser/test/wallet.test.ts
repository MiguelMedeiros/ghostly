import { beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, MintOperationError, type Proof } from "@cashu/cashu-ts";
import { CashuWallet, MINT_TIMEOUT_MS } from "../src/engine/wallet";
import type { PendingMelt, StoredPayment, StoredProof, StoredQuote, WalletTx } from "../src/shared/types";
import { bech32 } from "@scure/base";
import { failures, mint, resetDb, rows, seed } from "./fakes";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { BITCOIN_INVOICE_ON_TESTNET, TEST_MINT, declareTestMints, fakesLightning } from "../src/shared/mints";
// covers: wallet.cashu.receive-lightning, wallet.cashu.pay-invoice, payments.cashu.send

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cashu/cashu-ts")>()),
  Wallet: (await import("./fakes")).FakeWallet,
}));

const MINT = "https://mint.example";
const KEYSET = "009a1f293253e41e";
const C = `02${"ab".repeat(32)}`;

const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;
const stored = (amount: number, secret: string): StoredProof => ({ mint: MINT, id: KEYSET, amount, secret, C });

function setup() {
  const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };
  const wallet = new CashuWallet(() => [MINT], events);
  return { wallet, events };
}

const balance = () => rows<StoredProof>("proofs").filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Lightning in: mint quotes", () => {
  const quote = (over: Partial<StoredQuote> = {}): StoredQuote => ({
    quote: "q1",
    mint: MINT,
    amount: 100,
    invoice: "lnbc1",
    createdAt: 0,
    expiresAt: Date.now() - 10 * 60_000,
    ...over,
  });

  it("mints an invoice that was paid after it expired, instead of dropping it", async () => {
    seed("quotes", [quote()]);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
    const { wallet, events } = setup();

    await wallet["pollQuotes"]();

    expect(balance()).toBe(100);
    expect(rows("quotes")).toHaveLength(0);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "lightning-in", amount: 100, fee: 0 }]);
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
  });

  it("drops an expired quote only once the mint says it is unpaid", async () => {
    seed("quotes", [quote(), quote({ quote: "fresh", expiresAt: Date.now() + 60_000 })]);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "UNPAID" });
    await setup().wallet["pollQuotes"]();
    expect(rows<StoredQuote>("quotes").map((q) => q.quote)).toEqual(["fresh"]);
  });

  it("keeps an expired quote when the mint cannot be asked", async () => {
    seed("quotes", [quote()]);
    mint.checkMintQuoteBolt11.mockRejectedValue(new Error("offline"));
    await setup().wallet["pollQuotes"]();
    expect(rows("quotes")).toHaveLength(1);
  });

  it("keeps an issued quote the wallet holds no ecash for, and stops asking about it", async () => {
    seed("quotes", [quote()]);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "ISSUED" });
    const { wallet } = setup();
    await wallet["pollQuotes"]();
    await wallet["pollQuotes"]();
    expect(rows<StoredQuote>("quotes")).toMatchObject([{ quote: "q1", issuedUnclaimed: true }]);
    expect(mint.checkMintQuoteBolt11).toHaveBeenCalledOnce();
  });

  it("keeps the quote when the ecash could not be stored", async () => {
    seed("quotes", [quote()]);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a")]);
    failures.nextTransact = true;
    await setup().wallet["pollQuotes"]();
    expect(rows("quotes")).toHaveLength(1);
    expect(balance()).toBe(0);
  });
});

describe("Lightning in: which mint issues the invoice", () => {
  it("skips a mint that does not answer, and the next one issues the invoice", async () => {
    vi.useFakeTimers();
    try {
      mint.createMintQuoteBolt11.mockImplementation((url: string) => url === "https://down.example" ? new Promise(() => {}) : Promise.resolve({ quote: "q", request: "lnbc100", expiry: null }));
      const wallet = new CashuWallet(() => ["https://down.example", MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() });
      const receiving = wallet.receiveLightning(100);
      await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS + 1);
      await expect(receiving).resolves.toMatchObject({ mint: MINT, invoice: "lnbc100" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says which mint failed when none answers", async () => {
    vi.useFakeTimers();
    try {
      mint.createMintQuoteBolt11.mockImplementation(() => new Promise(() => {}));
      const { wallet } = setup();
      const receiving = wallet.receiveLightning(100);
      const settled = expect(receiving).rejects.toThrow("No mint could create an invoice: mint.example did not answer");
      await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS + 1);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Lightning out: melts", () => {
  const meltQuote = (state: string, change?: unknown[]) => ({
    quote: "m1",
    request: "lnbc90",
    amount: Amount.from(90),
    fee_reserve: Amount.from(10),
    unit: "sat",
    state,
    expiry: 0,
    change,
  });

  beforeEach(() => {
    // 108 sats; paying 90 + 10 reserve hands 64 + 32 + 4 to the mint and keeps 8.
    seed("proofs", [stored(64, "a"), stored(32, "b"), stored(8, "c"), stored(4, "d")]);
    mint.send.mockResolvedValue({ keep: [proof(8, "c")], send: [proof(64, "a"), proof(32, "b"), proof(4, "d")] });
  });

  it("reserves the proofs of a pending payment, then drops them once the mint pays it", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PENDING"), change: [], outputData: [] });
    const { wallet, events } = setup();

    expect(await wallet.payQuote("m1", MINT)).toBe(false);
    expect(balance()).toBe(8);
    expect(rows<StoredProof>("proofs").filter((p) => p.reserved)).toHaveLength(3);
    expect(rows<PendingMelt>("melts")).toMatchObject([{ quote: "m1", amount: 90, outlay: 100, secrets: ["a", "b", "d"] }]);

    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PAID", []));
    await wallet["pollMelts"]();

    expect(rows<StoredProof>("proofs").map((p) => p.secret)).toEqual(["c"]);
    expect(rows("melts")).toHaveLength(0);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "lightning-out", amount: 90, fee: 10 }]);
    expect(events.onMeltResolved).toHaveBeenCalledWith(expect.objectContaining({ quote: "m1" }), true);
  });

  it("gives the proofs of a pending payment back when it fails and the mint says they are unspent", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PENDING"), change: [], outputData: [] });
    const { wallet, events } = setup();
    await wallet.payQuote("m1", MINT);

    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.checkProofsStates.mockResolvedValue([{ state: "UNSPENT" }, { state: "UNSPENT" }, { state: "UNSPENT" }]);
    await wallet["pollMelts"]();

    expect(balance()).toBe(108);
    expect(rows("melts")).toHaveLength(0);
    expect(events.onMeltResolved).toHaveBeenCalledWith(expect.objectContaining({ quote: "m1" }), false);
  });

  it("keeps the proofs reserved while the mint still has them pending", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("UNPAID"), change: [], outputData: [] });
    mint.checkProofsStates.mockResolvedValue([{ state: "PENDING" }, { state: "UNSPENT" }, { state: "UNSPENT" }]);
    const { wallet } = setup();
    // The melt came back UNPAID, but the quote itself still reads PENDING.
    expect(await wallet.payQuote("m1", MINT)).toBe(false);
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    await wallet["pollMelts"]();
    expect(balance()).toBe(8);
    expect(rows("melts")).toHaveLength(1);
  });

  it("does not put spent proofs back when the mint took them and then errored", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValueOnce(meltQuote("UNPAID")).mockResolvedValue(meltQuote("PAID", []));
    mint.completeMelt.mockRejectedValue(new MintOperationError(10000, "lightning backend hiccup"));
    const { wallet } = setup();

    expect(await wallet.payQuote("m1", MINT)).toBe(true);
    expect(rows<StoredProof>("proofs").map((p) => p.secret)).toEqual(["c"]);
    expect(rows("melts")).toHaveLength(0);
  });

  it("treats a dropped connection as pending, not as failed", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.completeMelt.mockRejectedValue(new TypeError("Failed to fetch"));
    const { wallet } = setup();

    expect(await wallet.payQuote("m1", MINT)).toBe(false);
    expect(balance()).toBe(8);
    expect(rows("melts")).toHaveLength(1);
  });

  it("gives the sats back and says so when the mint refuses the payment", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.completeMelt.mockRejectedValue(new MintOperationError(20005, "Invoice already paid"));
    mint.checkProofsStates.mockResolvedValue([{ state: "UNSPENT" }, { state: "UNSPENT" }, { state: "UNSPENT" }]);
    const { wallet } = setup();

    await expect(wallet.payQuote("m1", MINT)).rejects.toThrow(/already paid/);
    expect(balance()).toBe(108);
    expect(rows("melts")).toHaveLength(0);
  });

  it("books the fee the split before a refused payment cost, and says it", async () => {
    // The split to exact proofs cost the mint's input fee (1 sat): 108 in, 8 kept and 99 to send. The mint then refuses
    // the melt (a test mint says "Invoice already paid" to an invoice it made itself): 107 come back, 1 is gone for good.
    mint.send.mockResolvedValue({ keep: [proof(8, "c")], send: [proof(64, "a2"), proof(32, "b2"), proof(3, "e")] });
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.completeMelt.mockRejectedValue(new MintOperationError(20005, "Invoice already paid"));
    mint.checkProofsStates.mockResolvedValue([{ state: "UNSPENT" }, { state: "UNSPENT" }, { state: "UNSPENT" }]);
    const { wallet } = setup();

    await expect(wallet.payQuote("m1", MINT)).rejects.toThrow("Invoice already paid The sats are back in your wallet, less 1 sat the mint kept as its fee.");
    expect(balance()).toBe(107);
    expect(rows("melts")).toHaveLength(0);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "fee", amount: 0, fee: 1, mint: MINT }]);
  });

  it("books the fee of a pending payment that ends unpaid, found by the poll", async () => {
    mint.send.mockResolvedValue({ keep: [proof(8, "c")], send: [proof(64, "a2"), proof(32, "b2"), proof(2, "e")] });
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PENDING"), change: [], outputData: [] });
    const { wallet, events } = setup();
    expect(await wallet.payQuote("m1", MINT)).toBe(false);

    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("UNPAID"));
    mint.checkProofsStates.mockResolvedValue([{ state: "UNSPENT" }, { state: "UNSPENT" }, { state: "UNSPENT" }]);
    await wallet["pollMelts"]();

    expect(balance()).toBe(106);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "fee", amount: 0, fee: 2 }]);
    expect(events.onMeltResolved).toHaveBeenCalledWith(expect.objectContaining({ quote: "m1" }), false);
  });

  it("refuses to pay an invoice that is already in flight", async () => {
    mint.checkMeltQuoteBolt11.mockResolvedValue(meltQuote("PENDING"));
    mint.completeMelt.mockResolvedValue({ quote: meltQuote("PENDING"), change: [], outputData: [] });
    const { wallet } = setup();
    await wallet.payQuote("m1", MINT);
    await expect(wallet.payQuote("m1", MINT)).rejects.toThrow(/already being paid/);
  });
});

describe("ecash out", () => {
  const payment = (token: string, mintUrl: string): StoredPayment => ({
    id: "p1",
    linkId: "l1",
    kind: "payment",
    direction: "out",
    amount: 40,
    unit: "sat",
    state: "pending",
    createdAt: 0,
    mint: mintUrl,
    token,
  });

  beforeEach(() => {
    seed("proofs", [stored(64, "a"), stored(8, "c")]);
    mint.send.mockResolvedValue({ keep: [proof(16, "k1"), proof(8, "k2")], send: [proof(32, "s1"), proof(8, "s2")] });
  });

  it("stores the token in the same transaction that spends the inputs", async () => {
    const { wallet } = setup();
    const { token } = await wallet.createToken(40, undefined, undefined, payment);
    expect(rows<StoredPayment>("payments")).toMatchObject([{ id: "p1", token }]);
    expect(rows<StoredProof>("proofs").map((p) => p.secret).sort()).toEqual(["k1", "k2"]);
  });

  it("records nothing as sent when the token could not be stored", async () => {
    failures.nextTransact = true;
    const { wallet } = setup();
    await expect(wallet.createToken(40, undefined, undefined, payment)).rejects.toThrow();
    expect(rows("payments")).toHaveLength(0);
    expect(rows<StoredProof>("proofs").map((p) => p.secret).sort()).toEqual(["a", "c"]);
  });
});

describe("Lightning out on Testnet: a Bitcoin invoice may be real money", () => {
  const LOCAL = "http://127.0.0.1:3338";
  // Decodable invoices of each chain (checksummed, blank signature: nobody can pay them).
  const invoice = (prefix: "lnbc" | "lntb" | "lnbcrt") => {
    const regtest = fakeInvoice(25, new Uint8Array(32).fill(7));
    const { words } = bech32.decode(regtest as `${string}1${string}`, false);
    return bech32.encode(`${prefix}250n`, words, false);
  };
  const quoted = { quote: "m1", amount: Amount.from(25), fee_reserve: Amount.from(2), unit: "sat", state: "UNPAID", expiry: 0, request: "" };
  const testnet = (mints: string[]) => {
    seed("proofs", [MINT, ...mints].map((url, i) => ({ ...stored(64, `p${i}`), mint: url })));
    mint.createMeltQuoteBolt11.mockResolvedValue(quoted);
    const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };
    return new CashuWallet((network) => network === "testnet" ? mints : [MINT], events, () => [MINT, ...mints]);
  };

  it("a mint on this machine never pays one with test sats: it may be a real mint", async () => {
    const wallet = testnet([LOCAL]);
    await expect(wallet.quoteInvoice(invoice("lnbc"), "testnet")).rejects.toThrow(BITCOIN_INVOICE_ON_TESTNET);
    expect(mint.createMeltQuoteBolt11).not.toHaveBeenCalled();
    // A test chain's invoice is test money: the local mint pays it.
    for (const prefix of ["lntb", "lnbcrt"] as const) await expect(wallet.quoteInvoice(invoice(prefix), "testnet")).resolves.toMatchObject({ mint: LOCAL, amount: 25 });
  });

  it("the public test mint pays one (its Lightning is fake), and Mainnet pays one as before", async () => {
    const wallet = testnet([LOCAL, TEST_MINT]);
    await expect(wallet.quoteInvoice(invoice("lnbc"), "testnet")).resolves.toMatchObject({ mint: TEST_MINT });
    expect(mint.createMeltQuoteBolt11.mock.calls.map(([url]) => url)).toEqual([TEST_MINT]);
    await expect(wallet.quoteInvoice(invoice("lnbc"), "mainnet")).resolves.toMatchObject({ mint: MINT });
  });

  it("a local mint the operator declared a test server pays one; declaring a remote mint does nothing", async () => {
    declareTestMints([`${LOCAL}/`, "https://mint.example"]);
    const wallet = testnet([LOCAL]);
    await expect(wallet.quoteInvoice(invoice("lnbc"), "testnet")).resolves.toMatchObject({ mint: LOCAL });
    expect(fakesLightning("https://mint.example")).toBe(false);
  });
});

describe("ecash of one network", () => {
  const LOCAL = "http://127.0.0.1:3338";
  const payment = (token: string, mintUrl: string): StoredPayment => ({ id: "p1", linkId: "l", kind: "payment", direction: "out", amount: 40, unit: "sat", state: "pending", createdAt: 0, mint: mintUrl, token });
  // A real mint and a local test mint, both known and both funded.
  const both = () => {
    seed("proofs", [stored(64, "real"), { ...stored(64, "test"), mint: LOCAL }]);
    mint.send.mockResolvedValue({ keep: [proof(24, "k1")], send: [proof(32, "s1"), proof(8, "s2")] });
    const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };
    return new CashuWallet((network) => network === "testnet" ? [LOCAL] : [MINT], events, () => [MINT, LOCAL]);
  };

  it("a request naming a real mint on Testnet spends only test ecash, and never real ecash for it", async () => {
    const wallet = both();
    // The real mint first, as a contact may list it: Testnet still pays from the test mint only.
    expect((await wallet.createToken(40, [MINT, LOCAL], undefined, payment, "testnet")).mint).toBe(LOCAL);
    expect(rows<StoredProof>("proofs").map((p) => p.secret)).toContain("real");
  });

  it("with only mints of the other network, nothing is spent", async () => {
    const wallet = both();
    await expect(wallet.createToken(40, [MINT], undefined, payment, "testnet")).rejects.toThrow("You share no mint");
    await expect(wallet.createToken(40, [LOCAL], undefined, payment, "mainnet")).rejects.toThrow("You share no mint");
    expect(rows<StoredProof>("proofs").map((p) => p.secret).sort()).toEqual(["real", "test"]);
    expect(rows("payments")).toHaveLength(0);
  });
});
