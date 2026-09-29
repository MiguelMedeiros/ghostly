import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, type Proof } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { TEST_MINT } from "../src/shared/mints";
import { faucetError } from "../src/engine/paymentAdapters/testCoins";
import type { StoredProof, StoredQuote, WalletTx } from "../src/shared/types";
import { mint, resetDb, rows, seed } from "./fakes";
// covers: wallet.testnet.receive-held, wallet.test-coins

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
vi.mock("@cashu/cashu-ts", async (importOriginal) => {
  const { FakeWallet } = await import("./fakes");
  return { ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), Wallet: FakeWallet };
});

/**
 * A test mint marks every invoice paid by itself (its Lightning is fake). Receive must not turn that into money: the
 * quote waits for a payer's word. Test coins come only from "Get test coins", asked for on purpose.
 */
const REAL_MINT = "https://mint.example";
const LOCAL_MINT = "http://127.0.0.1:3338";
const KEYSET = "009a1f293253e41e";
const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C: `02${"ab".repeat(32)}` }) as Proof;
const balance = () => rows<StoredProof>("proofs").reduce((sum, p) => sum + p.amount, 0);

function setup(mints: string[]) {
  const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };
  return { wallet: new CashuWallet(() => mints, events), events };
}

beforeEach(() => {
  resetDb();
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Receive on a test mint", () => {
  beforeEach(() => {
    mint.createMintQuoteBolt11.mockResolvedValue({ quote: "q1", request: "lnbc100n1test", expiry: Math.floor(Date.now() / 1000) + 600 });
    // The fake Lightning backend: every invoice reads paid at once, nobody paying it.
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
  });

  it("only makes the invoice: the mint's own PAID mints nothing and nobody is told it was paid", async () => {
    const { wallet, events } = setup([TEST_MINT]);
    const quote = await wallet.receiveLightning(100, "ask-1", "testnet");
    expect(quote).toMatchObject({ quote: "q1", invoice: "lnbc100n1test", held: true });
    await wallet.checkQuotes();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mint.checkMintQuoteBolt11).not.toHaveBeenCalled();
    expect(mint.mintProofsBolt11).not.toHaveBeenCalled();
    expect(events.onQuotePaid).not.toHaveBeenCalled();
    expect(balance()).toBe(0);
    expect(await wallet.isHeld("q1")).toBe(true);
    // Nothing left to poll: a held quote keeps no timer running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a mint on this machine is a test mint too", async () => {
    const { wallet } = setup([LOCAL_MINT]);
    expect(await wallet.receiveLightning(100, undefined, "testnet")).toMatchObject({ held: true });
  });

  it("a real mint's invoice is not held: its own answer decides, as always", async () => {
    const { wallet, events } = setup([REAL_MINT]);
    expect((await wallet.receiveLightning(100)).held).toBeUndefined();
    await wallet.checkQuotes();
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
    expect(balance()).toBe(100);
  });

  it("is minted once a payer says it paid that invoice, and the request is told", async () => {
    const { wallet, events } = setup([TEST_MINT]);
    await wallet.receiveLightning(100, "ask-1", "testnet");
    expect(await wallet.vouch("lnbc-someone-else")).toBe(false);
    expect(balance()).toBe(0);
    // Any case: a payer may send the invoice upper-cased.
    expect(await wallet.vouch("LNBC100N1TEST")).toBe(true);
    expect(mint.mintProofsBolt11).toHaveBeenCalledOnce();
    expect(events.onQuotePaid).toHaveBeenCalledWith(expect.objectContaining({ quote: "q1", paymentId: "ask-1" }));
    expect(balance()).toBe(100);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "lightning-in", amount: 100, note: "Request paid over Lightning" }]);
  });

  it("an expired held quote goes away, never minted", async () => {
    seed("quotes", [{ quote: "old", mint: TEST_MINT, amount: 100, invoice: "lnbcold", createdAt: 0, expiresAt: Date.now() - 120_000, held: true } satisfies StoredQuote]);
    const { wallet } = setup([TEST_MINT]);
    await wallet.checkQuotes();
    expect(rows("quotes")).toEqual([]);
    expect(mint.mintProofsBolt11).not.toHaveBeenCalled();
  });
});

describe("Get test coins", () => {
  beforeEach(() => {
    mint.createMintQuoteBolt11.mockResolvedValue({ quote: "f1", request: "lnbc10000test", expiry: Math.floor(Date.now() / 1000) + 600 });
    mint.mintProofsBolt11.mockResolvedValue([proof(8192, "a"), proof(1024, "b"), proof(512, "c"), proof(256, "d"), proof(16, "e")]);
  });

  it("asks the test mint for a fixed amount and mints it at once; it is no invoice anyone is told about", async () => {
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    const { wallet, events } = setup([REAL_MINT, TEST_MINT]);
    expect(await wallet.testCoins(10_000, "testnet")).toEqual({ mint: TEST_MINT, amount: 10_000 });
    expect(mint.createMintQuoteBolt11).toHaveBeenCalledWith(TEST_MINT, 10_000, "Ghostly test coins");
    expect(balance()).toBe(10_000);
    expect(rows<WalletTx>("walletTx")).toMatchObject([{ kind: "lightning-in", amount: 10_000, note: "Test coins from the test mint" }]);
    expect(rows("quotes")).toEqual([]);
    expect(events.onQuotePaid).not.toHaveBeenCalled();
    expect(events.onChange).toHaveBeenCalled();
  });

  it("never asks a real mint: without a test mint there is nothing to ask", async () => {
    const { wallet } = setup([REAL_MINT]);
    await expect(wallet.testCoins(10_000, "mainnet")).rejects.toThrow("no test mint");
    expect(mint.createMintQuoteBolt11).not.toHaveBeenCalled();
  });

  it("a mint slow to pay: says so after a while, and the coins still arrive with the regular poll", async () => {
    // The wait is counted on the clock: it moves with the timers here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "UNPAID" });
    const { wallet, events } = setup([TEST_MINT]);
    const asked = wallet.testCoins(10_000, "testnet");
    const failed = expect(asked).rejects.toThrow("has not paid its test coins yet");
    await vi.advanceTimersByTimeAsync(32_000);
    await failed;
    expect(balance()).toBe(0);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(balance()).toBe(10_000);
    expect(events.onQuotePaid).not.toHaveBeenCalled();
  });

  it("a mint that refuses says why", async () => {
    mint.createMintQuoteBolt11.mockRejectedValue(Object.assign(new Error("Too Many Requests"), { status: 429 }));
    const { wallet } = setup([TEST_MINT]);
    await expect(wallet.testCoins(10_000, "testnet")).rejects.toThrow("Too Many Requests");
  });
});

describe("a faucet's failure, in words", () => {
  it("rate limited says to wait", () => {
    expect(faucetError(Object.assign(new Error("HTTP error"), { status: 429 })).message).toBe("Rate limited: the faucet is busy. Try again in a minute.");
    expect(faucetError(new Error("429 Too Many Requests")).message).toMatch(/^Rate limited/);
    expect(faucetError(new Error("rate limit exceeded")).message).toMatch(/^Rate limited/);
  });

  it("a faucet that is down, or that refuses, says what happened", () => {
    expect(faucetError(new TypeError("Failed to fetch")).message).toBe("The faucet did not answer: Failed to fetch");
    expect(faucetError(new Error("insufficient funds for gas")).message).toBe("The faucet did not pay: insufficient funds for gas");
    expect(faucetError("nope").message).toBe("The faucet did not pay: nope");
  });
});
