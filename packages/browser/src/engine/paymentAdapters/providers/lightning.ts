import type { ProviderDescriptor, ProviderNetwork } from "./types";

/**
 * A source of Lightning: something that can create invoices and pay them (the Cashu mints, a node, a
 * remote wallet). One is active per profile and per wallet mode; the Lightning card, the invoice a chat
 * request carries and paying a contact's invoice all go through it. See PROVIDERS.md.
 *
 * Amounts are whole sats. Times are milliseconds since the epoch.
 */

export interface LightningInfo {
  /** The chain its channels are on; must be a network of the wallet mode it is used in. */
  network: ProviderNetwork;
  /** A name for the node or wallet, when it has one. */
  alias?: string;
  /** Spendable sats, when the source has a balance of its own (a node, a remote wallet). */
  balance?: number;
}

export interface LightningInvoice {
  /** BOLT 11, as the provider returned it. The engine checks it decodes, and its amount and hash. */
  invoice: string;
  paymentHash: string;
  amount: number;
  expiresAt: number;
  /** The provider's own handle for it (a quote id, an invoice index), handed back to `invoiceStatus`. */
  ref?: string;
}

export interface InvoiceStatus {
  state: "open" | "paid" | "expired";
  /** Sats received, once paid. */
  amount?: number;
}

/** What was paid, or asked to be paid: handed back to `paymentStatus`. */
export interface LightningPaymentRef {
  invoice: string;
  paymentHash: string;
  ref?: string;
}

/**
 * The outcome of `payInvoice`. `pending`: the payment is in flight (HTLCs out, a mint holding it); the
 * engine asks `paymentStatus` later. Never report `failed` here: a payment known not to have gone out is
 * a thrown `NothingSpentError`.
 */
export type LightningPayResult =
  | { state: "paid"; /** Routing fee in sats, when known. */ fee?: number; preimage?: string; ref?: string }
  | { state: "pending"; ref?: string };

export interface LightningPaymentStatus {
  state: "paid" | "pending" | "failed";
  fee?: number;
  preimage?: string;
}

export interface LightningCapabilities {
  receive: boolean;
  send: boolean;
  /** `info().balance` means something. */
  balance: boolean;
  /** `invoiceStatus` and `paymentStatus` answer. Without it an incoming invoice is never seen paid. */
  lookup: boolean;
}

export interface LightningProvider {
  readonly capabilities: LightningCapabilities;
  /**
   * The source settles and reports its own invoices and payments (the Cashu wallet mints its ecash and
   * resolves pending melts by itself, and tells the engine). The engine then never polls it.
   */
  readonly settlesItself?: boolean;
  info(): Promise<LightningInfo>;
  createInvoice(amount: number, memo?: string): Promise<LightningInvoice>;
  invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus>;
  /** The most paying this invoice may cost in fees, when the source can tell before paying. */
  estimateFee?(invoice: string, amount: number): Promise<number>;
  /**
   * Pays, spending at most `maxFee` in fees. Resolves `paid` or `pending`. Throws `NothingSpentError`
   * only when it is certain nothing left the wallet; any other throw is an unknown outcome.
   */
  payInvoice(invoice: string, maxFee: number, note?: string): Promise<LightningPayResult>;
  paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus>;
  /** Ends connections and timers. The provider is not used again. */
  close(): Promise<void>;
}

export type LightningProviderDescriptor = ProviderDescriptor<LightningProvider> & { kind: "lightning" };
