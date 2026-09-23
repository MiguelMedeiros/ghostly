import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11 } from "@ghostly/core";
import type { Payment, PaymentType, PrepareSendPaymentResponse } from "@breeztech/breez-sdk-spark/web";
import { loadBreezSdk, type BreezNetwork, type BreezSdkModule, type BreezWallet } from "./breezSdk";
import { isRecoveryPhrase, normalizePhrase } from "./recoveryPhrase";
import type { InvoiceStatus, LightningInvoice, LightningPayResult, LightningPaymentRef, LightningPaymentStatus, LightningProvider, LightningProviderDescriptor } from "./lightning";
import { NothingSpentError, type ProviderNetwork, type ProviderPlatform } from "./types";

export const BREEZ_SOURCE = "breez";
/**
 * Where the Breez source is offered. Regtest (Breez and Lightspark's, no API key) is the only network it
 * has been exercised on; Breez's Mainnet needs an API key and has never moved real money here, so it is
 * not offered yet. Adding "bitcoin" is the whole switch: the API key field is already required there.
 */
export const BREEZ_NETWORKS: readonly ProviderNetwork[] = ["regtest"];
/** WebAssembly and HTTPS only: the page, the extension's offscreen document and Tauri's WebView all run it. */
export const BREEZ_PLATFORMS: readonly ProviderPlatform[] = ["web", "extension", "desktop"];

const INVOICE_EXPIRY_SECS = 3600;
/** How long `payInvoice` waits for the payment to settle before answering `pending`. */
const COMPLETION_SECS = 30;
/** A fee shown to the person is paid with the same prepared payment for this long, then prepared again. */
const QUOTE_MS = 60_000;
/** Payments read to find one by its hash: newest first, bounded. */
const PAGE = 100, PAGES = 10;
/** Without any record of a payment, it is called failed only this long after its invoice expired. */
const LOST_AFTER_MS = 3600_000;
const DISCONNECT_MS = 10_000;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const breezNetwork = (network: ProviderNetwork): BreezNetwork => (network === "bitcoin" ? "mainnet" : "regtest");
const sats = (value: bigint | number) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error("Breez returned an invalid amount"); return n; };
const message = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "Breez refused the payment");

/** The wallet's own storage: one per network and seed, named without revealing anything about the seed. */
export const breezStorage = (network: ProviderNetwork, mnemonic: string) =>
  `ghostly-breez-${breezNetwork(network)}-${hex(sha256(new TextEncoder().encode(`ghostly-breez:${breezNetwork(network)}:${mnemonic}`))).slice(0, 16)}`;

/**
 * The idempotency key of one attempt at paying one invoice: asking the SDK twice with it pays once.
 * A new attempt (after one that failed) gets a new key, or the SDK would only hand back the failure.
 */
export function idempotencyKey(paymentHash: string, attempt: number): string {
  const b = sha256(new TextEncoder().encode(`ghostly-breez-pay:${paymentHash}:${attempt}`)).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The payment hash a Breez payment is about, when it is one (Lightning, or a Spark HTLC). */
function hashOf(payment: Payment): string | undefined {
  const details = payment.details;
  if (details?.type === "lightning") return details.htlcDetails.paymentHash;
  if (details?.type === "spark") return details.htlcDetails?.paymentHash;
  return undefined;
}
function preimageOf(payment: Payment): string | undefined {
  const details = payment.details;
  return details?.type === "lightning" ? details.htlcDetails.preimage : details?.type === "spark" ? details.htlcDetails?.preimage : undefined;
}

/** One SDK instance per wallet storage: re-saving the same wallet must not run two over one database. */
const open = new Map<string, { wallet: Promise<BreezWallet>; refs: number }>();

/**
 * Lightning through the Breez SDK, nodeless: a self-custodial wallet on Spark whose seed Ghostly
 * generated (or the person restored) and keeps sealed. Invoices are received and paid through Breez's
 * and Lightspark's Spark service providers; the sats are the seed's.
 *
 * Nothing is reported by itself: the engine polls `invoiceStatus` and `paymentStatus`, which find a
 * payment by its hash in the wallet's history.
 */
export class BreezLightning implements LightningProvider {
  readonly capabilities = { receive: true, send: true, balance: true, lookup: true };
  /** The prepared payment behind a fee just shown: `payInvoice` pays exactly that one while it is fresh. */
  private readonly quotes = new Map<string, { prepared: PrepareSendPaymentResponse; at: number }>();
  private closed = false;

  private constructor(private readonly wallet: BreezWallet, private readonly network: ProviderNetwork, private readonly release: () => Promise<void>) {}

  static async connect(params: { network: ProviderNetwork; mnemonic: string; apiKey?: string }, sdk: () => Promise<BreezSdkModule> = loadBreezSdk, storage = breezStorage): Promise<BreezLightning> {
    const key = `${storage(params.network, params.mnemonic)}|${params.apiKey ? hex(sha256(new TextEncoder().encode(params.apiKey))).slice(0, 8) : ""}`;
    let entry = open.get(key);
    if (!entry) {
      const wallet = sdk().then((module) => module.connect({ network: breezNetwork(params.network), mnemonic: params.mnemonic, apiKey: params.apiKey, storage: storage(params.network, params.mnemonic) }));
      entry = { wallet, refs: 0 };
      open.set(key, entry);
      wallet.catch(() => { if (open.get(key) === entry) open.delete(key); });
    }
    entry.refs++;
    const held = entry;
    let wallet: BreezWallet;
    try { wallet = await held.wallet; }
    catch (error) { held.refs--; throw error; }
    let released = false;
    return new BreezLightning(wallet, params.network, async () => {
      if (released) return;
      released = true;
      if (--held.refs > 0) return;
      if (open.get(key) === held) open.delete(key);
      await Promise.race([wallet.disconnect(), new Promise((resolve) => setTimeout(resolve, DISCONNECT_MS))]);
    });
  }

  async info() {
    const { balanceSats } = await this.wallet.getInfo({ ensureSynced: false });
    return { network: this.network, balance: sats(balanceSats) };
  }

  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    const { paymentRequest } = await this.wallet.receivePayment({ paymentMethod: { type: "bolt11Invoice", description: (memo ?? "").slice(0, 100), amountSats: amount, expirySecs: INVOICE_EXPIRY_SECS } });
    const decoded = decodeBolt11(paymentRequest);
    if (!decoded?.paymentHash || decoded.amountSat !== amount) throw new Error("Breez returned an invoice that does not match the request");
    return { invoice: decoded.invoice, paymentHash: decoded.paymentHash, amount, expiresAt: decoded.expiresAt * 1000 };
  }

  async invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus> {
    const payment = await this.find("receive", invoice.paymentHash, invoice.invoice);
    if (payment?.status === "completed") return { state: "paid", amount: sats(payment.amount) };
    // A payment on its way in (claim under way) is still open, even past the invoice's expiry.
    if (payment?.status === "pending") return { state: "open" };
    return { state: invoice.expiresAt < Date.now() ? "expired" : "open" };
  }

  /** Prepares the payment (nothing is sent) and keeps it for `payInvoice`: its fee is the one shown. */
  async estimateFee(invoice: string, amount: number) {
    const prepared = await this.prepare(invoice, amount);
    this.quotes.set(decodeBolt11(invoice)?.invoice ?? invoice, { prepared, at: Date.now() });
    return this.feeOf(prepared);
  }

  async payInvoice(invoice: string, maxFee: number): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    if (!decoded?.paymentHash || decoded.amountSat === null) throw new NothingSpentError("That is not an invoice Breez can pay");
    const hash = decoded.paymentHash, amount = decoded.amountSat, key = decoded.invoice;
    let prepared: PrepareSendPaymentResponse, attempt: number;
    // Everything up to `sendPayment` only reads and prepares: when it fails, nothing left the wallet.
    try {
      if (this.closed) throw new Error("The Breez wallet is closed");
      // Already paid, or on its way, from this wallet: answer that, never pay it again.
      const previous = await this.history("send", hash, decoded.invoice, decoded.createdAt);
      const live = previous.find((p) => p.status !== "failed");
      if (live) return this.result(live);
      attempt = previous.length;
      const quote = this.quotes.get(key);
      this.quotes.delete(key);
      prepared = quote && Date.now() - quote.at < QUOTE_MS ? quote.prepared : await this.prepare(decoded.invoice, amount);
      const fee = this.feeOf(prepared);
      if (fee > maxFee) throw new Error(`The Lightning fee (${fee} sats) is above your limit (${maxFee})`);
      const { balanceSats } = await this.wallet.getInfo({ ensureSynced: false });
      if (sats(balanceSats) < amount + fee) throw new Error(`Not enough sats in the Breez wallet (${sats(balanceSats)}; ${amount + fee} needed)`);
    } catch (error) {
      throw error instanceof NothingSpentError ? error : new NothingSpentError(message(error));
    }
    // From here on the sats may be gone: any throw is an unknown outcome, reconciled by the payment hash.
    const { payment } = await this.wallet.sendPayment({ prepareResponse: prepared, options: { type: "bolt11Invoice", preferSpark: false, completionTimeoutSecs: COMPLETION_SECS }, idempotencyKey: idempotencyKey(hash, attempt) });
    return this.result(payment);
  }

  async paymentStatus(ref: LightningPaymentRef): Promise<LightningPaymentStatus> {
    const decoded = decodeBolt11(ref.invoice);
    // By the hash first: of every attempt at this invoice, the one that went furthest answers.
    let payment = await this.find("send", ref.paymentHash, ref.invoice, decoded?.createdAt);
    if (!payment && ref.ref) {
      const byId = (await this.wallet.getPayment({ paymentId: ref.ref }).catch(() => undefined))?.payment;
      if (byId && hashOf(byId) === ref.paymentHash) payment = byId;
    }
    if (!payment) {
      // Not in the history: ask the operators, then look again.
      await this.wallet.syncWallet({});
      payment = await this.find("send", ref.paymentHash, ref.invoice, decoded?.createdAt);
    }
    if (!payment) {
      // No record at all, long after the invoice could be paid: it never left. Until then, it may still show up.
      const expired = decoded ? decoded.expiresAt * 1000 + LOST_AFTER_MS < Date.now() : false;
      return { state: expired ? "failed" : "pending" };
    }
    const state = payment.status === "completed" ? "paid" : payment.status === "failed" ? "failed" : "pending";
    return { state, fee: state === "paid" ? sats(payment.fees) : undefined, preimage: preimageOf(payment) };
  }

  async close() {
    if (this.closed) return;
    this.closed = true; this.quotes.clear();
    await this.release();
  }

  private async prepare(invoice: string, amount: number) {
    const prepared = await this.wallet.prepareSendPayment({ paymentRequest: { type: "input", input: invoice } });
    const method = prepared.paymentMethod;
    // What will be paid must be this invoice, for this amount, over Lightning.
    if (method.type !== "bolt11Invoice") throw new Error("Breez would not pay this as a Lightning invoice");
    if (method.invoiceDetails.paymentHash !== decodeBolt11(invoice)?.paymentHash || sats(prepared.amount) !== amount) throw new Error("Breez prepared a payment that does not match the invoice");
    return prepared;
  }

  private feeOf(prepared: PrepareSendPaymentResponse) {
    if (prepared.paymentMethod.type !== "bolt11Invoice") throw new Error("Breez would not pay this as a Lightning invoice");
    return sats(prepared.paymentMethod.lightningFeeSats);
  }

  /** `failed` is never an answer here: a payment the SDK gave up on is pending until `paymentStatus` says so. */
  private result(payment: Payment): LightningPayResult {
    if (payment.status === "completed") return { state: "paid", fee: sats(payment.fees), preimage: preimageOf(payment), ref: payment.id };
    return { state: "pending", ref: payment.id };
  }

  private async find(type: PaymentType, hash: string, invoice: string, createdAt?: number) {
    const found = await this.history(type, hash, invoice, createdAt);
    return found.find((p) => p.status === "completed") ?? found.find((p) => p.status === "pending") ?? found[0];
  }

  /** This wallet's payments of this hash, newest first. Only payments since the invoice was made are read. */
  private async history(type: PaymentType, hash: string, invoice: string, createdAt = decodeBolt11(invoice)?.createdAt): Promise<Payment[]> {
    const found: Payment[] = [];
    for (let page = 0; page < PAGES; page++) {
      const { payments } = await this.wallet.listPayments({ typeFilter: [type], fromTimestamp: createdAt ? createdAt - 600 : undefined, offset: page * PAGE, limit: PAGE, sortAscending: false });
      found.push(...payments.filter((p) => hashOf(p) === hash));
      if (payments.length < PAGE) break;
    }
    return found;
  }
}

/** The descriptor, with the SDK it loads (tests hand it a fake). */
export const breezDescriptor = (sdk: () => Promise<BreezSdkModule> = loadBreezSdk): LightningProviderDescriptor => ({
  id: BREEZ_SOURCE,
  label: "Breez (Spark)",
  kind: "lightning",
  description: "A self-custodial Lightning wallet on Spark, through the Breez SDK. Its recovery phrase is sealed on this device; you hold the sats.",
  networks: BREEZ_NETWORKS,
  platforms: BREEZ_PLATFORMS,
  fields: [
    { name: "mnemonic", label: "Recovery phrase", kind: "secret", placeholder: "twelve words…", help: "Made by Ghostly for a new wallet, or yours to restore one." },
    { name: "apiKey", label: "Breez API key", kind: "secret", optional: true, help: "Required on Mainnet (free, from Breez). Not needed in Testnet (regtest)." },
  ],
  experimental: true,
  validate({ secrets }, mode) {
    if (!isRecoveryPhrase(secrets.mnemonic ?? "")) throw new Error("That is not a valid recovery phrase");
    if (mode === "mainnet" && !secrets.apiKey?.trim()) throw new Error("Breez needs an API key on Mainnet");
  },
  async create({ secrets }, host) {
    const network: ProviderNetwork = host.mode === "mainnet" ? "bitcoin" : "regtest";
    return BreezLightning.connect({ network, mnemonic: normalizePhrase(secrets.mnemonic), apiKey: secrets.apiKey?.trim() || undefined }, sdk);
  },
});

export const breez = breezDescriptor();
