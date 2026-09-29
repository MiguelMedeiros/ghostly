import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11 } from "@ghostly/core";
import { fakeInvoice } from "../../src/engine/paymentAdapters/providers/testing";
import type { WebLNInfo, WebLNProvider } from "../../src/engine/paymentAdapters/providers/webln";

/**
 * In-memory WebLN wallets, the way a browser wallet (Alby…) would inject `window.webln`: regtest invoices
 * from `fakeInvoice`, a shared ledger so two fake wallets can pay each other, and switches for what a real
 * wallet does when things go wrong. No network, no money.
 *
 *  - pay:        pays, answers the preimage.
 *  - reject:     the person turns down the wallet's prompt ("User rejected"), nothing leaves.
 *  - noroute:    the wallet gives up before any HTLC ("no_route").
 *  - lost:       pays, then the answer never comes back (an error that says nothing).
 *  - noproof:    pays, answers without a preimage.
 */
export type FakeWeblnSend = "pay" | "reject" | "noroute" | "lost" | "noproof";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export class FakeWeblnLedger {
  readonly invoices = new Map<string, { preimage: string; amount: number; paid: boolean; owner: FakeWebln }>();
}

export interface FakeWeblnOptions {
  balance?: number;
  alias?: string;
  /** What `getInfo().methods` lists; absent: the wallet does not list them (every method is taken at its word). */
  methods?: string[];
  /** Methods this wallet's object does not even have. */
  missing?: (keyof WebLNProvider)[];
  /** A chain named in `getInfo()` (not standard). */
  network?: string;
  refuseEnable?: boolean;
  send?: FakeWeblnSend;
  currency?: string;
}

export class FakeWebln implements WebLNProvider {
  enabled = false;
  balance: number;
  send: FakeWeblnSend;
  readonly sent: string[] = [];
  readonly outgoing = new Map<string, string>();

  constructor(readonly ledger = new FakeWeblnLedger(), readonly options: FakeWeblnOptions = {}) {
    this.balance = options.balance ?? 100_000;
    this.send = options.send ?? "pay";
    for (const method of options.missing ?? []) (this as Record<string, unknown>)[method] = undefined;
  }

  async enable() {
    if (this.options.refuseEnable) throw new Error("User rejected");
    this.enabled = true;
  }
  private check() { if (!this.enabled) throw new Error("Provider must be enabled before calling"); }

  async getInfo(): Promise<WebLNInfo> {
    this.check();
    return { node: { alias: this.options.alias ?? "Fake WebLN", ...(this.options.network ? { network: this.options.network } : {}) }, ...(this.options.methods ? { methods: this.options.methods } : {}) };
  }

  async getBalance() {
    this.check();
    return { balance: this.options.currency === "msats" ? this.balance * 1000 : this.balance, ...(this.options.currency ? { currency: this.options.currency } : {}) };
  }

  async makeInvoice({ amount, defaultMemo }: { amount: number | string; defaultMemo?: string }) {
    this.check();
    const preimage = crypto.getRandomValues(new Uint8Array(32)), hash = sha256(preimage);
    this.ledger.invoices.set(hex(hash), { preimage: hex(preimage), amount: Number(amount), paid: false, owner: this });
    return { paymentRequest: fakeInvoice(Number(amount), hash, defaultMemo ?? "") };
  }

  /** Someone outside pays this wallet's invoice. */
  receive(paymentHash: string) {
    const entry = this.ledger.invoices.get(paymentHash);
    if (!entry || entry.paid || entry.owner !== this) throw new Error("Not an open invoice of this wallet");
    entry.paid = true; entry.owner.balance += entry.amount;
  }

  async sendPayment(paymentRequest: string) {
    this.check();
    const hash = decodeBolt11(paymentRequest)?.paymentHash ?? "";
    const entry = this.ledger.invoices.get(hash);
    if (this.send === "reject") throw new Error("User rejected");
    if (!entry || entry.paid || this.send === "noroute") throw new Error("Payment failed: no_route");
    if (this.balance < entry.amount) throw new Error("insufficient_balance");
    this.balance -= entry.amount; entry.owner.balance += entry.amount; entry.paid = true;
    this.sent.push(hash); this.outgoing.set(hash, entry.preimage);
    if (this.send === "lost") throw new Error("Connection reset");
    if (this.send === "noproof") return {};
    return { preimage: entry.preimage, route: { total_fees: 0, total_amt: entry.amount } };
  }

  async lookupInvoice({ paymentHash }: { paymentHash?: string; paymentRequest?: string }) {
    this.check();
    const entry = this.ledger.invoices.get(paymentHash ?? "");
    const paidOut = this.outgoing.get(paymentHash ?? "");
    if (paidOut) return { paid: true, preimage: paidOut };
    if (!entry || entry.owner !== this) throw new Error("Invoice not found");
    return { paid: entry.paid, ...(entry.paid ? { preimage: entry.preimage } : {}) };
  }
}
