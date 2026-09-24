import { decodeBolt11, requestLnurlInvoice, resolveLightningDestination, type LnurlPayParams, type LnurlSuccessAction } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../../../shared/idb";
import type { WalletMode } from "../../../shared/mints";
import { CASHU_MINT_SOURCE, CashuMintLightning } from "./cashuMint";
import type { LightningInvoice, LightningProvider, LightningProviderDescriptor } from "./lightning";
import { ProviderSources, type SourceView } from "./sources";
import { isNothingSpentError, redact, type ProviderHost } from "./types";

/**
 * One Lightning operation, journaled under `lightningOp-<direction>-<payment hash>` in the settings store
 * BEFORE the provider is asked to spend: after a crash or a lost answer it is only ever reconciled (asked
 * about), never paid again. Incoming invoices are journaled too, so whoever paid a chat request is told
 * once the source sees it paid.
 */
export interface LightningOp {
  direction: "in" | "out";
  providerId: string;
  mode: WalletMode;
  paymentHash: string;
  invoice: string;
  amount: number;
  /** The chat payment request this pays, or is the invoice of. */
  paymentId?: string;
  note?: string;
  ref?: string;
  expiresAt: number;
  createdAt: number;
  /** The source books and reports this itself (the Cashu wallet): the engine does not poll it. */
  selfSettled?: boolean;
  /** in: open → paid | expired. out: sending → paid | pending | failed | unknown (a lost answer). */
  state: "open" | "paid" | "expired" | "sending" | "pending" | "failed" | "unknown";
  maxFee?: number;
  fee?: number;
  error?: string;
  settledAt?: number;
}
export type LightningOpView = Omit<LightningOp, "ref" | "note" | "selfSettled">;
export interface LightningView extends SourceView {
  capabilities?: LightningProvider["capabilities"];
  /** This mode's latest operations, newest first. */
  recent: LightningOpView[];
}
/** `mint`: the Cashu mint that will pay, when the source is the mints; otherwise the source's id. */
export interface LightningQuote { quote: string; mint: string; amount: number; feeReserve: number; source: string }
/** What a person sees of a resolved Lightning address or LNURL before choosing an amount. Amounts are whole sats. */
export interface LnurlView {
  id: string;
  kind: "address" | "lnurl";
  /** The address or LNURL, as normalised. */
  text: string;
  /** The host that learned of the request. */
  domain: string;
  /** The host the invoice is asked from, when it is another. */
  callbackDomain: string;
  minSat: number;
  maxSat: number;
  /** What the service says the payment is for. */
  description: string;
  /** How long a comment may be (LUD-12); 0 when none is taken. */
  commentAllowed: number;
}
/** Who an event is about. `mint`: the Cashu mint it went through, when it did. */
export interface LightningEventOp { paymentId?: string; providerId: string; mint?: string }

export interface LightningEvents {
  changed(): void;
  /** One of our invoices was paid. `paymentId`: the chat request it belongs to. */
  received(op: LightningEventOp): void;
  /** A payment left pending or unknown ended, one way or the other. */
  resolved(op: LightningEventOp, paid: boolean): void;
}

const PREFIX = "lightningOp-";
const opKey = (direction: LightningOp["direction"], hash: string) => `${PREFIX}${direction}-${hash}`;
const RANGE = () => IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`);
const IN_POLL_MS = 4_000;
const OUT_POLL_MS = 15_000;
const RECENT = 20;
/** Resolved Lightning addresses are kept this long for the amount to be chosen; this many at most. */
const LNURL_TTL_MS = 10 * 60_000;
const LNURL_KEPT = 20;
/** A source that cannot tell its fee beforehand gets this ceiling, the same one chat requests are paid under. */
export const defaultFeeCap = (amount: number) => Math.max(10, Math.ceil(amount * 0.03));

/**
 * Lightning for the whole engine: the Lightning card, the invoice a chat request carries and paying a
 * contact's invoice all come here, and go to the active source of the wallet mode in use.
 */
export class LightningService {
  readonly sources: ProviderSources<LightningProvider>;
  private readonly quotes = new Map<string, { providerId: string; provider: LightningProvider; invoice: string; amount: number; maxFee: number; paymentHash: string }>();
  private mode: WalletMode = "mainnet";
  private timer?: ReturnType<typeof setTimeout>;
  private passes: Promise<void> = Promise.resolve();
  private stopped = false;
  private recent: LightningOpView[] = [];
  /** Lightning addresses and LNURLs resolved, until an amount is chosen for them. */
  private readonly lnurls = new Map<string, { params: LnurlPayParams; at: number }>();

  constructor(descriptors: () => readonly LightningProviderDescriptor[], host: () => Omit<ProviderHost, "mode" | "signal">, private readonly events: LightningEvents, defaultId?: string, private readonly options: { fetch?: typeof fetch } = {}) {
    this.sources = new ProviderSources<LightningProvider>({
      kind: "lightning", descriptors, host, defaultId,
      changed: () => { this.schedule(0); events.changed(); },
      refuseReplacing: (providerId, mode) => this.refusal(providerId, mode),
      refresh: async (provider) => (provider.capabilities.balance ? { balance: (await provider.info()).balance } : {}),
    });
  }

  get view(): LightningView {
    return { ...this.sources.view, capabilities: this.sources.active?.capabilities, recent: this.recent };
  }

  async start(mode: WalletMode) { this.mode = mode; await this.sources.start(mode); await this.loadRecent(); }
  async setMode(mode: WalletMode) { this.mode = mode; this.quotes.clear(); await this.sources.setMode(mode); await this.loadRecent(); this.events.changed(); }
  ensureReady() { return this.sources.ensureReady(); }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.sources.stop(); }
  refreshOffered() { this.sources.refreshOffered(); }

  // -- receiving -----------------------------------------------------------------

  async createInvoice(amount: number, context: { memo?: string; paymentId?: string } = {}): Promise<LightningInvoice & { source: string }> {
    const { provider, descriptor } = await this.sources.use();
    if (!provider.capabilities.receive) throw new Error(`${descriptor.label} cannot create invoices`);
    const created = await provider.createInvoice(amount, context.memo ?? "Ghostly");
    const decoded = decodeBolt11(created.invoice);
    // What goes to a contact must be the invoice we asked for: this amount, this hash, the right chain.
    if (!decoded || decoded.amountSat !== amount || (decoded.paymentHash && decoded.paymentHash !== created.paymentHash) || created.amount !== amount) throw new Error(`${descriptor.label} returned an invoice that does not match the request`);
    this.checkNetwork(decoded.network);
    await this.put({ direction: "in", providerId: descriptor.id, mode: this.mode, paymentHash: created.paymentHash, invoice: created.invoice, amount, paymentId: context.paymentId, ref: created.ref, expiresAt: created.expiresAt, createdAt: Date.now(), selfSettled: !!provider.settlesItself, state: "open" });
    this.schedule(IN_POLL_MS);
    return { ...created, source: descriptor.id };
  }

  /** The Cashu wallet minted the ecash of one of its invoices (it polls its own quotes). */
  async reportInvoicePaid(invoice: string, context: { paymentId?: string; mint?: string } = {}) {
    const hash = decodeBolt11(invoice)?.paymentHash;
    const op = hash ? await this.get("in", hash) : undefined;
    if (op && op.state !== "paid") await this.put({ ...op, state: "paid", settledAt: Date.now() });
    // Quotes made before sources carry their chat request themselves.
    this.events.received({ paymentId: op?.paymentId ?? context.paymentId, providerId: op?.providerId ?? CASHU_MINT_SOURCE, mint: context.mint });
    await this.loadRecent(); this.events.changed();
  }

  // -- Lightning addresses and LNURLs (LUD-16, LUD-06) -----------------------------

  /**
   * Fetches what a Lightning address or LNURL asks for, and keeps it until an amount is chosen. The
   * service's domain learns of the request: the caller says so before asking.
   */
  async resolveDestination(text: string): Promise<LnurlView> {
    const params = await resolveLightningDestination(text, { fetch: this.options.fetch });
    const now = Date.now();
    for (const [id, entry] of this.lnurls) if (entry.at + LNURL_TTL_MS < now) this.lnurls.delete(id);
    while (this.lnurls.size >= LNURL_KEPT) this.lnurls.delete(this.lnurls.keys().next().value!);
    const id = crypto.randomUUID();
    this.lnurls.set(id, { params, at: now });
    const { destination, callbackDomain, minSat, maxSat, description, commentAllowed } = params;
    return { id, kind: destination.kind, text: destination.text, domain: destination.domain, callbackDomain, minSat, maxSat, description, commentAllowed };
  }

  /**
   * The invoice for `amountSat` from a resolved destination: checked (the amount, a commitment to what
   * was shown, not expired, a network of this mode) before it is quoted and paid like any other invoice.
   */
  async destinationInvoice(id: string, amountSat: number, comment?: string): Promise<{ invoice: string; successAction?: LnurlSuccessAction; note: string }> {
    const entry = this.lnurls.get(id);
    if (!entry || entry.at + LNURL_TTL_MS < Date.now()) { this.lnurls.delete(id); throw new Error("That address was resolved too long ago: check it again"); }
    const { invoice, successAction } = await requestLnurlInvoice(entry.params, amountSat, comment, { fetch: this.options.fetch });
    this.checkNetwork(invoice.network);
    return { invoice: invoice.invoice, successAction, note: entry.params.destination.text };
  }

  // -- paying --------------------------------------------------------------------

  /** What paying this invoice costs at most, from the active source. Nothing is spent. */
  async quote(text: string): Promise<LightningQuote> {
    const decoded = decodeBolt11(text);
    if (!decoded) throw new Error("That is not a Lightning invoice");
    if (decoded.amountSat === null) throw new Error("Invoices without an amount are not supported");
    if (!decoded.paymentHash) throw new Error("That invoice has no payment hash");
    if (decoded.expiresAt * 1000 < Date.now()) throw new Error("That invoice has expired");
    this.checkNetwork(decoded.network);
    const { provider, descriptor } = await this.sources.use();
    if (!provider.capabilities.send) throw new Error(`${descriptor.label} cannot pay invoices`);
    const maxFee = provider.estimateFee ? await provider.estimateFee(decoded.invoice, decoded.amountSat) : defaultFeeCap(decoded.amountSat);
    if (!Number.isSafeInteger(maxFee) || maxFee < 0) throw new Error(`${descriptor.label} returned an invalid fee`);
    const id = crypto.randomUUID();
    this.quotes.set(id, { providerId: descriptor.id, provider, invoice: decoded.invoice, amount: decoded.amountSat, maxFee, paymentHash: decoded.paymentHash });
    const mint = provider instanceof CashuMintLightning ? provider.quoteFor(decoded.invoice)?.mint : undefined;
    return { quote: id, mint: mint ?? descriptor.id, amount: decoded.amountSat, feeReserve: maxFee, source: descriptor.id };
  }

  hasQuote(id: string) { return this.quotes.has(id); }

  /**
   * Pays a quote. True once paid; false while in flight or unknown (reconciled in the background, never
   * paid again). Throws only when nothing left the wallet.
   */
  async pay(quoteId: string, context: { note?: string; paymentId?: string } = {}): Promise<boolean> {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new Error("This quote is no longer valid: check the invoice again");
    if (this.sources.active !== quote.provider) { this.quotes.delete(quoteId); throw new Error("The Lightning source changed: check the invoice again"); }
    this.quotes.delete(quoteId);
    const existing = await this.get("out", quote.paymentHash);
    if (existing && existing.state !== "failed") throw new Error(existing.state === "paid" ? "This invoice is already paid" : "This invoice is already being paid");
    let op: LightningOp = { direction: "out", providerId: quote.providerId, mode: this.mode, paymentHash: quote.paymentHash, invoice: quote.invoice, amount: quote.amount, paymentId: context.paymentId, note: context.note?.slice(0, 140), expiresAt: 0, createdAt: Date.now(), selfSettled: !!quote.provider.settlesItself, state: "sending", maxFee: quote.maxFee };
    // Written down before the provider sees it: from here on the sats may be gone.
    await this.put(op);
    try {
      const result = await quote.provider.payInvoice(quote.invoice, quote.maxFee, context.note);
      op = result.state === "paid" ? { ...op, state: "paid", fee: result.fee, ref: result.ref, settledAt: Date.now() } : { ...op, state: "pending", ref: result.ref };
    } catch (error) {
      if (isNothingSpentError(error)) { await this.put({ ...op, state: "failed", error: redact(error) }); throw error; }
      // A source that cannot look payments up never settles this by itself: say so rather than "being checked".
      op = { ...op, state: "unknown", error: quote.provider.capabilities.lookup ? "No answer from the source. It is being checked; nothing is paid again." : "No answer from the source, and it cannot be asked: check this payment in the wallet itself. It is never paid again." };
    }
    await this.put(op);
    if (op.state !== "paid") this.schedule(OUT_POLL_MS);
    return op.state === "paid";
  }

  /** The Cashu wallet settled a melt it had left pending. */
  async reportPaymentResolved(invoice: string, paid: boolean, context: { paymentId?: string; mint?: string } = {}) {
    const hash = decodeBolt11(invoice)?.paymentHash;
    const op = hash ? await this.get("out", hash) : undefined;
    if (op) await this.put({ ...op, state: paid ? "paid" : "failed", settledAt: Date.now() });
    this.events.resolved({ paymentId: op?.paymentId ?? context.paymentId, providerId: op?.providerId ?? CASHU_MINT_SOURCE, mint: context.mint }, paid);
    await this.loadRecent(); this.events.changed();
  }

  // -- reconciling ---------------------------------------------------------------

  /** Asks the active source about everything of its that is open, pending or unknown. One pass at a time. */
  reconcile(): Promise<void> {
    const pass = this.passes.then(() => this.reconcileOnce());
    this.passes = pass.catch(() => {});
    return pass;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.stopped) return;
    let again = 0;
    try {
      const provider = this.sources.active, providerId = this.sources.activeId;
      for (const op of await this.list()) {
        if (op.selfSettled || op.mode !== this.mode) continue;
        // `sending` is a spend under way in this process: its own answer decides. One left by a crash is
        // made `unknown` by `recover` at the next start, and only then asked about.
        const waiting = op.direction === "in" ? op.state === "open" : ["pending", "unknown"].includes(op.state);
        if (!waiting) continue;
        // Another source's operation waits until that source is active again: only it can answer.
        if (!provider || op.providerId !== providerId || !provider.capabilities.lookup) continue;
        try {
          const unchanged = async () => (await this.get(op.direction, op.paymentHash))?.state === op.state;
          if (op.direction === "in") {
            const status = await provider.invoiceStatus({ invoice: op.invoice, paymentHash: op.paymentHash, amount: op.amount, expiresAt: op.expiresAt, ref: op.ref });
            if (!(await unchanged())) continue;
            if (status.state === "paid") { await this.put({ ...op, state: "paid", settledAt: Date.now() }); this.events.received(op); }
            else if (status.state === "expired" || op.expiresAt + 60_000 < Date.now()) await this.put({ ...op, state: "expired" });
            else again = again ? Math.min(again, IN_POLL_MS) : IN_POLL_MS;
          } else {
            const status = await provider.paymentStatus({ invoice: op.invoice, paymentHash: op.paymentHash, ref: op.ref });
            if (status.state === "pending") { again = again || OUT_POLL_MS; continue; }
            // Written only over the state that was asked about: anything newer wins.
            if (!(await unchanged())) continue;
            await this.put({ ...op, state: status.state, fee: status.fee ?? op.fee, error: status.state === "failed" ? "The payment did not go through" : undefined, settledAt: Date.now() });
            this.events.resolved(op, status.state === "paid");
          }
        } catch {
          // The source cannot be asked right now: ask again later, nothing changes.
          again = again ? Math.min(again, op.direction === "in" ? IN_POLL_MS : OUT_POLL_MS) : op.direction === "in" ? IN_POLL_MS : OUT_POLL_MS;
        }
      }
    } finally {
      await this.loadRecent();
      this.events.changed();
      if (again) this.schedule(again);
    }
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reconcile(), ms);
  }

  /** Changing the source is refused while a payment through it has not ended: only it can say how. */
  private async refusal(providerId: string, mode: WalletMode) {
    const open = (await this.list()).filter((op) => op.direction === "out" && !op.selfSettled && op.providerId === providerId && op.mode === mode && ["sending", "pending", "unknown"].includes(op.state));
    return open.length ? `A Lightning payment through this source has not ended yet (${open.length}). Wait for it before changing the source.` : undefined;
  }

  /** In Mainnet, an invoice on a test chain is refused, and the reverse is harmless (test mints use lnbc). */
  private checkNetwork(network: string) {
    if (this.mode === "mainnet" && network !== "bitcoin") throw new Error(`That invoice is for ${network}, a test network: switch the wallets to Testnet`);
  }

  private async get(direction: LightningOp["direction"], hash: string) { return wrap<LightningOp | undefined>((await store(STORES.settings, "readonly")).get(opKey(direction, hash))); }
  private async put(op: LightningOp) { await transact([STORES.settings], (s) => { s[STORES.settings].put(op, opKey(op.direction, op.paymentHash)); }); }
  async list(): Promise<LightningOp[]> { return wrap<LightningOp[]>((await store(STORES.settings, "readonly")).getAll(RANGE())); }

  /** Crash recovery: a spend journaled as `sending` never got its answer written, so its outcome is unknown. */
  async recover() {
    for (const op of await this.list()) if (op.direction === "out" && op.state === "sending") await this.put({ ...op, state: "unknown", error: "Interrupted. It is being checked; nothing is paid again." });
    this.schedule(0);
  }

  private async loadRecent() {
    this.recent = (await this.list()).filter((op) => op.mode === this.mode).sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT)
      .map(({ ref: _ref, note: _note, selfSettled: _self, ...view }) => view);
  }
}
