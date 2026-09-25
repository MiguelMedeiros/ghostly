import { decodeBolt11, isFederationId } from "@ghostly/core";
import { FEDIMINT_MAINNET, type FedimintWallet } from "../fedimintWallet";
import type { LightningInvoice, LightningPaymentRef, LightningPaymentStatus, LightningPayResult, LightningProvider, LightningProviderDescriptor } from "./lightning";
import { NothingSpentError, PROVIDER_PLATFORMS, SourceConfigError, SourceUnreachableError, isNothingSpentError, type ProviderNetwork } from "./types";

export const FEDIMINT_SOURCE = "fedimint";
/** How long an invoice made here stays payable. */
const INVOICE_SECS = 60 * 60;
interface Ref { op: string; internal?: boolean }
const refOf = (ref: string | undefined): Ref => {
  const parsed = JSON.parse(ref ?? "null") as Ref | null;
  if (!parsed?.op) throw new Error("Unknown Fedimint operation");
  return parsed;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** What the client says before any contract is funded: nothing left the wallet. */
const BEFORE_FUNDING = /insufficient|not enough|no gateway|no available gateway|expired|invalid|amount|already paid|parse|decode/i;

/**
 * Lightning through a federation's gateway: an invoice is paid into the federation as ecash of this wallet, and an
 * invoice is paid from that ecash, the gateway routing it (for its fee). The federation's ecash wallet (the
 * Fedimint card) is the balance; this source only picks which federation Lightning goes through.
 *
 * Paying funds a contract the gateway claims when it pays; a gateway that cannot pay gives it back (refunded, after
 * a time-out). A payment to an invoice of the same federation never touches Lightning: the federation swaps it
 * internally, with no gateway fee.
 */
export class FedimintLightning implements LightningProvider {
  readonly capabilities = { receive: true, send: true, balance: true, lookup: true };
  constructor(private readonly wallet: FedimintWallet, readonly federationId: string) {}

  private client() {
    try { return this.wallet.client(this.federationId); }
    catch (error) { throw new SourceUnreachableError(message(error), error); }
  }

  async info() {
    const federation = this.wallet.federation(this.federationId);
    if (!federation?.network) throw new SourceConfigError("You have not joined this federation in this wallet mode");
    if (!federation.modules.includes("ln")) throw new SourceConfigError(`${federation.name ?? "This federation"} has no Lightning gateway module`);
    const balance = Math.floor(await this.client().balance() / 1000);
    return { network: federation.network, alias: federation.name ?? `Federation ${this.federationId.slice(0, 8)}`, balance };
  }

  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    const { invoice, operationId } = await this.wallet.createInvoice(this.federationId, amount, memo ?? "", undefined, INVOICE_SECS);
    const decoded = decodeBolt11(invoice);
    if (!decoded?.paymentHash) throw new Error("The federation's gateway made an invoice that cannot be read");
    return { invoice, paymentHash: decoded.paymentHash, amount, expiresAt: decoded.expiresAt * 1000, ref: JSON.stringify({ op: operationId } satisfies Ref) };
  }

  async invoiceStatus(invoice: LightningInvoice) {
    const state = await this.client().receiveState(refOf(invoice.ref).op, 1_500);
    if (state === "claimed") return { state: "paid" as const, amount: invoice.amount };
    if (state === "canceled") return { state: "expired" as const };
    return { state: invoice.expiresAt < Date.now() ? "expired" as const : "open" as const };
  }

  /** The gateway's own fee for this amount; paying an invoice of the same federation costs none. */
  async estimateFee(_invoice: string, amount: number) {
    const fee = await this.client().gatewayFee(amount * 1000);
    if (fee === undefined) throw new Error("This federation has no Lightning gateway online");
    return Math.ceil(fee / 1000);
  }

  async payInvoice(invoice: string, maxFee: number, note?: string): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    const amount = decoded?.amountMsat ? Math.ceil(Number(decoded.amountMsat) / 1000) : 0;
    let paid: { operationId: string; feeMsats: number; internal: boolean };
    try {
      if (!amount) throw new Error("Invoices without an amount are not supported");
      const fee = await this.estimateFee(invoice, amount);
      if (fee > maxFee) throw new Error(`The gateway's fee (${fee} sats) is above your maximum`);
      const balance = Math.floor(await this.client().balance() / 1000);
      if (balance < amount + fee) throw new Error(`Not enough in this federation (${balance.toLocaleString()} sats; ${(amount + fee).toLocaleString()} needed)`);
    } catch (error) { throw isNothingSpentError(error) ? error : new NothingSpentError(message(error)); }
    try {
      paid = await this.client().payInvoice(invoice, note?.slice(0, 64) ?? "lightning");
    } catch (error) {
      // Refused before a contract was funded: nothing left. Anything else may have.
      if (BEFORE_FUNDING.test(message(error))) throw new NothingSpentError(message(error));
      throw error;
    }
    const ref = JSON.stringify({ op: paid.operationId, internal: paid.internal } satisfies Ref);
    const outcome = await this.client().payState(paid.operationId, paid.internal, 30_000).catch(() => ({ state: "pending" as const, preimage: undefined }));
    // A gateway that could not pay gives the sats back: that is for `paymentStatus` to say, never "failed" here.
    if (outcome.state === "paid") return { state: "paid", fee: Math.ceil(paid.feeMsats / 1000), preimage: outcome.preimage, ref };
    return { state: "pending", ref };
  }

  async paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus> {
    const ref = refOf(payment.ref);
    const outcome = await this.client().payState(ref.op, !!ref.internal, 1_500);
    return { state: outcome.state, preimage: outcome.preimage };
  }

  async close() { /* the client belongs to the Fedimint wallet, which stays open */ }
}

export const FEDIMINT_NETWORKS: readonly ProviderNetwork[] = FEDIMINT_MAINNET ? ["bitcoin", "signet", "testnet", "regtest", "mutinynet"] : ["signet", "testnet", "regtest", "mutinynet"];

export const fedimint: LightningProviderDescriptor = {
  id: FEDIMINT_SOURCE,
  label: "Fedimint",
  kind: "lightning",
  description: "A federation you joined (Wallet → Fedimint): invoices are paid into, and from, its ecash through its gateway. Its guardians hold the sats.",
  networks: FEDIMINT_NETWORKS,
  platforms: PROVIDER_PLATFORMS,
  fields: [{ name: "federation", label: "Federation", kind: "text", placeholder: "federation id", help: "One of the federations you joined, by its id." }],
  custodial: true,
  experimental: true,
  validate({ config }) { if (!isFederationId(config.federation?.trim().toLowerCase())) throw new Error("Pick one of the federations you joined"); },
  async create({ config }, host) {
    const wallet = host.fedimint as FedimintWallet | undefined;
    if (!wallet) throw new SourceConfigError("This app has no Fedimint wallet");
    const id = config.federation.trim().toLowerCase();
    if (!wallet.federation(id)) throw new SourceConfigError("You have not joined this federation in this wallet mode");
    return new FedimintLightning(wallet, id);
  },
};
