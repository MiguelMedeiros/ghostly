import { decodeBolt11 } from "@ghostly/core";
import { COMMANDO_NOT_RUN, CommandoClient, CommandoError, CommandoTransportError, type SocketFactory } from "./commando";
import type { InvoiceStatus, LightningInfo, LightningInvoice, LightningPayResult, LightningPaymentRef, LightningPaymentStatus, LightningProvider } from "./lightning";
import { NothingSpentError, type ProviderNetwork } from "./types";

/**
 * Lightning through the person's own Core Lightning node, over Commando (see commando.ts): the browser is
 * a peer of the node for the length of a connection and runs RPC commands with a rune.
 *
 * Why Commando and not CLNRest: it needs nothing from the node but a websocket listener, no TLS
 * certificate the browser trusts, no CORS, and the same code runs on the web, in the extension and on
 * Desktop. The Noise handshake authenticates the node by its public key, so a wss:// proxy in front of it
 * (needed for the web app, which only opens wss://) never sees a rune or a payment.
 */

const PAY_TIMEOUT_S = 60;
const CALL_TIMEOUT_MS = 30_000;
const PAY_CALL_TIMEOUT_MS = (PAY_TIMEOUT_S + 30) * 1000;
const INVOICE_EXPIRY_S = 3600;

const NETWORKS: Record<string, ProviderNetwork> = { bitcoin: "bitcoin", testnet: "testnet", testnet4: "testnet", signet: "signet", regtest: "regtest" };
const HEX64 = /^[0-9a-f]{64}$/;
const msatToSat = (msat: unknown) => {
  const value = typeof msat === "number" ? msat : typeof msat === "string" ? Number(msat.replace(/msat$/, "")) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("The node returned an amount that cannot be read");
  return Math.floor(value / 1000);
};

// -- node replies -------------------------------------------------------------

interface GetInfo { id: string; alias?: string; network: string }
interface Invoice { bolt11?: string; payment_hash: string; expires_at: number; label?: string; status?: string; amount_received_msat?: number }
interface Pay { payment_hash: string; status: "pending" | "complete" | "failed"; amount_msat?: number; amount_sent_msat?: number; preimage?: string }
interface XPayResult { payment_preimage: string; amount_msat: number; amount_sent_msat: number }
interface PayResult { payment_preimage: string; payment_hash: string; status: string; amount_msat: number; amount_sent_msat: number }

/** The small part of a Commando client the provider needs; tests hand in a fake node. */
export interface ClnRpc { call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; filter?: unknown }): Promise<T>; close(): Promise<void> }

export class CoreLightning implements LightningProvider {
  readonly capabilities = { receive: true, send: true, balance: true, lookup: true };

  constructor(private readonly rpc: ClnRpc, private readonly nodeId?: string) {}

  static connect(settings: { url: string; nodeId: string; rune: string }, signal?: AbortSignal, socket?: SocketFactory) {
    return new CoreLightning(new CommandoClient({ ...settings, signal, socket }), settings.nodeId);
  }

  async info(): Promise<LightningInfo> {
    const info = await this.rpc.call<GetInfo>("getinfo", {}, { timeoutMs: CALL_TIMEOUT_MS });
    const network = NETWORKS[info?.network];
    if (!network) throw new Error(`The node is on a network Ghostly does not know (${String(info?.network).slice(0, 20)})`);
    if (this.nodeId && info.id !== this.nodeId) throw new Error("The node answered with another id");
    return { network, alias: typeof info.alias === "string" && info.alias ? info.alias.slice(0, 64) : `${info.id.slice(0, 12)}…`, balance: await this.balance() };
  }

  /** Sats this node can spend over its channels in the normal state (what it holds on its side of them). */
  private async balance() {
    const funds = await this.rpc.call<{ channels?: { state?: string; our_amount_msat?: number }[] }>("listfunds", {}, { timeoutMs: CALL_TIMEOUT_MS, filter: { channels: [{ state: true, our_amount_msat: true }] } });
    return (funds?.channels ?? []).filter((c) => c.state === "CHANNELD_NORMAL").reduce((sum, c) => sum + msatToSat(c.our_amount_msat ?? 0), 0);
  }

  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter an amount in whole sats");
    const label = `ghostly-${crypto.randomUUID()}`;
    const created = await this.rpc.call<Invoice>("invoice", { amount_msat: amount * 1000, label, description: (memo || "Ghostly").slice(0, 200), expiry: INVOICE_EXPIRY_S }, { timeoutMs: CALL_TIMEOUT_MS });
    const decoded = typeof created?.bolt11 === "string" && created.bolt11.length < 8000 ? decodeBolt11(created.bolt11) : null;
    if (!decoded || decoded.paymentHash !== created.payment_hash || decoded.amountSat !== amount) throw new Error("The node returned an invoice that does not match the request");
    return { invoice: decoded.invoice, paymentHash: created.payment_hash, amount, expiresAt: (Number(created.expires_at) || decoded.expiresAt) * 1000, ref: label };
  }

  async invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus> {
    const { invoices } = await this.rpc.call<{ invoices: Invoice[] }>("listinvoices", { payment_hash: invoice.paymentHash }, { timeoutMs: CALL_TIMEOUT_MS });
    const found = (invoices ?? []).find((i) => i.payment_hash === invoice.paymentHash);
    if (!found) throw new Error("The node does not know this invoice");
    if (found.status === "paid") return { state: "paid", amount: msatToSat(found.amount_received_msat ?? invoice.amount * 1000) };
    if (found.status === "expired") return { state: "expired" };
    return { state: "open" };
  }

  /**
   * xpay (Core Lightning 24.11+), or pay on a node without it. When the node answers with an error, the
   * command has ended; its own record of the payment hash (`listpays`) then says whether anything is still
   * out. Only when nothing is (no attempt, or every attempt failed back) is it NothingSpentError.
   */
  async payInvoice(invoice: string, maxFee: number): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    if (!decoded?.paymentHash || decoded.amountSat === null) throw new NothingSpentError("That invoice cannot be paid from a Core Lightning source (no amount or no hash)");
    if (!Number.isSafeInteger(maxFee) || maxFee < 0) throw new NothingSpentError("Invalid fee limit");
    const hash = decoded.paymentHash;
    try {
      let paid: XPayResult | PayResult;
      try {
        paid = await this.rpc.call<XPayResult>("xpay", { invstring: decoded.invoice, maxfee: maxFee * 1000, retry_for: PAY_TIMEOUT_S }, { timeoutMs: PAY_CALL_TIMEOUT_MS });
      } catch (error) {
        // xpay never ran (an older node, or a rune that allows only pay): pay instead.
        if (!(error instanceof CommandoError) || !(error.code === COMMANDO_NOT_RUN.unknownMethod || error.code === COMMANDO_NOT_RUN.notAuthorized)) throw error;
        const viaPay = await this.rpc.call<PayResult>("pay", { bolt11: decoded.invoice, maxfee: maxFee * 1000, retry_for: PAY_TIMEOUT_S }, { timeoutMs: PAY_CALL_TIMEOUT_MS });
        if (viaPay?.status && viaPay.status !== "complete") return { state: "pending", ref: hash };
        paid = viaPay;
      }
      const sent = msatToSat(paid.amount_sent_msat), amount = msatToSat(paid.amount_msat);
      return { state: "paid", fee: Math.max(0, sent - amount), preimage: typeof paid.payment_preimage === "string" ? paid.payment_preimage : undefined, ref: hash };
    } catch (error) {
      if (error instanceof CommandoError) {
        if (error.code === COMMANDO_NOT_RUN.unknownMethod || error.code === COMMANDO_NOT_RUN.notAuthorized) throw new NothingSpentError(`The rune does not allow paying: ${error.message}`);
        // The node's final answer. Its record of the hash decides: something out is pending, not failed.
        const status = await this.lookup(hash).catch(() => undefined);
        if (status?.state === "paid") return { state: "paid", fee: status.fee, preimage: status.preimage, ref: hash };
        if (status?.state === "pending") return { state: "pending", ref: hash };
        if (status) throw new NothingSpentError(error.message);
        // The node could not be asked what happened: an unknown outcome, reconciled later.
        throw error;
      }
      if (error instanceof CommandoTransportError && !error.sent) throw new NothingSpentError(error.message);
      // No answer: the payment may be under way. Say pending when the node already shows it.
      const status = await this.lookup(hash).catch(() => undefined);
      if (status?.state === "paid") return { state: "paid", fee: status.fee, preimage: status.preimage, ref: hash };
      if (status?.state === "pending") return { state: "pending", ref: hash };
      throw error;
    }
  }

  async paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus> {
    const status = await this.lookup(payment.paymentHash);
    if (status.state !== "none") return status;
    // The node has no attempt at all. Until the invoice expires a lost request could still start one, so
    // it is not called failed before then.
    const expiresAt = decodeBolt11(payment.invoice)?.expiresAt ?? 0;
    return { state: expiresAt * 1000 < Date.now() ? "failed" : "pending" };
  }

  /** What the node's own record of this payment hash says: `none` when it never tried. */
  private async lookup(paymentHash: string): Promise<LightningPaymentStatus | { state: "none" }> {
    if (!HEX64.test(paymentHash)) throw new Error("Invalid payment hash");
    const { pays } = await this.rpc.call<{ pays: Pay[] }>("listpays", { payment_hash: paymentHash }, { timeoutMs: CALL_TIMEOUT_MS });
    const mine = (pays ?? []).filter((p) => p.payment_hash === paymentHash);
    const complete = mine.find((p) => p.status === "complete");
    if (complete) {
      const fee = complete.amount_sent_msat !== undefined && complete.amount_msat !== undefined ? Math.max(0, msatToSat(complete.amount_sent_msat) - msatToSat(complete.amount_msat)) : undefined;
      return { state: "paid", fee, preimage: complete.preimage };
    }
    if (mine.some((p) => p.status === "pending")) return { state: "pending" };
    return mine.length ? { state: "failed" } : { state: "none" };
  }

  async close() { await this.rpc.close(); }
}