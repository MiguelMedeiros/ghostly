import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11, NothingSpentError, type InvoiceStatus, type LightningInvoice, type LightningPayResult, type LightningPaymentRef, type LightningPaymentStatus, type LightningProvider, type LightningProviderDescriptor, type ProviderSettings } from "@ghostly/sdk";
import { fakeInvoice } from "@ghostly/sdk/fakes";

/**
 * "Paper Lightning": a Lightning source that keeps its sats on paper, in memory, on regtest. It
 * exists to show what a source is made of; it moves no money. Invoices it makes settle by themselves
 * after a moment (or when `settle` is called), payments succeed while the paper balance allows.
 */
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export interface PaperOptions { alias?: string; balance?: number; settleAfterMs?: number }

export class PaperLightning implements LightningProvider {
  readonly capabilities = { receive: true, send: true, balance: true, lookup: true };
  balance: number;
  private readonly open = new Map<string, LightningInvoice>();
  private readonly settled = new Set<string>();
  private readonly sent = new Map<string, LightningPaymentStatus>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(private readonly options: PaperOptions = {}) { this.balance = options.balance ?? 50_000; }

  async info() { return { network: "regtest" as const, alias: this.options.alias || "Paper node", balance: this.balance }; }

  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Whole sats only");
    const paymentHash = sha256(randomBytes(32));
    const invoice: LightningInvoice = { invoice: fakeInvoice(amount, paymentHash, memo), paymentHash: hex(paymentHash), amount, expiresAt: Date.now() + 3600_000 };
    this.open.set(invoice.paymentHash, invoice);
    const timer = setTimeout(() => { this.timers.delete(timer); this.settle(invoice.paymentHash); }, this.options.settleAfterMs ?? 1000);
    this.timers.add(timer);
    return invoice;
  }

  /** Someone paid this invoice of ours. */
  settle(paymentHash: string) {
    const invoice = this.open.get(paymentHash);
    if (!invoice || this.settled.has(paymentHash) || this.closed) return;
    this.settled.add(paymentHash);
    this.balance += invoice.amount;
  }

  async invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus> {
    if (this.settled.has(invoice.paymentHash)) return { state: "paid", amount: invoice.amount };
    return { state: invoice.expiresAt < Date.now() ? "expired" : "open" };
  }

  async estimateFee(_invoice: string, amount: number) { return Math.max(1, Math.ceil(amount / 1000)); }

  async payInvoice(invoice: string, maxFee: number): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    // Refused before anything could leave: that is what NothingSpentError is for, and nothing else is.
    if (!decoded?.paymentHash || decoded.amountSat === null) throw new NothingSpentError("Not an invoice with an amount");
    const fee = Math.min(maxFee, Math.max(1, Math.ceil(decoded.amountSat / 1000)));
    if (this.balance < decoded.amountSat + fee) throw new NothingSpentError("Not enough sats on paper");
    this.balance -= decoded.amountSat + fee;
    const status: LightningPaymentStatus = { state: "paid", fee, preimage: hex(randomBytes(32)) };
    this.sent.set(decoded.paymentHash, status);
    return { state: "paid", fee, preimage: status.preimage };
  }

  async paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus> {
    return this.sent.get(payment.paymentHash) ?? { state: "failed" };
  }

  async close() { this.closed = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}

const options = ({ config, secrets }: ProviderSettings): PaperOptions => ({ alias: config.alias, balance: secrets.ticket.length * 1000 });

export const paperLightning: LightningProviderDescriptor = {
  id: "paper-lightning",
  label: "Paper Lightning (SDK example)",
  kind: "lightning",
  description: "Sats on paper, in memory, on regtest. An example source built with the SDK; it holds nothing.",
  networks: ["regtest"],
  platforms: ["web", "extension", "desktop"],
  fields: [
    { name: "alias", label: "Name", kind: "text", optional: true, placeholder: "Paper node" },
    // A secret, to show where credentials go: sealed on the device, never shown again, never logged.
    { name: "ticket", label: "Ticket", kind: "secret", placeholder: "any text", help: "Stands in for a credential. The paper balance is 1,000 sats per character." },
  ],
  experimental: true,
  validate({ secrets }) { if (!secrets.ticket?.trim()) throw new Error("Enter a ticket"); if (secrets.ticket.length > 100) throw new Error("That ticket is too long"); },
  async create(settings, host) {
    const provider = new PaperLightning(options(settings));
    // The engine ends the signal when the source is replaced or the mode switches: stop then.
    host.signal.addEventListener("abort", () => void provider.close(), { once: true });
    return provider;
  },
};
