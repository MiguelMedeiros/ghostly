import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11 } from "@ghostly/core";
import type { WalletMode } from "../../../shared/mints";
import type { InvoiceStatus, LightningCapabilities, LightningInfo, LightningInvoice, LightningPayResult, LightningPaymentRef, LightningPaymentStatus, LightningProvider, LightningProviderDescriptor } from "./lightning";
import { NothingSpentError, type ProviderNetwork } from "./types";

/**
 * Lightning through a browser wallet that speaks WebLN (Alby and others): the wallet injects
 * `window.webln` into the page, the person approves the connection once (`enable()`), and Ghostly asks it
 * for invoices (`makeInvoice`), payments (`sendPayment`), and, where the wallet has them, its balance
 * (`getBalance`) and whether an invoice was paid (`lookupInvoice`). See PROVIDERS.md.
 *
 * Where it runs: only where the engine shares a window with the browser wallet, which is the web app. The
 * extension's engine lives in an offscreen document, and neither it nor the extension's own pages get
 * another extension's `window.webln`; the Tauri webview has no browser extensions at all.
 *
 * Every payment has been reviewed and approved in Ghostly before `sendPayment` is called; the wallet may
 * then show a prompt of its own, and refusing that prompt spends nothing.
 */

/** The part of WebLN (https://webln.guide) Ghostly uses. Everything past `enable` is optional in practice. */
export interface WebLNProvider {
  enable(): Promise<unknown>;
  getInfo?(): Promise<WebLNInfo>;
  makeInvoice?(args: { amount: number | string; defaultMemo?: string }): Promise<{ paymentRequest: string }>;
  sendPayment?(paymentRequest: string): Promise<{ preimage?: string; route?: { total_fees?: number; total_amt?: number } }>;
  getBalance?(): Promise<{ balance: number; currency?: string }>;
  lookupInvoice?(args: { paymentHash?: string; paymentRequest?: string }): Promise<{ paid?: boolean; preimage?: string; paymentRequest?: string }>;
}

export interface WebLNInfo {
  node?: { alias?: string; pubkey?: string; network?: string };
  /** Not in the standard, but some wallets say which chain they are on here. */
  network?: string;
  chain?: string;
  /** The methods this wallet actually implements. Alby lists them; the object has every method either way. */
  methods?: string[];
}

export const WEBLN_SOURCE = "webln";
type Method = "makeInvoice" | "sendPayment" | "getBalance" | "lookupInvoice";

const PROMPT_MS = 5 * 60_000;
const CALL_MS = 60_000;
const INJECT_MS = 2_000;

/** A refusal the wallet makes before anything leaves: its own prompt turned down, a method it does not have. */
const REFUSED_NAMES = new Set(["RejectionError", "UnsupportedMethodError", "MissingProviderError"]);
const REFUSED = /\b(user (rejected|denied|declined|cancell?ed)|(rejected|denied|declined|cancell?ed) by (the )?user|prompt (was )?closed|request (was )?(rejected|denied|cancell?ed))\b/i;
/** The wallet gave up for good before any HTLC was out: no route found, not enough in the wallet. */
const NOT_SENT = /\b(no[ _-]?route|insufficient[ _-](local[ _-])?balance|not enough (balance|funds)|insufficient funds)\b/i;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => new Uint8Array((value.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const message = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "no answer").slice(0, 200);
/** A preimage that is the one of this payment hash: proof the invoice was paid. */
export const provesPayment = (preimage: unknown, paymentHash: string) =>
  typeof preimage === "string" && /^[0-9a-f]{64}$/i.test(preimage) && hex(sha256(bytes(preimage.toLowerCase()))) === paymentHash.toLowerCase();

/** A network named by a wallet, in Ghostly's words. Anything else is no answer. */
function networkNamed(name: unknown): ProviderNetwork | undefined {
  if (typeof name !== "string") return undefined;
  const value = name.trim().toLowerCase();
  if (value === "mainnet" || value === "bitcoin") return "bitcoin";
  if (value === "testnet" || value === "testnet3" || value === "testnet4") return "testnet";
  return (["signet", "regtest", "mutinynet"] as const).find((n) => n === value);
}
/** Mutinynet is a signet: its invoices say `lntbs`, like any signet's. */
const sameChain = (a: ProviderNetwork, b: string) => a === b || (a === "mutinynet" && b === "signet");

/** Calls the wallet, bounded in time and ended by the source's signal. A wallet that throws at once rejects too. */
function within<T>(call: () => Promise<T> | T, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The browser wallet did not answer (${what})`)), ms);
    const abort = () => reject(new Error("The browser wallet was disconnected"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    new Promise<T>((run) => run(call())).then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", abort); });
  });
}

/** `window.webln`, waiting a moment for a wallet that injects it after the page started. */
export async function findWebln(scope: { webln?: unknown; addEventListener?: typeof globalThis.addEventListener; removeEventListener?: typeof globalThis.removeEventListener } = globalThis as never, waitMs = INJECT_MS): Promise<WebLNProvider | undefined> {
  const found = () => (scope.webln && typeof (scope.webln as WebLNProvider).enable === "function" ? scope.webln as WebLNProvider : undefined);
  if (found() || waitMs <= 0) return found();
  // Alby says `webln:ready` once it is there; others do not, so look again every so often too.
  return new Promise((resolve) => {
    const done = () => { clearInterval(poll); clearTimeout(timer); scope.removeEventListener?.("webln:ready", check); resolve(found()); };
    const check = () => { if (found()) done(); };
    const poll = setInterval(check, 100);
    const timer = setTimeout(done, waitMs);
    scope.addEventListener?.("webln:ready", check);
  });
}

export class WeblnLightning implements LightningProvider {
  private closed = false;

  private constructor(
    private readonly webln: WebLNProvider,
    readonly capabilities: LightningCapabilities,
    private readonly network: ProviderNetwork,
    private readonly alias: string | undefined,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Asks the wallet to connect (its own prompt, the first time), then works out what it can do and which
   * chain it is on. A wallet that says nothing about its chain is asked for a 1-sat invoice, which says it;
   * one that cannot make invoices either is taken for Mainnet only (Testnet would call real sats test sats).
   */
  static async connect(webln: WebLNProvider | undefined, mode: WalletMode, signal?: AbortSignal): Promise<WeblnLightning> {
    if (!webln) throw new Error("No WebLN wallet in this browser. Install or unlock one (Alby, for example), then connect again");
    try {
      const answer = await within(() => webln.enable(), PROMPT_MS, "connect", signal) as { enabled?: boolean } | undefined;
      if (answer && typeof answer === "object" && answer.enabled === false) throw new Error("not enabled");
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error(`The browser wallet refused the connection (${message(error)})`), { cause: error });
    }
    const info = typeof webln.getInfo === "function" ? await within(() => webln.getInfo!(), CALL_MS, "info", signal).catch(() => undefined) : undefined;
    const methods = Array.isArray(info?.methods) ? info.methods : undefined;
    const has = (method: Method) => typeof webln[method] === "function" && (!methods || methods.includes(method));

    let balance = false;
    if (has("getBalance")) balance = await within(() => webln.getBalance!(), CALL_MS, "balance", signal).then((b) => sats(b) !== undefined, () => false);
    const capabilities = { receive: has("makeInvoice"), send: has("sendPayment"), balance, lookup: has("lookupInvoice") };
    if (!capabilities.receive && !capabilities.send) throw new Error("This browser wallet can neither make nor pay invoices");

    let network = networkNamed(info?.network) ?? networkNamed(info?.chain) ?? networkNamed(info?.node?.network);
    if (!network && capabilities.receive) {
      const probe = await within(() => webln.makeInvoice!({ amount: 1, defaultMemo: "Ghostly: which network is this wallet on?" }), CALL_MS, "invoice", signal);
      network = decodeBolt11(probe?.paymentRequest ?? "")?.network;
      if (!network) throw new Error("The browser wallet made an invoice Ghostly cannot read");
    }
    if (!network) {
      if (mode === "testnet") throw new Error("This browser wallet does not say which network it is on, and cannot make an invoice that would: it can only be used in Mainnet");
      network = "bitcoin";
    }
    const alias = typeof info?.node?.alias === "string" && info.node.alias.trim() ? info.node.alias.trim().slice(0, 64) : undefined;
    return new WeblnLightning(webln, capabilities, network, alias, signal);
  }

  private ready() { if (this.closed) throw new Error("The browser wallet was disconnected"); }

  async info(): Promise<LightningInfo> {
    this.ready();
    return { network: this.network, alias: this.alias, ...(this.capabilities.balance ? { balance: sats(await within(() => this.webln.getBalance!(), CALL_MS, "balance", this.signal)) ?? 0 } : {}) };
  }

  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    this.ready();
    if (!this.capabilities.receive) throw new Error("This browser wallet cannot make invoices");
    const made = await within(() => this.webln.makeInvoice!({ amount, defaultMemo: memo?.slice(0, 140) }), CALL_MS, "invoice", this.signal);
    const decoded = decodeBolt11(typeof made?.paymentRequest === "string" ? made.paymentRequest : "");
    if (!decoded?.paymentHash) throw new Error("The browser wallet returned an invoice that cannot be read");
    if (decoded.amountSat !== amount) throw new Error("The browser wallet returned an invoice for another amount");
    if (!sameChain(this.network, decoded.network)) throw new Error(`The browser wallet returned an invoice for ${decoded.network}, not ${this.network}`);
    return { invoice: decoded.invoice, paymentHash: decoded.paymentHash, amount, expiresAt: decoded.expiresAt * 1000 };
  }

  async invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus> {
    this.ready();
    const found = await this.lookup(invoice);
    if (found.paid && (found.preimage === undefined || provesPayment(found.preimage, invoice.paymentHash))) return { state: "paid", amount: invoice.amount };
    return { state: invoice.expiresAt < Date.now() ? "expired" : "open" };
  }

  /**
   * WebLN takes no fee limit: the wallet applies its own (and may ask about it in its prompt). The fee is
   * reported when the wallet says it. Only what certainly did not leave is a `NothingSpentError`: the
   * checks here, the wallet's prompt refused, or a wallet that gave up before sending (no route, no funds).
   */
  async payInvoice(invoice: string): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    try {
      this.ready();
      if (!this.capabilities.send) throw new Error("This browser wallet cannot pay invoices");
      if (!decoded?.paymentHash || decoded.amountSat === null) throw new Error("That is not an invoice this wallet can pay");
      if (!sameChain(this.network, decoded.network)) throw new Error(`That invoice is for ${decoded.network}, and this browser wallet is on ${this.network}`);
      if (this.capabilities.balance) {
        const balance = sats(await within(() => this.webln.getBalance!(), CALL_MS, "balance", this.signal));
        if (balance !== undefined && balance < decoded.amountSat) throw new Error(`Not enough in the browser wallet (${balance} sats)`);
      }
    } catch (error) {
      throw new NothingSpentError(message(error));
    }
    let answer: Awaited<ReturnType<NonNullable<WebLNProvider["sendPayment"]>>>;
    try {
      answer = await within(() => this.webln.sendPayment!(decoded.invoice), PROMPT_MS, "payment", this.signal);
    } catch (error) {
      if (!this.signal?.aborted && error instanceof Error && (REFUSED_NAMES.has(error.name) || REFUSED.test(error.message) || NOT_SENT.test(error.message))) throw new NothingSpentError(`The browser wallet did not pay: ${message(error)}`);
      // Anything else may have gone out: unknown, and only ever looked up.
      throw Object.assign(new Error(`The browser wallet did not say whether it paid (${message(error)})`), { cause: error });
    }
    // A preimage is the proof: without the right one, nothing is known.
    if (!provesPayment(answer?.preimage, decoded.paymentHash)) throw new Error("The browser wallet answered without proof of payment");
    const fee = answer?.route?.total_fees;
    return { state: "paid", preimage: answer!.preimage!.toLowerCase(), ...(Number.isSafeInteger(fee) && fee! >= 0 ? { fee } : {}) };
  }

  /**
   * Only `lookupInvoice` can answer, and WebLN gives it no word for "failed": a payment is seen paid (with
   * its preimage), or it stays pending. A wallet without it never settles an unknown payment by itself.
   */
  async paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus> {
    this.ready();
    const found = await this.lookup(payment);
    return found.paid && provesPayment(found.preimage, payment.paymentHash) ? { state: "paid", preimage: found.preimage!.toLowerCase() } : { state: "pending" };
  }

  private async lookup(what: { invoice: string; paymentHash: string }) {
    if (!this.capabilities.lookup) throw new Error("This browser wallet cannot look up invoices");
    const found = await within(() => this.webln.lookupInvoice!({ paymentHash: what.paymentHash, paymentRequest: what.invoice }), CALL_MS, "lookup", this.signal);
    return { paid: found?.paid === true, preimage: typeof found?.preimage === "string" ? found.preimage : undefined };
  }

  async close() { this.closed = true; }
}

/** A WebLN balance in whole sats, when it is one. Wallets that answer in a fiat currency have none here. */
function sats(balance: { balance?: unknown; currency?: unknown } | undefined): number | undefined {
  const value = Number(balance?.balance);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const currency = typeof balance?.currency === "string" ? balance.currency.trim().toLowerCase() : "sats";
  if (currency === "sats" || currency === "sat") return Math.floor(value);
  if (currency === "msats" || currency === "msat") return Math.floor(value / 1000);
  return undefined;
}

export const webln: LightningProviderDescriptor = {
  id: WEBLN_SOURCE,
  label: "Browser wallet (WebLN)",
  kind: "lightning",
  description: "A Lightning wallet in this browser (Alby and others). That wallet holds the sats and asks you before it pays.",
  networks: ["bitcoin", "testnet", "signet", "mutinynet", "regtest"],
  // Only the web app's page sees `window.webln`: not the extension's offscreen engine, not Tauri.
  platforms: ["web"],
  fields: [],
  experimental: true,
  async create(_settings, host) { return WeblnLightning.connect(await findWebln(), host.mode, host.signal); },
};
