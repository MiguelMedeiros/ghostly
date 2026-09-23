import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11 } from "@ghostly/core";
import type { ListPaymentsRequest, Payment, PrepareSendPaymentRequest, PrepareSendPaymentResponse, ReceivePaymentRequest, SendPaymentRequest } from "@breeztech/breez-sdk-spark/web";
import type { BreezConnect, BreezSdkModule, BreezWallet } from "../../src/engine/paymentAdapters/providers/breezSdk";
import { fakeInvoice } from "../../src/engine/paymentAdapters/providers/testing";

/**
 * A stand-in for the Breez SDK (its WebAssembly does not need to run in unit tests): wallets in memory
 * on one "network", where one wallet pays another's invoice by its hash, the way two Spark wallets
 * would. `send` drives what `sendPayment` does:
 *  - complete: paid at once.
 *  - pending:  in flight; `settle(hash)` or `fail(hash)` ends it later.
 *  - throw:    the answer is lost after the payment went out (it is in the history).
 *  - fail:     the SDK gives up at once (status failed, the sats come back).
 */
export type FakeSend = "complete" | "pending" | "throw" | "fail";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export class FakeBreezNetwork {
  readonly wallets = new Map<string, FakeBreezWallet>();
  /** Invoices by payment hash: who gets paid, and the preimage that proves it. */
  readonly invoices = new Map<string, { wallet: FakeBreezWallet; preimage: string; amount: number }>();
  readonly connects: BreezConnect[] = [];

  /** The module `BreezLightning.connect` loads: one wallet per storage, as the SDK keeps one per database. */
  readonly sdk: BreezSdkModule = {
    connect: async (params) => {
      this.connects.push(params);
      let wallet = this.wallets.get(params.storage);
      if (!wallet) this.wallets.set(params.storage, wallet = new FakeBreezWallet(this));
      wallet.disconnected = false;
      return wallet;
    },
  };

  /** Someone outside pays this invoice (a counterpart node). */
  payFromOutside(invoice: string) {
    const hash = decodeBolt11(invoice)!.paymentHash!;
    const entry = this.invoices.get(hash);
    if (!entry) throw new Error("No such fake invoice");
    entry.wallet.credit(hash, entry.amount, entry.preimage, invoice);
  }
}

export class FakeBreezWallet implements BreezWallet {
  balance = 0;
  send: FakeSend = "complete";
  fee = 2;
  disconnected = false;
  readonly payments: Payment[] = [];
  readonly sent: SendPaymentRequest[] = [];
  readonly calls: string[] = [];
  private readonly keys = new Map<string, Payment>();
  constructor(private readonly network: FakeBreezNetwork) {}

  credit(hash: string, amount: number, preimage: string, invoice: string) {
    if (this.payments.some((p) => p.paymentType === "receive" && p.details?.type === "lightning" && p.details.htlcDetails.paymentHash === hash)) return;
    this.balance += amount;
    this.payments.unshift(this.payment("receive", "completed", amount, 0, hash, invoice, preimage));
  }

  private payment(type: "send" | "receive", status: Payment["status"], amount: number, fees: number, paymentHash: string, invoice: string, preimage?: string): Payment {
    return { id: hex(random(16)), paymentType: type, status, amount: BigInt(amount), fees: BigInt(fees), timestamp: Math.floor(Date.now() / 1000), method: "lightning",
      details: { type: "lightning", invoice, destinationPubkey: "02".padEnd(66, "0"), htlcDetails: { paymentHash, preimage, expiryTime: 0, status: status === "completed" ? "preimageShared" : status === "failed" ? "returned" : "waitingForPreimage" } } };
  }

  async getInfo() { this.calls.push("getInfo"); return { identityPubkey: "02".padEnd(66, "1"), balanceSats: this.balance, tokenBalances: new Map() }; }

  async receivePayment(request: ReceivePaymentRequest) {
    this.calls.push("receivePayment");
    const method = request.paymentMethod;
    if (method.type !== "bolt11Invoice" || !method.amountSats) throw new Error("The fake only makes invoices with an amount");
    const preimage = random(32), hash = sha256(preimage);
    const invoice = fakeInvoice(method.amountSats, hash, method.description, method.expirySecs ?? 3600);
    this.network.invoices.set(hex(hash), { wallet: this, preimage: hex(preimage), amount: method.amountSats });
    return { paymentRequest: invoice, fee: 0n };
  }

  async prepareSendPayment(request: PrepareSendPaymentRequest): Promise<PrepareSendPaymentResponse> {
    this.calls.push("prepareSendPayment");
    const input = request.paymentRequest.type === "input" ? request.paymentRequest.input : "";
    const decoded = decodeBolt11(input);
    if (!decoded?.paymentHash || decoded.amountSat === null) throw new Error("invalid input");
    return {
      paymentMethod: { type: "bolt11Invoice", lightningFeeSats: this.fee, invoiceDetails: { amountMsat: decoded.amountSat * 1000, expiry: 3600, invoice: { bolt11: decoded.invoice, source: {} }, minFinalCltvExpiryDelta: 18, network: "regtest", payeePubkey: "", paymentHash: decoded.paymentHash, paymentSecret: "", routingHints: [], timestamp: decoded.createdAt } },
      amount: BigInt(decoded.amountSat), feePolicy: "feesExcluded",
    } as PrepareSendPaymentResponse;
  }

  async sendPayment(request: SendPaymentRequest) {
    this.calls.push("sendPayment");
    this.sent.push(request);
    const again = request.idempotencyKey ? this.keys.get(request.idempotencyKey) : undefined;
    if (again) return { payment: again };
    const method = request.prepareResponse.paymentMethod;
    if (method.type !== "bolt11Invoice") throw new Error("not a bolt11 payment");
    const amount = Number(request.prepareResponse.amount), hash = method.invoiceDetails.paymentHash;
    if (this.balance < amount + this.fee) throw new Error("insufficient funds");
    this.balance -= amount + this.fee;
    const payee = this.network.invoices.get(hash);
    const status = this.send === "fail" ? "failed" : this.send === "pending" ? "pending" : "completed";
    const payment = this.payment("send", status, amount, this.fee, hash, method.invoiceDetails.invoice.bolt11, status === "completed" ? payee?.preimage ?? hex(random(32)) : undefined);
    if (status === "failed") this.balance += amount + this.fee;
    if (status === "completed") payee?.wallet.credit(hash, amount, payee.preimage, method.invoiceDetails.invoice.bolt11);
    this.payments.unshift(payment);
    if (request.idempotencyKey) this.keys.set(request.idempotencyKey, payment);
    if (this.send === "throw") throw new Error("connection lost");
    return { payment };
  }

  /** A pending payment of ours ends. */
  settle(hash: string) { const p = this.sentFor(hash); p.status = "completed"; const payee = this.network.invoices.get(hash); if (p.details?.type === "lightning") p.details.htlcDetails.preimage = payee?.preimage; if (payee && p.details?.type === "lightning") payee.wallet.credit(hash, Number(p.amount), payee.preimage, p.details.invoice); }
  fail(hash: string) { const p = this.sentFor(hash); p.status = "failed"; this.balance += Number(p.amount + p.fees); }
  private sentFor(hash: string) { const p = this.payments.find((x) => x.paymentType === "send" && x.details?.type === "lightning" && x.details.htlcDetails.paymentHash === hash); if (!p) throw new Error("no such payment"); return p; }

  async getPayment({ paymentId }: { paymentId: string }) {
    const payment = this.payments.find((p) => p.id === paymentId);
    if (!payment) throw new Error("payment not found");
    return { payment };
  }

  async listPayments(request: ListPaymentsRequest) {
    this.calls.push("listPayments");
    let list = this.payments.filter((p) => (!request.typeFilter || request.typeFilter.includes(p.paymentType)) && (request.fromTimestamp === undefined || p.timestamp >= request.fromTimestamp));
    if (request.sortAscending) list = [...list].reverse();
    const offset = request.offset ?? 0;
    return { payments: list.slice(offset, offset + (request.limit ?? list.length)) };
  }

  async syncWallet() { this.calls.push("syncWallet"); return {}; }
  async disconnect() { this.calls.push("disconnect"); this.disconnected = true; }
}
