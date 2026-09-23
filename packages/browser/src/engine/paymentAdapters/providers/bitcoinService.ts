import { ONCHAIN_PROVIDER, PaymentPreflightError, assertWholeSats, validatePaymentTarget, type PaymentAdapter, type PaymentExecution, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import type { WalletMode } from "../../../shared/mints";
import type { OnchainPrepared, OnchainProvider, OnchainProviderDescriptor, OnchainTx } from "./onchain";
import { intentRepository } from "../persistence";
import { ProviderSources, type SourceView } from "./sources";
import { NothingSpentError, redact, type ProviderHost } from "./types";

export interface BitcoinView extends SourceView {
  /** The last address handed out to be paid on. */
  address?: string;
  /** Newest first. */
  history: OnchainTx[];
}
/** A prepared on-chain payment remembers which source signed it: only that source may broadcast it. */
export type BitcoinPrepared = OnchainPrepared & { providerId: string };

/**
 * On-chain Bitcoin for the whole engine: the Bitcoin card and the "bitcoin" payment method, through the
 * active on-chain source of the wallet mode in use. There is none until one is set up.
 */
export class BitcoinService {
  readonly sources: ProviderSources<OnchainProvider>;
  private address?: string;
  private history: OnchainTx[] = [];

  constructor(descriptors: () => readonly OnchainProviderDescriptor[], host: () => Omit<ProviderHost, "mode" | "signal">, changed: () => void) {
    this.sources = new ProviderSources<OnchainProvider>({
      kind: "onchain", descriptors, host, changed: () => { if (!this.sources.active) { this.address = undefined; this.history = []; } changed(); },
      // Only the source that signed a transaction can say what became of it (and re-broadcast it).
      refuseReplacing: async (providerId) => {
        const open = (await intentRepository.list()).filter(({ review, prepared }) => review.method === "bitcoin" && ["pending", "submitted", "unknown"].includes(review.state) && (prepared as BitcoinPrepared | undefined)?.providerId === providerId);
        return open.length ? `A Bitcoin payment through this source is not confirmed or cancelled yet (${open.length}). Settle it before changing the source.` : undefined;
      },
      refresh: async (provider) => {
        const [balance, history] = await Promise.all([provider.balance(), provider.history(20).catch(() => this.history)]);
        if (provider === this.sources.active) this.history = history;
        return { balance: balance.confirmed, unconfirmed: balance.unconfirmed };
      },
    });
  }

  get view(): BitcoinView { return { ...this.sources.view, address: this.address, history: this.history }; }
  start(mode: WalletMode) { return this.sources.start(mode); }
  setMode(mode: WalletMode) { this.address = undefined; this.history = []; return this.sources.setMode(mode); }
  ensureReady() { return this.sources.ensureReady(); }
  stop() { return this.sources.stop(); }

  async receiveAddress(): Promise<string> {
    const { provider } = await this.sources.use();
    const { network } = await provider.info();
    const address = await provider.receiveAddress();
    // Checked like an address a contact would pay: a wrong-network address is never shown.
    this.target(address, network);
    this.address = address;
    return address;
  }

  /** Where to be paid on-chain, as a chat request would carry it. */
  async requestTarget(): Promise<PaymentTarget> {
    const { provider } = await this.sources.use();
    return this.target(await provider.receiveAddress(), (await provider.info()).network);
  }

  private target(address: string, network: string): PaymentTarget {
    // Throws on an address that is not of this network.
    return validatePaymentTarget({ method: "bitcoin", network, provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 15 * 60 * 1000 });
  }

  readonly adapter: PaymentAdapter<BitcoinPrepared> = {
    method: "bitcoin",
    prepare: async (target, amount, feeCap) => {
      assertWholeSats(amount);
      const { provider, descriptor } = await this.sources.use();
      const { network } = await provider.info();
      if (target.method !== "bitcoin" || target.network !== network) throw new Error(`Your Bitcoin source is on ${network}, not ${target.network}`);
      const prepared = await provider.prepareSend({ address: target.address, amount, feeCap });
      // The review is of this exact transaction: what the source built must be what was asked.
      if (prepared.address !== target.address || prepared.amount !== amount || !Number.isSafeInteger(prepared.fee) || prepared.fee < 0 || prepared.fee > feeCap || !/^[0-9a-f]{64}$/.test(prepared.txid)) throw new Error("The prepared transaction does not match your review");
      return { fee: prepared.fee, prepared: { ...prepared, providerId: descriptor.id } };
    },
    execute: async (review, prepared) => {
      this.check(review, prepared);
      const provider = this.sources.active;
      // Nothing has been broadcast yet: a source that changed (or is not connected) means a clean failure.
      if (!provider || this.sources.activeId !== prepared.providerId) throw new PaymentPreflightError("The Bitcoin source that prepared this payment is not connected. Nothing was sent.");
      let txid: string;
      try { txid = await provider.broadcast(prepared); }
      catch (error) { if (error instanceof NothingSpentError) throw new PaymentPreflightError(redact(error)); throw error; }
      if (txid !== prepared.txid) throw new Error("The source broadcast a different transaction than the one reviewed");
      void this.sources.refresh();
      return { txid, settled: false, pending: true };
    },
    reconcile: async (review, prepared): Promise<PaymentExecution> => {
      this.check(review, prepared);
      const provider = this.sources.active;
      if (!provider || this.sources.activeId !== prepared.providerId) throw new Error("The Bitcoin source of this payment is not connected");
      const status = await provider.status(prepared);
      if (status.state === "confirmed" && status.confirmations > 0) return { txid: prepared.txid, settled: true };
      if (status.state === "conflicted") return { txid: prepared.txid, settled: false, failed: true, error: "Another transaction spent these coins: this payment can never confirm" };
      // Dropped or never arrived: the same signed transaction again. The same inputs cannot pay twice.
      if (status.state === "missing") await provider.broadcast(prepared).catch(() => {});
      return { txid: prepared.txid, settled: false, pending: true };
    },
    release: async (_review, prepared) => {
      if (this.sources.activeId === prepared.providerId) await this.sources.active?.release?.(prepared);
    },
  };

  private check(review: PaymentReview, prepared: BitcoinPrepared) {
    if (review.method !== "bitcoin" || prepared.address !== review.address || prepared.amount !== review.amount || prepared.fee !== review.fee || prepared.fee > review.feeCap) throw new PaymentPreflightError("Prepared payment does not match the approved review");
  }
}
