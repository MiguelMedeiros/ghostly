import type { Payment, PrepareSendPaymentResponse } from "@breeztech/breez-sdk-spark/web";
import { PaymentPreflightError, SPARK_NETWORKS, SPARK_PROVIDER, assertWholeSats, sparkAddressKind, validatePaymentTarget, type PaymentAdapter, type PaymentExecution, type PaymentReview, type PaymentTarget, type SparkNetwork } from "@ghostly/core";
import { loadBreezSdk, openBreez, type BreezSdkModule, type BreezWallet } from "./providers/breezSdk";

/**
 * What a review approved: where, how much, the fee shown, and the idempotency key of this one payment. The key is
 * made at review and journaled with it, so a send retried after a crash is the same send (the SDK pays a key once),
 * and it is also the id the SDK gives the transfer, which is how an unknown outcome is found again.
 */
export interface SparkPrepared { address: string; kind: "address" | "invoice"; amount: number; fee: number; key: string }
/** One line of the wallet's history, as the wallet page shows it. */
export interface SparkHistoryEntry {
  id: string; direction: "in" | "out"; amount: number; fee: number; at: number;
  status: "completed" | "pending" | "failed";
  /** How it moved: Spark to Spark, Lightning (the Breez source on the same seed), on-chain deposit or withdrawal. */
  via: "spark" | "lightning" | "onchain" | "other";
  memo?: string;
}

/** How long a request's invoice stays payable. */
export const SPARK_INVOICE_SECS = 15 * 60;
/** Payments read to find one: newest first, bounded. */
const PAGE = 100, PAGES = 5;
const sats = (value: bigint | number | string) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error("Spark returned an invalid amount"); return n; };
const message = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "Spark refused the payment");
const invoiceOf = (p: Payment) => p.details?.type === "spark" ? p.details.invoiceDetails?.invoice : undefined;
/** A fresh RFC 4122 v4 UUID: the SDK wants its idempotency keys in that form. */
export const newSparkKey = () => crypto.randomUUID();

/**
 * Spark, wallet to wallet, through the Breez SDK (nodeless, WebAssembly): the same wallet and seed as the Breez
 * Lightning source can be, since both open it through `openBreez`. A payment goes to a Spark address (any amount)
 * or a Spark invoice (the amount the payee asked); either is off-chain and final once Spark's operators signed
 * the transfer. There is no server of our choosing: every Spark wallet of a network pays every other.
 */
export class SparkAdapter implements PaymentAdapter<SparkPrepared> {
  readonly method = "spark" as const;
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
  private closed = false;
  private own?: string;

  private constructor(readonly network: SparkNetwork, private readonly wallet: BreezWallet, private readonly releaseWallet: () => Promise<void>) {}

  static async connect(params: { network: SparkNetwork; mnemonic: string; apiKey?: string }, sdk: () => Promise<BreezSdkModule> = loadBreezSdk): Promise<SparkAdapter> {
    if (!SPARK_NETWORKS.includes(params.network)) throw new Error("Unsupported Spark network");
    if (params.network === "bitcoin" && !params.apiKey) throw new Error("Spark on Mainnet needs a Breez API key");
    const { wallet, release } = await openBreez(params, sdk);
    return new SparkAdapter(params.network, wallet, release);
  }

  /** The wallet's Spark address: its identity, the same every time. The wallet page shows it. */
  async address(): Promise<string> {
    if (this.own) return this.own;
    const { paymentRequest } = await this.wallet.receivePayment({ paymentMethod: { type: "sparkAddress" } });
    if (sparkAddressKind(paymentRequest, this.network) !== "address") throw new Error("Spark returned an address of another network");
    return this.own = paymentRequest;
  }

  /**
   * A Spark invoice for one request: this amount, this memo, payable until `expiresAt`. It carries a unique id, so
   * what arrives on it pays that request and no other; the payee's own history says when it did.
   */
  async invoice(amount: number, memo: string | undefined, expiresAt: number): Promise<string> {
    assertWholeSats(amount);
    const { paymentRequest } = await this.wallet.receivePayment({ paymentMethod: { type: "sparkInvoice", amount: String(amount), description: memo?.slice(0, 140) || undefined, expiryTime: Math.floor(expiresAt / 1000) } });
    if (sparkAddressKind(paymentRequest, this.network) !== "invoice") throw new Error("Spark returned an invoice of another network");
    return paymentRequest;
  }

  async balance(): Promise<number> { return sats((await this.wallet.getInfo({ ensureSynced: false })).balanceSats); }
  /** Asks Spark's operators for what changed (transfers to claim, payments that completed). */
  async sync(): Promise<void> { await this.wallet.syncWallet({}); }

  async history(limit = 25): Promise<SparkHistoryEntry[]> {
    const { payments } = await this.wallet.listPayments({ limit, sortAscending: false });
    return payments.map((p) => ({
      id: p.id, direction: p.paymentType === "send" ? "out" : "in", amount: sats(p.amount), fee: sats(p.fees), at: p.timestamp * 1000, status: p.status,
      via: p.method === "spark" ? "spark" : p.method === "lightning" ? "lightning" : p.method === "deposit" || p.method === "withdraw" ? "onchain" : "other",
      memo: p.details?.type === "spark" ? p.details.invoiceDetails?.description : p.details?.type === "lightning" ? p.details.description : undefined,
    }));
  }

  /** Nothing is signed: the SDK only says what it would pay and what that costs. */
  prepare(target: PaymentTarget, amount: number, feeCap: number) { return this.serial(async () => {
    validatePaymentTarget(target); assertWholeSats(amount);
    this.checkTarget(target);
    const { fee, kind } = this.feeOf(await this.quote(target.address, amount), target.address, amount);
    if (fee > feeCap) throw new Error("The Spark fee exceeds your limit");
    if (await this.balance() < amount + fee) throw new Error("Insufficient Spark balance");
    return { fee, prepared: { address: target.address, kind, amount, fee, key: newSparkKey() } };
  }); }

  execute(review: PaymentReview, prepared: SparkPrepared, persist?: () => Promise<void>) { return this.serial(async (): Promise<PaymentExecution> => {
    let quote: PrepareSendPaymentResponse;
    // Everything up to `sendPayment` only reads: when it fails, nothing left the wallet.
    try {
      if (this.closed) throw new Error("This Spark wallet is closed");
      this.checkPrepared(review, prepared);
      this.checkTarget(review);
      // Already sent with this key (a retry after an interruption): answer that, never pay again.
      const previous = await this.sent(review, prepared);
      if (previous) return this.outcome(previous);
      quote = await this.quote(prepared.address, prepared.amount);
      if (this.feeOf(quote, prepared.address, prepared.amount).fee > review.fee) throw new Error("The Spark fee changed. Create a new review");
      if (await this.balance() < review.amount + review.fee) throw new Error("Spark balance changed. Create a new review");
      if (!persist) throw new Error("Durable payment journal required");
    } catch (error) { throw new PaymentPreflightError(message(error)); }
    await persist(); // Written down before anything leaves: an interruption from here on is only ever reconciled.
    try {
      const { payment } = await this.wallet.sendPayment({ prepareResponse: quote, idempotencyKey: prepared.key });
      return this.outcome(payment);
    } catch (error) {
      // An error after the call started proves nothing: the history says whether it went out.
      const found = await this.sent(review, prepared).catch(() => undefined);
      if (found) return this.outcome(found);
      // SDK errors may carry wallet internals; only a bounded message leaves.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(/insufficient/i.test(message(error)) ? "Insufficient Spark balance" : "Spark payment outcome unknown");
    }
  }); }

  /** Only ever looks: a payment whose outcome is unknown is never sent a second time. */
  reconcile(review: PaymentReview, prepared: SparkPrepared) { return this.serial(async (): Promise<PaymentExecution> => {
    this.checkPrepared(review, prepared);
    let found = await this.sent(review, prepared);
    if (!found) { await this.wallet.syncWallet({}).catch(() => {}); found = await this.sent(review, prepared); }
    return found ? this.outcome(found) : { settled: false };
  }); }

  /**
   * The payee's own proof that a request is paid: a completed receive on the invoice made for it, of at least the
   * amount asked. Nothing the payer says is trusted. `claimed`: transfers that already paid another request.
   */
  async received(invoice: string, amount: number, since: number, claimed: ReadonlySet<string> = new Set()): Promise<string | undefined> {
    for (let page = 0; page < PAGES; page++) {
      const { payments } = await this.wallet.listPayments({ typeFilter: ["receive"], fromTimestamp: Math.floor(since / 1000) - 600, offset: page * PAGE, limit: PAGE, sortAscending: false });
      const found = payments.find((p) => p.status === "completed" && invoiceOf(p) === invoice && sats(p.amount) >= amount && !claimed.has(p.id));
      if (found) return found.id;
      if (payments.length < PAGE) break;
    }
    return undefined;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => {});
    await this.releaseWallet();
  }

  private quote(address: string, amount: number) {
    // An invoice names its amount; an address takes the one reviewed.
    const kind = sparkAddressKind(address, this.network);
    return this.wallet.prepareSendPayment({ paymentRequest: { type: "input", input: address }, ...(kind === "address" ? { amount: BigInt(amount) } : {}) });
  }

  /** What will be paid must be this address or invoice, for this amount, over Spark (never Lightning, never on-chain). */
  private feeOf(quote: PrepareSendPaymentResponse, address: string, amount: number): { fee: number; kind: "address" | "invoice" } {
    const method = quote.paymentMethod;
    if (quote.tokenIdentifier) throw new Error("That Spark request is for a token, not sats");
    if (method.type === "sparkAddress") {
      if (method.address !== address || method.tokenIdentifier) throw new Error("Spark prepared a payment to another address");
    } else if (method.type === "sparkInvoice") {
      const details = method.sparkInvoiceDetails;
      if (details.invoice !== address || details.tokenIdentifier) throw new Error("Spark prepared a payment to another invoice");
      if (details.amount !== undefined && sats(details.amount) !== amount) throw new Error("The Spark invoice is for another amount");
      if (details.expiryTime !== undefined && details.expiryTime * 1000 < Date.now()) throw new Error("The Spark invoice has expired");
    } else throw new Error("Spark would not pay this as a Spark transfer");
    if (sats(quote.amount) !== amount) throw new Error("Spark prepared another amount");
    return { fee: sats(method.fee), kind: method.type === "sparkAddress" ? "address" : "invoice" };
  }

  /**
   * This payment in the wallet's history. By its key first (the SDK names the transfer after it); then, for an
   * invoice, the send that paid that invoice. A send to a bare address is only ever found by its key.
   */
  private async sent(review: PaymentReview, prepared: SparkPrepared): Promise<Payment | undefined> {
    const byKey = (await this.wallet.getPayment({ paymentId: prepared.key }).catch(() => undefined))?.payment;
    if (byKey && byKey.paymentType === "send") return byKey;
    if (review.txid) {
      const byId = (await this.wallet.getPayment({ paymentId: review.txid }).catch(() => undefined))?.payment;
      if (byId && byId.paymentType === "send") return byId;
    }
    if (prepared.kind !== "invoice") return undefined;
    const { payments } = await this.wallet.listPayments({ typeFilter: ["send"], fromTimestamp: Math.floor(review.createdAt / 1000) - 600, limit: PAGE, sortAscending: false });
    const mine = payments.filter((p) => invoiceOf(p) === prepared.address);
    return mine.find((p) => p.status === "completed") ?? mine.find((p) => p.status === "pending") ?? mine[0];
  }

  private outcome(payment: Payment): PaymentExecution {
    if (payment.status === "completed") return { txid: payment.id, settled: true };
    if (payment.status === "failed") return { txid: payment.id, settled: false, failed: true, error: "Spark did not take this payment. Nothing was sent." };
    return { txid: payment.id, settled: false, pending: true };
  }
  private checkTarget(t: PaymentTarget) {
    if (t.method !== this.method || t.network !== this.network || t.provider !== SPARK_PROVIDER || t.asset !== "BTC" || t.unit !== "sat") throw new Error("Payment method or network does not match this Spark wallet");
    if (!sparkAddressKind(t.address, this.network)) throw new Error(`Not a Spark address on ${this.network === "bitcoin" ? "Bitcoin" : this.network}`);
  }
  private checkPrepared(r: PaymentReview, p: SparkPrepared) {
    if (p.address !== r.address || p.amount !== r.amount || p.fee !== r.fee || p.fee > r.feeCap || sparkAddressKind(p.address, this.network) !== p.kind || !/^[0-9a-f-]{36}$/.test(p.key)) throw new Error("Prepared payment does not match the approved review");
  }
}
