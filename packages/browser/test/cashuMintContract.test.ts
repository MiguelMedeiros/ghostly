import { describe, expect, it, vi } from "vitest";
import { decodeBolt11 } from "@ghostly/core";
import type { CashuWallet } from "../src/engine/wallet";
import { CashuMintLightning, cashuMint } from "../src/engine/paymentAdapters/providers/cashuMint";
import { describeLightningProvider } from "../src/engine/paymentAdapters/providers/contractSuite";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { isNothingSpentError } from "../src/engine/paymentAdapters/providers/types";
// covers: wallet.lightning.provider-contract, wallet.lightning.cashu-mint.receive, wallet.lightning.cashu-mint.pay

/**
 * The Cashu mints as a Lightning source run the same contract as every other provider, against a scripted
 * wallet: mint quotes are invoices that turn PAID when someone pays them, melts are paid from a balance.
 */

const MINT = "https://mint.example";
const hash = () => crypto.getRandomValues(new Uint8Array(32));

/** Only what CashuMintLightning uses of the Cashu wallet. */
class FakeCashu {
  balance = 1_000;
  readonly mintQuotes = new Map<string, "UNPAID" | "PAID" | "ISSUED">();
  readonly meltQuotes = new Map<string, { invoice: string; amount: number; state: "UNPAID" | "PENDING" | "PAID" }>();
  /** Melts the mint takes but has not finished: `payQuote` answers false. */
  pendingMelts = false;
  feeReserve = 2;
  private n = 0;
  view = vi.fn(async () => ({ balance: this.balance }));
  receiveLightning = vi.fn(async (amount: number) => {
    const quote = `mq${++this.n}`;
    this.mintQuotes.set(quote, "UNPAID");
    return { quote, mint: MINT, amount, invoice: fakeInvoice(amount, hash()), createdAt: Date.now(), expiresAt: Date.now() + 600_000 };
  });
  mintQuoteState = vi.fn(async (_mint: string, quote: string) => this.mintQuotes.get(quote) ?? "UNPAID");
  isHeld = vi.fn(async () => false);
  quoteInvoice = vi.fn(async (invoice: string) => {
    const amount = decodeBolt11(invoice)?.amountSat;
    if (!amount) throw new Error("Not an invoice");
    if (amount + this.feeReserve > this.balance) throw new Error("Not enough sats in your wallet");
    const quote = `melt${++this.n}`;
    this.meltQuotes.set(quote, { invoice, amount, state: "UNPAID" });
    return { quote, mint: MINT, amount, feeReserve: this.feeReserve };
  });
  payQuote = vi.fn(async (quote: string) => {
    const melt = this.meltQuotes.get(quote);
    if (!melt) throw new Error("Unknown quote");
    this.balance -= melt.amount;
    melt.state = this.pendingMelts ? "PENDING" : "PAID";
    return !this.pendingMelts;
  });
  meltQuoteState = vi.fn(async (_mint: string, quote: string) => this.meltQuotes.get(quote)?.state ?? "UNPAID");
  /** Someone paid one of our mint quotes' invoices. */
  paid(ref: string | undefined) { this.mintQuotes.set(JSON.parse(ref!).quote, "PAID"); }
}

const provider = (cashu = new FakeCashu(), mode: "mainnet" | "testnet" = "testnet") => ({ cashu, provider: new CashuMintLightning(cashu as unknown as CashuWallet, mode) });

describeLightningProvider("Cashu mints", async () => {
  const { cashu, provider: p } = provider();
  return {
    provider: p,
    network: "testnet",
    descriptor: cashuMint,
    payIncoming: async (invoice) => cashu.paid(invoice.ref),
    payable: async (amount) => fakeInvoice(amount, hash()),
    refused: async () => fakeInvoice(5_000, hash()),
  };
});

describe("the Cashu mints as a Lightning source, beyond the contract", () => {
  it("is on Bitcoin in Mainnet and on a test network otherwise, whatever prefix the mint's invoices carry", async () => {
    expect((await provider(undefined, "mainnet").provider.info()).network).toBe("bitcoin");
    expect((await provider(undefined, "testnet").provider.info()).network).toBe("testnet");
  });

  it("refuses an invoice from the mint that cannot be read", async () => {
    const { cashu, provider: p } = provider();
    cashu.receiveLightning.mockResolvedValueOnce({ quote: "q", mint: MINT, amount: 1, invoice: "lnbc1garbage", createdAt: 0, expiresAt: 0 });
    await expect(p.createInvoice(1)).rejects.toThrow(/cannot be read/);
  });

  it("an invoice the mint gives no expiry for expires with the invoice itself, and is said expired once past it", async () => {
    const { cashu, provider: p } = provider();
    const invoice = fakeInvoice(10, hash(), "", 60);
    cashu.receiveLightning.mockResolvedValueOnce({ quote: "q9", mint: MINT, amount: 10, invoice, createdAt: 0, expiresAt: undefined as unknown as number });
    const created = await p.createInvoice(10);
    expect(created.expiresAt).toBe(decodeBolt11(invoice)!.expiresAt * 1000);
    expect((await p.invoiceStatus({ ...created, expiresAt: Date.now() - 1 })).state).toBe("expired");
  });

  it("a status asked about something that is not one of its quotes is an error, never a state", async () => {
    const { provider: p } = provider();
    await expect(p.invoiceStatus({ invoice: "x", paymentHash: "", amount: 1, expiresAt: 0 })).rejects.toThrow("Unknown Cashu quote");
    await expect(p.paymentStatus({ invoice: "x", paymentHash: "", ref: JSON.stringify({ mint: MINT }) })).rejects.toThrow("Unknown Cashu quote");
  });

  it("a fee above the ceiling, or a melt the mint refuses, spends nothing", async () => {
    const { cashu, provider: p } = provider();
    cashu.feeReserve = 20;
    await expect(p.payInvoice(fakeInvoice(10, hash()), 5)).rejects.toSatisfy((error: unknown) => isNothingSpentError(error) && /20 sats/.test((error as Error).message));
    expect(cashu.payQuote).not.toHaveBeenCalled();
    cashu.feeReserve = 1;
    cashu.payQuote.mockRejectedValueOnce("mint offline");
    await expect(p.payInvoice(fakeInvoice(10, hash()), 5)).rejects.toSatisfy((error: unknown) => isNothingSpentError(error) && (error as Error).message === "mint offline");
    expect(cashu.balance).toBe(1_000);
  });

  it("a melt the mint left pending is pending, then failed when the mint gives the sats back", async () => {
    const { cashu, provider: p } = provider();
    cashu.pendingMelts = true;
    const invoice = fakeInvoice(10, hash());
    const result = await p.payInvoice(invoice, 5);
    expect(result.state).toBe("pending");
    const ref = { invoice, paymentHash: "", ref: result.ref };
    expect((await p.paymentStatus(ref)).state).toBe("pending");
    cashu.meltQuotes.get(JSON.parse(result.ref!).quote)!.state = "UNPAID";
    expect((await p.paymentStatus(ref)).state).toBe("failed");
  });

  it("forgets the quotes it showed once closed: the next payment is quoted again", async () => {
    const { cashu, provider: p } = provider();
    const invoice = fakeInvoice(10, hash());
    await p.estimateFee(invoice);
    expect(p.quoteFor(` ${invoice.toUpperCase()} `)).toBeDefined();
    await p.close();
    expect(p.quoteFor(invoice)).toBeUndefined();
    await p.payInvoice(invoice, 5);
    expect(cashu.quoteInvoice).toHaveBeenCalledTimes(2);
  });
});
