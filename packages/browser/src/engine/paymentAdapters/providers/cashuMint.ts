import { decodeBolt11 } from "@ghostly/core";
import type { WalletMode } from "../../../shared/mints";
import type { CashuWallet } from "../../wallet";
import type { LightningInvoice, LightningPaymentRef, LightningProvider, LightningProviderDescriptor } from "./lightning";
import { NothingSpentError, PROVIDER_PLATFORMS } from "./types";

export const CASHU_MINT_SOURCE = "cashu-mint";

interface MintRef { mint: string; quote: string }
const parseRef = (ref: string | undefined): MintRef => {
  const parsed = JSON.parse(ref ?? "null") as MintRef | null;
  if (!parsed?.mint || !parsed.quote) throw new Error("Unknown Cashu quote");
  return parsed;
};

/**
 * Lightning through the Cashu mints: invoices are mint quotes that turn into ecash once paid, and
 * invoices are paid by melting ecash. The default source, and what Lightning was before sources.
 *
 * The Cashu wallet already polls its quotes and pending melts, mints and books them and says so
 * (`onQuotePaid`, `onMeltResolved`): the engine forwards those, and never polls this source itself.
 */
export class CashuMintLightning implements LightningProvider {
  readonly capabilities = { receive: true, send: true, balance: true, lookup: true };
  readonly settlesItself = true;
  /** The melt quote shown to the person is the one paid: quoting again could change the fee. */
  private readonly quotes = new Map<string, { quote: string; mint: string; amount: number; feeReserve: number }>();

  constructor(private readonly wallet: CashuWallet, private readonly mode: WalletMode) {}

  async info() {
    // Test mints issue invoices for worthless sats (often with a mainnet prefix): the mode says which it is.
    return { network: this.mode === "mainnet" ? "bitcoin" as const : "testnet" as const, balance: (await this.wallet.view()).balance };
  }

  async createInvoice(amount: number): Promise<LightningInvoice> {
    const quote = await this.wallet.receiveLightning(amount);
    const decoded = decodeBolt11(quote.invoice);
    if (!decoded?.paymentHash) throw new Error("The mint returned an invoice that cannot be read");
    return { invoice: quote.invoice, paymentHash: decoded.paymentHash, amount, expiresAt: quote.expiresAt ?? decoded.expiresAt * 1000, ref: JSON.stringify({ mint: quote.mint, quote: quote.quote }) };
  }

  async invoiceStatus(invoice: LightningInvoice) {
    const { mint, quote } = parseRef(invoice.ref);
    const state = await this.wallet.mintQuoteState(mint, quote);
    if (state === "PAID" || state === "ISSUED") return { state: "paid" as const, amount: invoice.amount };
    return { state: invoice.expiresAt < Date.now() ? "expired" as const : "open" as const };
  }

  /** A real melt quote: its fee reserve is what paying may cost at most. It is kept for `payInvoice`. */
  async estimateFee(invoice: string) {
    const quote = await this.wallet.quoteInvoice(invoice);
    this.quotes.set(invoice.trim().toLowerCase(), quote);
    return quote.feeReserve;
  }

  /** The quote behind a fee just shown, when there is one: `payQuote` pays exactly that. */
  quoteFor(invoice: string) {
    return this.quotes.get(invoice.trim().toLowerCase());
  }

  async payInvoice(invoice: string, maxFee: number, note?: string) {
    const key = invoice.trim().toLowerCase();
    let quote = this.quotes.get(key);
    // Nothing reaches the mint's melt before `payQuote`, and it throws only when the sats did not leave.
    try {
      quote ??= await this.wallet.quoteInvoice(invoice);
      if (quote.feeReserve > maxFee) throw new Error(`The Lightning fee (${quote.feeReserve} sats) is too high`);
    } catch (error) {
      throw new NothingSpentError(error instanceof Error ? error.message : String(error));
    }
    this.quotes.delete(key);
    const ref = JSON.stringify({ mint: quote.mint, quote: quote.quote });
    let paid: boolean;
    try { paid = await this.wallet.payQuote(quote.quote, quote.mint, note); }
    catch (error) { throw new NothingSpentError(error instanceof Error ? error.message : String(error)); }
    return paid ? { state: "paid" as const, ref } : { state: "pending" as const, ref };
  }

  async paymentStatus(payment: LightningPaymentRef) {
    const { mint, quote } = parseRef(payment.ref);
    const state = await this.wallet.meltQuoteState(mint, quote);
    return { state: state === "PAID" ? "paid" as const : state === "PENDING" ? "pending" as const : "failed" as const };
  }

  async close() { this.quotes.clear(); }
}

export const cashuMint: LightningProviderDescriptor = {
  id: CASHU_MINT_SOURCE,
  label: "Cashu mints",
  kind: "lightning",
  description: "Invoices are paid into, and paid from, your Cashu balance. The mints hold the sats.",
  networks: ["bitcoin", "testnet"],
  platforms: PROVIDER_PLATFORMS,
  fields: [],
  custodial: true,
  async create(_settings, host) { return new CashuMintLightning(host.cashu, host.mode); },
};
