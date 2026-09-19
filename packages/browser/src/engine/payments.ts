import {
  ENDPOINT,
  cashuRequestPayload,
  findEndpoint,
  parseCashuRequestPayload,
  randomBytes,
  toBase64Url,
  type GhostLink,
  type Payment,
  type PaymentRequest,
  type PaymentResult,
} from "@ghostly/core";
import { STORES, store, wrap } from "../shared/idb";
import type { PaymentView, StoredMessage, StoredPayment, StoredQuote } from "../shared/types";
import { assertAmount, type CashuWallet } from "./wallet";

/**
 * Payments in a chat. The protocol only carries requests, ecash and receipts
 * between the two peers; the wallet does the paying. Every outgoing token is
 * kept until the peer confirms it, so ecash a contact never redeemed can be
 * taken back.
 */
const UNIT = "sat";

export interface PaymentDeskHost {
  getLink(linkId: string): GhostLink | null;
  storeMessage(message: StoredMessage): Promise<void>;
  onChange(): void;
}

const newId = () => toBase64Url(randomBytes(12));

/** Whole sats only: that is all ecash in `sat` can represent. */
function parseSats(value: string, asset: string): number | null {
  if (asset !== UNIT || !/^[1-9]\d{0,8}$/.test(value)) return null;
  return Number(value);
}

export class PaymentDesk {
  private readonly payments = new Map<string, StoredPayment>();

  constructor(
    private readonly wallet: CashuWallet,
    private readonly host: PaymentDeskHost,
  ) {}

  async start(): Promise<void> {
    const stored = await wrap<StoredPayment[]>((await store(STORES.payments, "readonly")).getAll());
    for (const payment of stored) this.payments.set(payment.id, payment);
  }

  views(): Record<string, PaymentView> {
    // The token is money: it stays with the peer and never reaches a page.
    return Object.fromEntries([...this.payments].map(([id, { token: _token, ...view }]) => [id, view]));
  }

  async forgetLink(linkId: string): Promise<void> {
    const paymentStore = await store(STORES.payments, "readwrite");
    for (const payment of [...this.payments.values()]) {
      // Ecash the peer has not taken yet is still the user's; keep it reclaimable.
      if (payment.linkId !== linkId || (payment.token && payment.state === "pending")) continue;
      this.payments.delete(payment.id);
      void wrap(paymentStore.delete(payment.id));
    }
  }

  // -- what the user does --------------------------------------------------------

  async send(params: { linkId: string; amount: number; memo?: string; timestamp: number }): Promise<{ paymentId: string }> {
    assertAmount(params.amount);
    const link = this.requireLink(params.linkId);
    // Reach the peer before taking ecash out of the wallet.
    await link.connect();
    const paymentId = await this.sendEcash(link, params);
    return { paymentId };
  }

  async request(params: { linkId: string; amount: number; memo?: string; timestamp: number }): Promise<{ paymentId: string }> {
    assertAmount(params.amount);
    const link = this.requireLink(params.linkId);
    await link.connect();

    const id = newId();
    const memo = params.memo?.trim().slice(0, 140) || undefined;
    const quote = await this.wallet.receiveLightning(params.amount, id);
    const mints = (await this.wallet.view()).mints.map((m) => m.url);

    await this.save({
      id,
      linkId: params.linkId,
      kind: "request",
      direction: "out",
      amount: params.amount,
      unit: UNIT,
      memo,
      state: "pending",
      createdAt: params.timestamp,
      invoice: quote.invoice,
      mints,
    });
    await this.host.storeMessage({
      linkId: params.linkId,
      id: `me_${params.timestamp}`,
      text: `⚡ Requested ${params.amount.toLocaleString()} sats`,
      sender: "me",
      timestamp: params.timestamp,
      via: "datalink",
      paymentId: id,
    });
    await link.sendPaymentRequest({
      id,
      timestamp: params.timestamp,
      amount: { value: String(params.amount), asset: UNIT },
      memo,
      // Anyone can pay the invoice from any Lightning wallet; a contact on one of these mints can pay in ecash.
      endpoints: [
        [ENDPOINT.bolt11, quote.invoice],
        [ENDPOINT.cashu, cashuRequestPayload(mints)],
      ],
    });
    return { paymentId: id };
  }

  /** Pays a contact's request: ecash when we share a mint with funds, Lightning from any of our mints otherwise. */
  async payRequest(params: { linkId: string; paymentId: string }): Promise<void> {
    const request = this.payments.get(params.paymentId);
    if (!request || request.kind !== "request" || request.direction !== "in" || request.linkId !== params.linkId) {
      throw new Error("Unknown payment request");
    }
    if (request.state !== "pending") throw new Error("This request is no longer open");
    // Ecash already sent for it is waiting on the contact's answer; paying again would pay twice.
    const inFlight = [...this.payments.values()].some(
      (p) => p.kind === "payment" && p.direction === "out" && p.requestId === request.id && p.state !== "reclaimed" && p.state !== "failed",
    );
    if (inFlight) throw new Error("You already paid this request");
    const link = this.requireLink(params.linkId);
    await link.connect();

    try {
      await this.sendEcash(link, {
        linkId: params.linkId,
        amount: request.amount,
        timestamp: Date.now(),
        requestId: request.id,
        mints: request.mints ?? [],
      });
      return;
    } catch (error) {
      if (!request.invoice) throw error;
    }

    const quote = await this.wallet.quoteInvoice(request.invoice);
    if (quote.amount !== request.amount) throw new Error("The invoice does not match the requested amount");
    const feeLimit = Math.max(10, Math.ceil(request.amount * 0.03));
    if (quote.feeReserve > feeLimit) throw new Error(`The Lightning fee (${quote.feeReserve} sats) is too high`);
    if (!(await this.wallet.payQuote(quote.quote, quote.mint, request.memo ?? "Paid a contact's request"))) throw new Error("The Lightning payment did not go through");
    await this.save({ ...request, state: "settled", mint: quote.mint });
  }

  /** Takes back ecash the peer never redeemed. If they did redeem it, the mint says so and the payment is settled. */
  async reclaim(paymentId: string): Promise<void> {
    const payment = this.payments.get(paymentId);
    if (!payment?.token || payment.direction !== "out") throw new Error("Nothing to reclaim");
    try {
      await this.wallet.receiveToken(payment.token, "reclaimed", payment.memo);
      await this.save({ ...payment, state: "reclaimed", token: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/spent/i.test(message)) throw error;
      await this.save({ ...payment, state: "settled", token: undefined });
    }
  }

  // -- what the peer does ----------------------------------------------------------

  async onPaymentRequest(linkId: string, request: PaymentRequest): Promise<void> {
    if (this.payments.has(request.id)) return;
    const amount = parseSats(request.amount.value, request.amount.asset);
    const link = this.host.getLink(linkId);
    if (amount === null) {
      link?.sendPaymentResult({ id: request.id, ok: false, error: "Only whole amounts in sats are supported" });
      return;
    }
    await this.save({
      id: request.id,
      linkId,
      kind: "request",
      direction: "in",
      amount,
      unit: UNIT,
      memo: request.memo,
      state: "pending",
      createdAt: request.timestamp,
      invoice: findEndpoint(request.endpoints, ENDPOINT.bolt11),
      mints: parseCashuRequestPayload(findEndpoint(request.endpoints, ENDPOINT.cashu) ?? ""),
    });
    await this.host.storeMessage({
      linkId,
      id: `peer_${request.timestamp}`,
      text: `⚡ Requested ${amount.toLocaleString()} sats`,
      sender: "peer",
      timestamp: request.timestamp,
      via: "datalink",
      paymentId: request.id,
    });
  }

  async onPayment(linkId: string, payment: Payment): Promise<void> {
    const link = this.host.getLink(linkId);
    const known = this.payments.get(payment.id);
    if (known && known.linkId !== linkId) {
      // Another link's id. Answering from its record would tell this contact about that one.
      link?.sendPaymentResult({ id: payment.id, ok: false, error: "Unknown payment" });
      return;
    }
    if (known) {
      // A retransmission: say again what happened, redeem nothing twice.
      link?.sendPaymentResult({ id: payment.id, ok: known.state === "settled", credited: String(known.amount), error: known.error });
      return;
    }

    const [identifier, token] = payment.endpoint;
    try {
      if (identifier !== ENDPOINT.cashu) throw new Error("Unsupported payment method");
      if (parseSats(payment.amount.value, payment.amount.asset) === null) throw new Error("Unsupported amount");
      const { amount, mint } = await this.wallet.receiveToken(token, "ecash-in", payment.memo, { addTestMint: false });

      await this.save({
        id: payment.id,
        linkId,
        kind: "payment",
        direction: "in",
        amount,
        unit: UNIT,
        memo: payment.memo,
        state: "settled",
        createdAt: payment.timestamp,
        mint,
        requestId: payment.requestId,
      });
      // It settles our request only in full and in ecash from a mint the request named. Anything less is
      // received, and the request stays open.
      const request = payment.requestId ? this.payments.get(payment.requestId) : undefined;
      if (
        request?.kind === "request" &&
        request.direction === "out" &&
        request.linkId === linkId &&
        request.state === "pending" &&
        amount >= request.amount &&
        (request.mints ?? []).includes(mint)
      ) {
        await this.save({ ...request, state: "settled", mint });
      }
      await this.host.storeMessage({
        linkId,
        id: `peer_${payment.timestamp}`,
        text: `⚡ ${amount.toLocaleString()} sats`,
        sender: "peer",
        timestamp: payment.timestamp,
        via: "datalink",
        paymentId: payment.id,
      });
      link?.sendPaymentResult({ id: payment.id, ok: true, credited: String(amount) });
    } catch (error) {
      link?.sendPaymentResult({ id: payment.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async onPaymentResult(linkId: string, result: PaymentResult): Promise<void> {
    const payment = this.payments.get(result.id);
    if (!payment || payment.linkId !== linkId || payment.state !== "pending") return;

    if (payment.kind === "request") {
      // Only the payee can declare a request paid, and only about a request it sent us.
      if (payment.direction === "in" && result.ok) await this.save({ ...payment, state: "settled" });
      return;
    }
    if (payment.direction !== "out") return;

    if (result.ok) {
      await this.save({ ...payment, state: "settled", token: undefined });
      const request = payment.requestId ? this.payments.get(payment.requestId) : undefined;
      if (request?.state === "pending") await this.save({ ...request, state: "settled" });
      return;
    }
    // Refused (a mint they do not use, for instance): the ecash comes straight back.
    await this.save({ ...payment, error: result.error ?? "The payment was refused" });
    await this.reclaim(payment.id).catch(async () => {
      await this.save({ ...this.payments.get(payment.id)!, state: "failed" });
    });
  }

  /** The mint saw one of our invoices paid: if it was a chat request, tell the contact who paid it. */
  async onQuotePaid(quote: StoredQuote): Promise<void> {
    const request = quote.paymentId ? this.payments.get(quote.paymentId) : undefined;
    if (!request || request.state !== "pending") return;
    await this.save({ ...request, state: "settled", mint: quote.mint });
    this.host.getLink(request.linkId)?.sendPaymentResult({ id: request.id, ok: true });
  }

  // -- internals -------------------------------------------------------------------

  private async sendEcash(
    link: GhostLink,
    params: { linkId: string; amount: number; memo?: string; timestamp: number; requestId?: string; mints?: string[] },
  ): Promise<string> {
    const id = newId();
    const memo = params.memo?.trim().slice(0, 140) || undefined;
    const { token, mint } = await this.wallet.createToken(params.amount, params.mints, memo);

    // Written down before it leaves: from here on the token is the only copy of that money.
    await this.save({
      id,
      linkId: params.linkId,
      kind: "payment",
      direction: "out",
      amount: params.amount,
      unit: UNIT,
      memo,
      state: "pending",
      createdAt: params.timestamp,
      mint,
      token,
      requestId: params.requestId,
    });
    await this.host.storeMessage({
      linkId: params.linkId,
      id: `me_${params.timestamp}`,
      text: `⚡ ${params.amount.toLocaleString()} sats`,
      sender: "me",
      timestamp: params.timestamp,
      via: "datalink",
      paymentId: id,
    });

    try {
      await link.sendPayment({
        id,
        timestamp: params.timestamp,
        requestId: params.requestId,
        amount: { value: String(params.amount), asset: UNIT },
        memo,
        endpoint: [ENDPOINT.cashu, token],
      });
    } catch (error) {
      await this.reclaim(id).catch(() => {});
      throw error;
    }
    return id;
  }

  private requireLink(linkId: string): GhostLink {
    const link = this.host.getLink(linkId);
    if (!link) throw new Error("You are offline");
    return link;
  }

  private async save(payment: StoredPayment): Promise<void> {
    this.payments.set(payment.id, payment);
    await wrap((await store(STORES.payments, "readwrite")).put(payment));
    this.host.onChange();
  }
}
