import { PaymentPreflightError, assertWholeSats, validatePaymentTarget, type PaymentAdapter, type PaymentExecution, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { loadBarkSdk, type BarkBalance, type BarkMovement, type BarkNetwork, type BarkOnchainHandle, type BarkSdk, type BarkWalletHandle } from "./barkSdk";

export interface BarkConfig { network: BarkNetwork; provider: string; explorer: string; serverKey: string; walletId: string }
/** What a review approved: nothing is signed before approval, and the send itself is one call to the SDK. */
export interface BarkPrepared { address: string; amount: number; fee: number; after: number }
export const BARK_NETWORKS: BarkNetwork[] = ["bitcoin", "signet", "regtest"];
const SDK_NETWORK: Record<BarkNetwork, string> = { bitcoin: "Bitcoin", signet: "Signet", regtest: "Regtest" };
/** Bark addresses are bech32m with `ark` on Bitcoin and `tark` on the test networks: real and test money never share one. */
export const barkAddressPrefix = (network: BarkNetwork) => network === "bitcoin" ? "ark1" : "tark1";
/** The coin expiry the wallet page shows: blocks until the first coin expires, and a coin's whole life on this server. */
export interface BarkExpiry { blocksLeft?: number; lifetime?: number }

/** Movement addresses are JSON `{"type":"ark","value":…}`; older builds give the bare address. */
const addressOf = (entry: string) => { try { const parsed = JSON.parse(entry); return typeof parsed?.value === "string" ? parsed.value : entry; } catch { return entry; } };
const outputTxid = (m: BarkMovement) => m.outputVtxoIds.map((id) => id.split(":")[0]).find((txid) => /^[a-f0-9]{64}$/.test(txid));
export const barkDatabase = (walletId: string) => `ghostly-bark-${walletId}`;
/** How long a wallet just opened is given to reach its server, per attempt (tests shorten it). */
export const barkTiming = { serverWaitMs: 1000 };
/** What the server says it is. A wallet just opened has not reached it yet: ask it to, and wait a little. */
export async function serverInfo(wallet: BarkWalletHandle, attempts = 10): Promise<{ network: string; serverPubkey: string; vtxoLifetime?: number }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const info = await wallet.arkInfo();
    if (info) return info;
    await wallet.refreshServer().catch(() => {});
    if (attempt) await new Promise((resolve) => setTimeout(resolve, barkTiming.serverWaitMs));
  }
  throw new Error("The Bark server is not answering");
}

/**
 * Second's Ark, through its SDK. Payments go only to addresses of this wallet's own server (Bark cannot pay an
 * Arkade address, nor one of another Bark server); the server key is pinned when the wallet is made.
 */
export class BarkAdapter implements PaymentAdapter<BarkPrepared> {
  readonly method = "bark" as const;
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
  /** Calls that do not wait for the queue (reads, sync, maintenance): the wallet is freed only once none is running. */
  private running = new Set<Promise<unknown>>();
  private closed = false;
  private freed = false;
  private outside<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("This Bark wallet is closed"));
    const call = run();
    this.running.add(call);
    const done = () => { this.running.delete(call); this.freeWhenIdle(); };
    call.then(done, done);
    return call;
  }
  private freeWhenIdle() {
    if (!this.closed || this.freed || this.running.size) return;
    this.freed = true;
    this.wallet.free(); this.onchain.free();
  }
  private constructor(readonly config: BarkConfig, private sdk: BarkSdk, private wallet: BarkWalletHandle, private onchain: BarkOnchainHandle) {}

  static async connect(config: BarkConfig, mnemonic: string, options: { sdk?: BarkSdk; restore?: boolean } = {}): Promise<BarkAdapter> {
    BarkAdapter.checkConfig(config);
    const sdk = options.sdk ?? await loadBarkSdk();
    const { wallet, onchain } = await sdk.open({ network: config.network, mnemonic, server: config.provider, esplora: config.explorer, database: barkDatabase(config.walletId) });
    const adapter = new BarkAdapter(config, sdk, wallet, onchain);
    try { await adapter.checkServer(); } catch (error) { await adapter.dispose(); throw error; }
    // A phrase restored here may have used on-chain addresses before: look for them once.
    if (options.restore) void onchain.initialScan().catch(() => {});
    return adapter;
  }
  static checkConfig(config: Pick<BarkConfig, "network" | "provider" | "explorer">) {
    if (!BARK_NETWORKS.includes(config.network)) throw new Error("Unsupported Bark network");
    for (const provider of [config.provider, config.explorer]) validatePaymentTarget({ method: "bark", network: config.network, provider, asset: "BTC", unit: "sat", address: "configuration", expiresAt: Date.now() + 60000 });
  }
  /** The server this wallet was made for, on its network: a different key is a different Ark, never followed silently. */
  private async checkServer() {
    const info = await serverInfo(this.wallet);
    if (info.network !== SDK_NETWORK[this.config.network] || info.serverPubkey !== this.config.serverKey) throw new Error("Bark server network or key changed. Review the wallet configuration.");
  }

  /** The address shown on the wallet page: always the first one, so it does not change on every look. */
  address() { return this.serial(async () => {
    try { return await this.wallet.peekAddress(0); }
    catch { await this.wallet.newAddressWithIndex(); return this.wallet.peekAddress(0); } // A new wallet derives it first.
  }); }
  /** A fresh address for one chat request, never the one on the wallet page: what arrives on it pays that request. */
  requestAddress() { return this.serial(async () => { for (;;) { const next = await this.wallet.newAddressWithIndex(); if (next.index > 0) return next.address; } }); }
  balance(): Promise<BarkBalance> { return this.outside(() => this.wallet.balance()); }
  onchainAddress() { return this.outside(() => this.onchain.newAddress()); }
  onchainBalance() { return this.outside(async () => { await this.onchain.sync().catch(() => {}); return this.onchain.balance(); }); }
  /** On-chain coins of this wallet into Ark. They show as pending until the board confirms. */
  board() { return this.serial(() => this.wallet.boardAll()); }
  sync() { return this.outside(() => this.wallet.sync()); }
  /**
   * How long until the first coin expires. A coin left past its expiry can be swept by the server, so the wallet
   * renews coins near it (maintenance); this is what the page shows so the person knows to open Ghostly in time.
   */
  expiry(): Promise<BarkExpiry> { return this.outside(async () => {
    const [first, info] = await Promise.all([this.wallet.getFirstExpiringVtxoBlockheight(), this.wallet.arkInfo()]);
    const lifetime = info?.vtxoLifetime || undefined;
    if (first === undefined) return { lifetime };
    return { blocksLeft: Math.max(0, first - await this.onchain.tipHeight()), lifetime };
  }); }
  /**
   * Refreshes VTXOs close to expiry (through a round) and settles what the daemon left, so money left alone
   * stays spendable. Not queued behind payments, nor they behind it: a round can take minutes, and the SDK
   * locks the coins it is using itself.
   */
  maintain() { return this.outside(() => this.wallet.maintenance()); }
  /**
   * Stops the wallet; its memory goes once nothing uses it. Freeing a wallet that a call outside the queue still
   * holds (a sync right after opening, a round) throws "attempted to take ownership of Rust value while it was
   * borrowed" and leaves Bark unusable in this page — replacing a wallet that had just opened did exactly that.
   */
  async dispose() {
    // Closed first: nothing new starts outside the queue, and whatever is running frees the wallet when it ends.
    this.closed = true;
    await this.queue.catch(() => {});
    try { await this.wallet.stopDaemonWait(); } catch { /* already stopped */ }
    this.freeWhenIdle();
  }

  prepare(target: PaymentTarget, amount: number, feeCap: number) { return this.serial(async () => {
    validatePaymentTarget(target); assertWholeSats(amount);
    await this.checkTarget(target);
    await this.checkServer();
    const fee = (await this.wallet.estimateArkoorPaymentFee(amount)).feeSats;
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > feeCap) throw new Error("The Bark fee exceeds your limit");
    if ((await this.wallet.balance()).spendableSats < amount + fee) throw new Error("Insufficient Bark balance");
    return { fee, prepared: { address: target.address, amount, fee, after: await this.lastMovement() } };
  }); }

  execute(review: PaymentReview, prepared: BarkPrepared, persist?: () => Promise<void>) { return this.serial(async () => {
    try {
      this.checkPrepared(review, prepared);
      await this.checkTarget(review);
      await this.checkServer();
      // The SDK signs and sends in one call, so what it would charge now must still be what was approved.
      if ((await this.wallet.estimateArkoorPaymentFee(review.amount)).feeSats > review.fee) throw new Error("The Bark fee changed. Create a new review");
      if ((await this.wallet.balance()).spendableSats < review.amount + review.fee) throw new Error("Bark balance changed. Create a new review");
      if (!persist) throw new Error("Durable payment journal required");
    } catch (error) { throw new PaymentPreflightError(error instanceof Error ? error.message : "Could not validate payment"); }
    await persist!(); // Written down before anything leaves: an interruption from here on is only ever reconciled.
    try { await this.wallet.sendArkoorPayment(prepared.address, prepared.amount); }
    catch (error) {
      // An error after the call started proves nothing: the history says whether it went out.
      const found = await this.sent(prepared).catch(() => undefined);
      if (found) return this.outcome(found);
      // SDK errors may carry wallet internals; only a bounded message leaves.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(/insufficient/i.test(String(error)) ? "Insufficient Bark balance" : "Bark payment outcome unknown");
    }
    const found = await this.sent(prepared);
    return found ? this.outcome(found) : { settled: true };
  }); }

  /** Only ever looks: a payment whose outcome is unknown is never sent a second time. */
  reconcile(review: PaymentReview, prepared: BarkPrepared) { return this.serial(async (): Promise<PaymentExecution> => {
    this.checkPrepared(review, prepared);
    await this.wallet.sync().catch(() => {});
    const found = await this.sent(prepared);
    return found ? this.outcome(found) : { settled: false };
  }); }

  /**
   * The payee's own proof: a completed receive, on the address this wallet gave for one request, of at least
   * the amount asked, made after the request. Nothing the payer says is trusted.
   */
  async received(address: string, amount: number, since: number, claimed: ReadonlySet<string> = new Set()): Promise<string | undefined> {
    for (const m of await this.outside(() => this.wallet.history())) {
      if (m.subsystemKind !== "receive" || m.status !== "successful" || m.effectiveBalanceSats < amount || Date.parse(m.createdAt) < since - 60_000) continue;
      if (!m.receivedOnAddresses.map(addressOf).includes(address)) continue;
      const id = outputTxid(m) ?? `movement-${m.id}`;
      if (!claimed.has(id)) return id;
    }
    return undefined;
  }

  private outcome(m: BarkMovement): PaymentExecution {
    const txid = outputTxid(m);
    if (m.status === "successful") return { txid, settled: true };
    if (m.status === "failed" || m.status === "canceled") return { txid, settled: false, failed: true, error: "The Bark server did not take this payment. Nothing was sent." };
    return { txid, settled: false, pending: true };
  }
  /** This send in the history: after the review was made, to its address, for its amount. */
  private async sent(p: BarkPrepared): Promise<BarkMovement | undefined> {
    return (await this.wallet.history()).find((m) => m.id > p.after && m.subsystemKind === "send" && m.intendedBalanceSats === -p.amount && m.sentToAddresses.map(addressOf).includes(p.address));
  }
  private async lastMovement() { return Math.max(0, ...(await this.wallet.history()).map((m) => m.id)); }
  private async checkTarget(t: PaymentTarget) {
    if (t.method !== this.method || t.provider !== this.config.provider || t.network !== this.config.network || t.asset !== "BTC" || t.unit !== "sat") throw new Error("Payment method, network or provider does not match this wallet");
    if (!this.sdk.isArkAddress(t.address)) throw new Error("Not a Bark address. Bark cannot pay an Arkade address.");
    if (!t.address.toLowerCase().startsWith(barkAddressPrefix(this.config.network))) throw new Error(this.config.network === "bitcoin" ? "This is a test network Bark address: a Mainnet wallet pays only real Bitcoin addresses" : "This is a Mainnet Bark address: a test wallet cannot pay it");
    const ours = await this.wallet.validateArkoorAddress(t.address).catch(() => false);
    if (!ours) throw new Error("This Bark address belongs to another Ark server or network");
  }
  private checkPrepared(r: PaymentReview, p: BarkPrepared) {
    if (p.address !== r.address || p.amount !== r.amount || p.fee !== r.fee || p.fee > r.feeCap || !Number.isSafeInteger(p.after)) throw new Error("Prepared payment does not match the approved review");
  }
}
