import { sha256 } from "@noble/hashes/sha2.js";
import { bech32m } from "@scure/base";
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
 *
 * Spark: every wallet has an identity key and a real-format Spark address (`sparkrt1…`, bech32m); invoices are
 * that key plus a random id. A Spark send to an address or invoice of another fake wallet is a transfer between
 * the two. `keyIsId` mimics the SDK naming a transfer after its idempotency key.
 */
export type FakeSend = "complete" | "pending" | "throw" | "fail";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export class FakeBreezNetwork {
  readonly wallets = new Map<string, FakeBreezWallet>();
  /** Invoices by payment hash: who gets paid, and the preimage that proves it. */
  readonly invoices = new Map<string, { wallet: FakeBreezWallet; preimage: string; amount: number }>();
  readonly connects: BreezConnect[] = [];
  /** Spark invoices by their text: who is paid, for how much, until when, and whether one paid it. */
  readonly sparkInvoices = new Map<string, { wallet: FakeBreezWallet; amount?: number; memo?: string; expiry?: number }>();
  keyIsId = true;

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

  /** The wallet whose Spark address or invoice this is. */
  sparkPayee(input: string): FakeBreezWallet | undefined {
    return this.sparkInvoices.get(input)?.wallet ?? [...this.wallets.values()].find((w) => w.sparkAddress === input);
  }
  /** A payment from outside Ghostly (a funded counterpart) to a Spark address or invoice. */
  paySparkFromOutside(input: string, amount: number) {
    const payee = this.sparkPayee(input);
    if (!payee) throw new Error("No such fake Spark address");
    payee.creditSpark(amount, this.sparkInvoices.has(input) ? input : undefined, this.sparkInvoices.get(input)?.memo);
  }
}

const varint = (n: number) => { const out: number[] = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n = Math.floor(n / 128); } while (n); return out; };
const field = (n: number, bytes: number[]) => [(n << 3) | 2, ...varint(bytes.length), ...bytes];
/** An address (the key), or an invoice as Spark writes one: 2 id, 4 sats payment, 5 memo, 7 expiry. */
const sparkString = (key: Uint8Array, invoice?: { amount?: number; memo?: string; expiry?: number }) => {
  const fields = invoice ? [...field(2, [...random(16)]), ...(invoice.amount !== undefined ? field(4, [0x08, ...varint(invoice.amount)]) : []),
    ...(invoice.memo ? field(5, [...new TextEncoder().encode(invoice.memo)]) : []), ...(invoice.expiry ? field(7, [0x08, ...varint(invoice.expiry)]) : [])] : undefined;
  return bech32m.encode("sparkrt", bech32m.toWords(Uint8Array.from([0x0a, 0x21, ...key, ...(fields ? field(2, fields) : [])])), 1024);
};

export class FakeBreezWallet implements BreezWallet {
  balance = 0;
  send: FakeSend = "complete";
  fee = 2;
  disconnected = false;
  readonly payments: Payment[] = [];
  readonly sent: SendPaymentRequest[] = [];
  readonly calls: string[] = [];
  private readonly keys = new Map<string, Payment>();
  /** Spark sends end like this (Lightning sends follow `send`). */
  sparkSend: FakeSend = "complete";
  sparkFee = 0;
  readonly identity = Uint8Array.from([0x02, ...random(32)]);
  readonly sparkAddress = sparkString(this.identity);
  constructor(private readonly network: FakeBreezNetwork) {}

  /** The payee's record of a transfer carries the transfer's id, the same the payer's has (as on Spark). */
  creditSpark(amount: number, invoice?: string, memo?: string, id: string = crypto.randomUUID()) {
    this.balance += amount;
    this.payments.unshift({ id, paymentType: "receive", status: "completed", amount: BigInt(amount), fees: 0n, timestamp: Math.floor(Date.now() / 1000), method: "spark",
      details: { type: "spark", ...(invoice ? { invoiceDetails: { invoice, description: memo } } : {}) } });
  }

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
    if (method.type === "sparkAddress") return { paymentRequest: this.sparkAddress, fee: 0n };
    if (method.type === "sparkInvoice") {
      const details = { amount: method.amount ? Number(method.amount) : undefined, memo: method.description, expiry: method.expiryTime };
      const invoice = sparkString(this.identity, details);
      this.network.sparkInvoices.set(invoice, { wallet: this, ...details });
      return { paymentRequest: invoice, fee: 0n };
    }
    if (method.type !== "bolt11Invoice" || !method.amountSats) throw new Error("The fake only makes invoices with an amount");
    const preimage = random(32), hash = sha256(preimage);
    const invoice = fakeInvoice(method.amountSats, hash, method.description, method.expirySecs ?? 3600);
    this.network.invoices.set(hex(hash), { wallet: this, preimage: hex(preimage), amount: method.amountSats });
    return { paymentRequest: invoice, fee: 0n };
  }

  async prepareSendPayment(request: PrepareSendPaymentRequest): Promise<PrepareSendPaymentResponse> {
    this.calls.push("prepareSendPayment");
    const input = request.paymentRequest.type === "input" ? request.paymentRequest.input : "";
    if (input.startsWith("sparkrt1")) {
      const invoice = this.network.sparkInvoices.get(input);
      if (!invoice && !this.network.sparkPayee(input) && !/^sparkrt1/.test(input)) throw new Error("invalid input");
      if (invoice) {
        if (request.amount !== undefined && invoice.amount !== undefined) throw new Error("amount given for an invoice that has one");
        const amount = invoice.amount ?? Number(request.amount);
        return { paymentMethod: { type: "sparkInvoice", fee: String(this.sparkFee), sparkInvoiceDetails: { invoice: input, identityPublicKey: hex(invoice.wallet.identity), network: "regtest", amount: invoice.amount === undefined ? undefined : String(invoice.amount), expiryTime: invoice.expiry, description: invoice.memo } },
          amount: BigInt(amount), feePolicy: "feesExcluded" } as PrepareSendPaymentResponse;
      }
      if (request.amount === undefined) throw new Error("an amount is needed for a Spark address");
      return { paymentMethod: { type: "sparkAddress", address: input, fee: String(this.sparkFee) }, amount: request.amount, feePolicy: "feesExcluded" } as PrepareSendPaymentResponse;
    }
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
    if (method.type === "sparkAddress" || method.type === "sparkInvoice") return this.sendSpark(request);
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

  private sendSpark(request: SendPaymentRequest) {
    const method = request.prepareResponse.paymentMethod;
    const to = method.type === "sparkAddress" ? method.address : method.type === "sparkInvoice" ? method.sparkInvoiceDetails.invoice : "";
    const amount = Number(request.prepareResponse.amount), fee = this.sparkFee;
    if (this.balance < amount + fee) throw new Error("insufficient funds");
    const status = this.sparkSend === "fail" ? "failed" : this.sparkSend === "pending" ? "pending" : "completed";
    const invoice = method.type === "sparkInvoice" ? to : undefined;
    const payment: Payment = { id: this.network.keyIsId && request.idempotencyKey ? request.idempotencyKey : crypto.randomUUID(), paymentType: "send", status, amount: BigInt(amount), fees: BigInt(fee),
      timestamp: Math.floor(Date.now() / 1000), method: "spark", details: { type: "spark", ...(invoice ? { invoiceDetails: { invoice } } : {}) } };
    if (status !== "failed") this.balance -= amount + fee;
    if (status === "completed") this.network.sparkPayee(to)?.creditSpark(amount, invoice, invoice ? this.network.sparkInvoices.get(invoice)?.memo : undefined, payment.id);
    this.payments.unshift(payment);
    if (request.idempotencyKey) this.keys.set(request.idempotencyKey, payment);
    if (this.sparkSend === "throw") throw new Error("connection lost");
    return { payment };
  }
  /** A pending Spark send of ours completes (the payee gets it). */
  settleSpark(id: string) {
    const p = this.payments.find((x) => x.id === id && x.method === "spark" && x.paymentType === "send");
    if (!p) throw new Error("no such payment");
    p.status = "completed";
    const invoice = p.details?.type === "spark" ? p.details.invoiceDetails?.invoice : undefined;
    if (invoice) this.network.sparkPayee(invoice)?.creditSpark(Number(p.amount), invoice, undefined, p.id);
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
