import { decodeBolt11 } from "@ghostly/core";
import { sha256 } from "@noble/hashes/sha2.js";
import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import type { InvoiceStatus, LightningCapabilities, LightningInfo, LightningInvoice, LightningPayResult, LightningPaymentRef, LightningPaymentStatus, LightningProvider, LightningProviderDescriptor } from "./lightning";
import { NothingSpentError, PROVIDER_PLATFORMS, type ProviderNetwork } from "./types";

/**
 * Lightning through a wallet reached over Nostr Wallet Connect (NIP-47): Alby Hub, a node's NWC service, a
 * hosted wallet. The person pastes the wallet's `nostr+walletconnect://` URI; requests are signed with the
 * key it carries, encrypted to the wallet (NIP-44, or NIP-04 when its info event offers nothing else) and
 * sent through its relay; the answers come back the same way. That wallet holds the sats, applies its own
 * fee limit, and is custodial or not depending on what it is.
 *
 * Money safety (PROVIDERS.md): a request that never reached the relay, or an error code the wallet answers
 * before it tries to pay, is `NothingSpentError`. A `pay_invoice` whose answer does not come back in time,
 * or any other error, is an unknown outcome, and `paymentStatus` asks `lookup_invoice` until it ends.
 */

const KIND = { info: 13194, request: 23194, response: 23195 } as const;
/** A relay message, an encrypted answer, an info event, an invoice: nothing bigger is read. */
const MAX_MESSAGE = 256 * 1024;
const MAX_CONTENT = 64 * 1024;
const MAX_INFO = 4096;
const MAX_INVOICE = 7089;
const MAX_URI = 2048;
const MAX_RELAYS = 5;
const CONNECT_MS = 10_000;
const ACK_MS = 10_000;
const REQUEST_MS = 20_000;
/** A payment may take a while to route; an answer after this is an unknown outcome, looked up later. */
const PAY_MS = 90_000;
/** The wallet must not start a payment it receives after this (NIP-47 `expiration`). */
const PAY_EXPIRY_S = 60;
/** A payment the wallet never heard of is failed once its invoice can no longer be paid, with room for clocks. */
const EXPIRED_MARGIN_MS = 10 * 60_000;
const INVOICE_EXPIRY_S = 3600;

/** Error codes a wallet answers before it tries to pay: nothing can have left it. (`BAD_REQUEST`: Alby Hub, an invoice it cannot read.) */
const REFUSED_BEFORE_PAYING = new Set(["RATE_LIMITED", "NOT_IMPLEMENTED", "INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "UNSUPPORTED_ENCRYPTION", "BAD_REQUEST"]);
const NETWORKS: Record<string, ProviderNetwork> = { mainnet: "bitcoin", bitcoin: "bitcoin", testnet: "testnet", testnet3: "testnet", testnet4: "testnet", signet: "signet", mutinynet: "mutinynet", regtest: "regtest" };

const HEX64 = /^[0-9a-f]{64}$/;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
const now = () => Math.floor(Date.now() / 1000);
const isMsat = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// -- the connection URI --------------------------------------------------------------------------------

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  /** The client key the wallet granted: a secret. */
  secret: Uint8Array;
}

/** Only secure relays, except on this machine (a local test relay). */
function checkRelay(address: string): string {
  let relay: URL;
  try { relay = new URL(address); } catch { throw new Error("The connection URI has a relay that is not a URL"); }
  if (relay.username || relay.password || relay.hash) throw new Error("The connection URI has a relay with credentials in it");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(relay.hostname);
  if (!(relay.protocol === "wss:" || (relay.protocol === "ws:" && loopback))) throw new Error("Use a wallet whose relay is secure (wss://)");
  return relay.href;
}

/** Reads a `nostr+walletconnect://` URI. Its errors never repeat it: it holds a secret. */
export function parseNwcUri(input: string): NwcConnection {
  const text = (input ?? "").trim();
  if (text.length > MAX_URI) throw new Error("That connection URI is too long");
  const match = /^(?:nostr\+walletconnect|nostrwalletconnect):(?:\/\/)?([0-9a-fA-F]{64})\/?\?([^#]*)$/.exec(text);
  if (!match) throw new Error("That is not a Nostr Wallet Connect URI (nostr+walletconnect://…)");
  const params = new URLSearchParams(match[2]);
  const secret = (params.get("secret") ?? "").toLowerCase();
  if (!HEX64.test(secret) || /^0+$/.test(secret)) throw new Error("The connection URI has no valid secret");
  const relays = [...new Set(params.getAll("relay").map(checkRelay))];
  if (!relays.length) throw new Error("The connection URI names no relay");
  if (relays.length > MAX_RELAYS) throw new Error("The connection URI names too many relays");
  return { walletPubkey: match[1].toLowerCase(), relays, secret: bytes(secret) };
}

// -- one relay -----------------------------------------------------------------------------------------

/** The request never reached the relay (not connected, refused by it): the wallet cannot have seen it. */
export class NotDelivered extends Error {
  constructor(message: string) { super(message); this.name = "NotDelivered"; }
}
/** An error the wallet answered, with its NIP-47 code. */
export class NwcError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NwcError"; }
}
/** No answer in time. The request may or may not have been acted on. */
export class NoAnswer extends Error {
  constructor(method: string) { super(`The wallet did not answer ${method} in time`); this.name = "NoAnswer"; }
}

interface Filter { kinds: number[]; authors: string[]; "#p"?: string[]; since?: number; limit?: number }
interface Subscription { filter: Filter; event(event: unknown): void; eose?(): void }

/**
 * A minimal NIP-01 client for one relay: it knows exactly whether an event was written to an open socket
 * and whether the relay acknowledged it, which is what tells "nothing sent" from "unknown" apart.
 * It reconnects when asked to send again, and subscriptions follow it.
 */
export class RelayConnection {
  private socket?: WebSocket;
  private opening?: Promise<WebSocket>;
  private readonly subs = new Map<string, Subscription>();
  private readonly acks = new Map<string, { ok(): void; fail(error: Error): void }>();
  private closed = false;

  constructor(readonly url: string, private readonly WebSocketImpl: typeof WebSocket = globalThis.WebSocket) {}

  open(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error("The wallet connection is closed"));
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (!this.opening) {
      const opening = this.connectSocket();
      this.opening = opening;
      opening.catch(() => {}).finally(() => { if (this.opening === opening) this.opening = undefined; });
    }
    return this.opening;
  }

  private connectSocket(): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const socket = new this.WebSocketImpl(this.url);
      const done = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { try { socket.close(); } catch { /* already closed */ } reject(error); return; }
        if (this.closed) { socket.close(); reject(new Error("The wallet connection is closed")); return; }
        this.socket = socket;
        for (const [id, sub] of this.subs) this.write(["REQ", id, sub.filter]);
        resolve(socket);
      };
      const timer = setTimeout(() => done(new Error("The wallet's relay did not answer")), CONNECT_MS);
      socket.onopen = () => done();
      socket.onerror = () => done(new Error("Could not reach the wallet's relay"));
      socket.onclose = () => {
        done(new Error("The wallet's relay closed the connection"));
        if (this.socket !== socket) return;
        this.socket = undefined;
        // Written, not acknowledged: whether the relay kept it is unknown.
        for (const [id, ack] of this.acks) { this.acks.delete(id); ack.fail(new Error("The relay connection dropped before it confirmed the request")); }
      };
      socket.onmessage = (message) => { if (this.socket === socket) this.receive(message.data); };
    });
  }

  subscribe(id: string, filter: Filter, sub: Omit<Subscription, "filter">) {
    this.subs.set(id, { ...sub, filter });
    this.write(["REQ", id, filter]);
  }

  unsubscribe(id: string) {
    if (this.subs.delete(id)) this.write(["CLOSE", id]);
  }

  /**
   * Events matching `filter` the relay has stored, until it says that is all (or `ms` pass). With
   * `waitForOne`, a relay that has none yet is listened to until one arrives live, within `ms`.
   */
  async fetch(filter: Filter, { ms = CONNECT_MS, waitForOne = false }: { ms?: number; waitForOne?: boolean } = {}): Promise<unknown[]> {
    await this.open();
    const id = `q${hex(crypto.getRandomValues(new Uint8Array(6)))}`, events: unknown[] = [];
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        let stored = false;
        const finish = () => { clearTimeout(timer); resolve(); };
        this.subscribe(id, filter, {
          event: (e) => { if (events.length < 20) events.push(e); if (stored) finish(); },
          eose: () => { stored = true; if (events.length || !waitForOne) finish(); },
        });
      });
    } finally { this.unsubscribe(id); }
    return events;
  }

  /**
   * Resolves once the relay accepted the event. `NotDelivered` when it certainly did not reach it (no open
   * socket, refused); any other rejection means it may have.
   */
  async publish(event: Event): Promise<void> {
    let socket: WebSocket;
    try { socket = await this.open(); } catch (error) { throw new NotDelivered(error instanceof Error ? error.message : "Could not reach the wallet's relay"); }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.acks.delete(event.id); reject(new Error("The relay did not confirm the request")); }, ACK_MS);
      this.acks.set(event.id, { ok: () => { clearTimeout(timer); resolve(); }, fail: (error) => { clearTimeout(timer); reject(error); } });
      // A socket that is not open anymore drops what it is given without a word: nothing was sent.
      if (socket.readyState !== 1 || socket !== this.socket) { this.acks.delete(event.id); clearTimeout(timer); reject(new NotDelivered("The relay connection closed")); return; }
      socket.send(JSON.stringify(["EVENT", event]));
    });
  }

  close() {
    this.closed = true;
    for (const [id, ack] of this.acks) { this.acks.delete(id); ack.fail(new Error("The wallet connection is closed")); }
    this.subs.clear();
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = undefined;
  }

  private write(message: unknown[]) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private receive(data: unknown) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE) return;
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!Array.isArray(message) || typeof message[1] !== "string") return;
    const [type, id] = message as [string, string];
    if (type === "EVENT") this.subs.get(id)?.event(message[2]);
    else if (type === "EOSE") this.subs.get(id)?.eose?.();
    else if (type === "OK") {
      const ack = this.acks.get(id);
      if (!ack) return;
      this.acks.delete(id);
      const reason = typeof message[3] === "string" ? message[3].slice(0, 120) : "";
      // "duplicate:" is a relay saying it already has it: delivered.
      if (message[2] === true || reason.startsWith("duplicate:")) ack.ok();
      else ack.fail(new NotDelivered(`The relay refused the request${reason ? ` (${reason})` : ""}`));
    }
  }
}

// -- the wallet ----------------------------------------------------------------------------------------

/** What `lookup_invoice` (and `make_invoice`) answer, as far as it is read. Amounts in millisats. */
interface NwcTransaction {
  type?: string;
  state?: string;
  invoice?: string;
  payment_hash?: string;
  preimage?: string;
  amount?: number;
  fees_paid?: number;
  settled_at?: number | null;
  expires_at?: number | null;
}

export interface NwcOptions {
  signal?: AbortSignal;
  /** For tests: time limits, and a WebSocket other than the global one. */
  requestMs?: number;
  /** How long to wait for the wallet's info event (a new app connection publishes it a moment later). */
  infoMs?: number;
  payMs?: number;
  WebSocket?: typeof WebSocket;
}

interface Pending { method: string; resolve(result: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class NwcLightning implements LightningProvider {
  /** From the info event, then narrowed to what this connection may do (`get_info`). */
  capabilities: LightningCapabilities;
  private readonly clientPubkey: string;
  private readonly subscription = `nwc${hex(crypto.getRandomValues(new Uint8Array(6)))}`;
  private readonly pending = new Map<string, Pending>();
  private conversationKey?: Uint8Array;
  private network: ProviderNetwork = "bitcoin";
  private alias?: string;
  private closed = false;

  private constructor(private readonly connection: NwcConnection, private readonly relay: RelayConnection, readonly encryption: "nip44_v2" | "nip04", methods: ReadonlySet<string>, private readonly options: NwcOptions) {
    this.clientPubkey = getPublicKey(connection.secret);
    if (encryption === "nip44_v2") this.conversationKey = nip44.v2.utils.getConversationKey(connection.secret, connection.walletPubkey);
    this.capabilities = this.capabilitiesOf(methods);
  }

  /**
   * Reaches the wallet through the first relay that answers, reads its info event (the methods and the
   * encryption it offers), listens for its answers, and asks `get_info` for its network.
   */
  static async connect(uri: string, options: NwcOptions = {}): Promise<NwcLightning> {
    const connection = parseNwcUri(uri);
    options.signal?.throwIfAborted();
    let relay: RelayConnection | undefined, lastError: unknown;
    for (const url of connection.relays) {
      const candidate = new RelayConnection(url, options.WebSocket);
      try { await candidate.open(); relay = candidate; break; } catch (error) { candidate.close(); lastError = error; }
    }
    if (!relay) throw lastError instanceof Error ? lastError : new Error("Could not reach the wallet's relay");
    let wallet: NwcLightning | undefined;
    try {
      const info = NwcLightning.newestInfo(await relay.fetch({ kinds: [KIND.info], authors: [connection.walletPubkey], limit: 5 }, { waitForOne: true, ms: options.infoMs }), connection.walletPubkey);
      if (!info) throw new Error(`The wallet has not published its NWC info on ${new URL(relay.url).host}: check the URI, or that the wallet is running`);
      const offered = (info.tags.find((t) => t[0] === "encryption")?.slice(1).join(" ") ?? "").split(/\s+/).filter(Boolean);
      // NIP-47: no `encryption` tag means a wallet that only speaks NIP-04.
      const encryption = offered.includes("nip44_v2") ? "nip44_v2" : !offered.length || offered.includes("nip04") ? "nip04" : undefined;
      if (!encryption) throw new Error("The wallet offers no encryption Ghostly speaks (NIP-44 or NIP-04)");
      const methods = new Set(info.content.split(/\s+/).filter(Boolean));
      wallet = new NwcLightning(connection, relay, encryption, methods, options);
      wallet.listen();
      if (options.signal) {
        const opened = wallet;
        if (options.signal.aborted) throw options.signal.reason;
        options.signal.addEventListener("abort", () => void opened.close(), { once: true });
      }
      await wallet.readInfo(methods);
      return wallet;
    } catch (error) {
      if (wallet) await wallet.close(); else relay.close();
      throw error;
    }
  }

  private static newestInfo(events: unknown[], walletPubkey: string): Event | undefined {
    return (events as Event[])
      .filter((e) => e && e.kind === KIND.info && e.pubkey === walletPubkey && typeof e.content === "string" && e.content.length <= MAX_INFO && Array.isArray(e.tags) && verifyEvent(e))
      .sort((a, b) => b.created_at - a.created_at)[0];
  }

  private capabilitiesOf(methods: ReadonlySet<string>): LightningCapabilities {
    return { receive: methods.has("make_invoice"), send: methods.has("pay_invoice"), balance: methods.has("get_balance"), lookup: methods.has("lookup_invoice") };
  }

  /**
   * `get_info` says the network and the methods this connection may use (the info event lists the
   * service's). Without it the wallet is taken to be on Bitcoin: a test wallet is then refused in the
   * Testnet mode and its invoices in the Mainnet one, while a real-money wallet never passes for a test one.
   */
  private async readInfo(offered: ReadonlySet<string>) {
    if (!offered.has("get_info")) return;
    const info = await this.request("get_info", {});
    if (info.network !== undefined) {
      const network = typeof info.network === "string" ? NETWORKS[info.network.toLowerCase()] : undefined;
      if (!network) throw new Error("The wallet is on a network Ghostly does not know");
      this.network = network;
    }
    if (typeof info.alias === "string" && info.alias.trim()) this.alias = info.alias.trim().slice(0, 40);
    if (Array.isArray(info.methods) && info.methods.every((m) => typeof m === "string")) {
      this.capabilities = this.capabilitiesOf(new Set(info.methods as string[]));
    }
  }

  private listen() {
    this.relay.subscribe(this.subscription, { kinds: [KIND.response], authors: [this.connection.walletPubkey], "#p": [this.clientPubkey], since: now() - 60 }, { event: (e) => this.answer(e) });
  }

  // -- requests and answers --

  private encrypt(text: string) {
    return this.conversationKey ? nip44.v2.encrypt(text, this.conversationKey) : nip04.encrypt(this.connection.secret, this.connection.walletPubkey, text);
  }

  private decrypt(content: string) {
    if (this.conversationKey && !content.includes("?iv=")) return nip44.v2.decrypt(content, this.conversationKey);
    return nip04.decrypt(this.connection.secret, this.connection.walletPubkey, content);
  }

  /**
   * Sends one request and waits for its answer. `NotDelivered` when it never reached the relay; `NwcError`
   * for an error the wallet answered; `NoAnswer` (or a relay error) when the outcome is unknown.
   */
  async request(method: string, params: Record<string, unknown>, { ms = this.options.requestMs ?? REQUEST_MS, expiresIn }: { ms?: number; expiresIn?: number } = {}): Promise<Record<string, unknown>> {
    if (this.closed) throw new NotDelivered("The wallet connection is closed");
    const tags = [["p", this.connection.walletPubkey]];
    if (this.conversationKey) tags.push(["encryption", "nip44_v2"]);
    if (expiresIn) tags.push(["expiration", String(now() + expiresIn)]);
    const event = finalizeEvent({ kind: KIND.request, created_at: now(), tags, content: this.encrypt(JSON.stringify({ method, params })) }, this.connection.secret);
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(event.id); reject(new NoAnswer(method)); }, ms);
      this.pending.set(event.id, { method, resolve, reject, timer });
    });
    // The answer can come before the relay's acknowledgement (or without one): whichever decides first wins.
    const delivered = this.relay.publish(event).then(() => undefined, (error: unknown) => {
      const waiting = this.pending.get(event.id);
      if (!(error instanceof NotDelivered) || !waiting) return undefined;
      clearTimeout(waiting.timer); this.pending.delete(event.id);
      return error;
    });
    return Promise.race([answer, delivered.then((error) => (error ? Promise.reject(error) : answer))]);
  }

  /** Reads an answer: from the wallet, signed, about a request of ours, of the method asked. Anything else is dropped. */
  private answer(raw: unknown) {
    const event = raw as Event;
    if (!event || typeof event !== "object" || event.kind !== KIND.response || event.pubkey !== this.connection.walletPubkey) return;
    if (typeof event.content !== "string" || event.content.length > MAX_CONTENT || !Array.isArray(event.tags)) return;
    const ref = event.tags.find((t) => Array.isArray(t) && t[0] === "e")?.[1];
    const pending = typeof ref === "string" ? this.pending.get(ref) : undefined;
    if (!pending || !event.tags.some((t) => Array.isArray(t) && t[0] === "p" && t[1] === this.clientPubkey)) return;
    if (!verifyEvent(event)) return;
    let body: { result_type?: unknown; error?: { code?: unknown; message?: unknown } | null; result?: unknown };
    try { body = JSON.parse(this.decrypt(event.content)); } catch { return; }
    if (!body || typeof body !== "object" || body.result_type !== pending.method) return;
    clearTimeout(pending.timer);
    this.pending.delete(ref!);
    if (body.error) {
      const code = typeof body.error.code === "string" ? body.error.code.slice(0, 40) : "OTHER";
      const message = typeof body.error.message === "string" && body.error.message.trim() ? body.error.message.trim().slice(0, 200) : code;
      pending.reject(new NwcError(code, message));
    } else if (body.result && typeof body.result === "object" && !Array.isArray(body.result)) pending.resolve(body.result as Record<string, unknown>);
    else pending.reject(new NwcError("OTHER", "The wallet sent an empty answer"));
  }

  private async lookup(paymentHash: string): Promise<NwcTransaction> {
    const tx = await this.request("lookup_invoice", { payment_hash: paymentHash }) as NwcTransaction;
    if (tx.payment_hash !== undefined && String(tx.payment_hash).toLowerCase() !== paymentHash) throw new Error("The wallet answered about another invoice");
    return tx;
  }

  // -- LightningProvider --

  async info(): Promise<LightningInfo> {
    let balance: number | undefined;
    if (this.capabilities.balance) {
      const result = await this.request("get_balance", {});
      if (!isMsat(result.balance)) throw new Error("The wallet returned an invalid balance");
      balance = Math.floor(result.balance / 1000);
    }
    return { network: this.network, alias: `${this.alias ?? "NWC wallet"} via ${new URL(this.relay.url).host}`, balance };
  }

  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount * 1000)) throw new Error("Invalid amount");
    const result = await this.request("make_invoice", { amount: amount * 1000, ...(memo ? { description: memo.slice(0, 200) } : {}), expiry: INVOICE_EXPIRY_S }) as NwcTransaction;
    const text = typeof result.invoice === "string" && result.invoice.length <= MAX_INVOICE ? result.invoice : "";
    const decoded = decodeBolt11(text);
    if (!decoded?.paymentHash || decoded.amountMsat !== BigInt(amount) * 1000n) throw new Error("The wallet returned an invoice that does not match the request");
    if (result.payment_hash !== undefined && String(result.payment_hash).toLowerCase() !== decoded.paymentHash) throw new Error("The wallet returned an invoice that does not match its payment hash");
    return { invoice: decoded.invoice, paymentHash: decoded.paymentHash, amount, expiresAt: decoded.expiresAt * 1000 };
  }

  async invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus> {
    let tx: NwcTransaction;
    try { tx = await this.lookup(invoice.paymentHash); }
    catch (error) {
      if (error instanceof NwcError && error.code === "NOT_FOUND" && invoice.expiresAt < Date.now()) return { state: "expired" };
      throw error;
    }
    const expired = invoice.expiresAt < Date.now();
    if (tx.type === "outgoing") return { state: expired ? "expired" : "open" };
    // An incoming invoice's preimage is known before it is paid: only `state` or `settled_at` say it was.
    const state = tx.state ?? (tx.settled_at ? "settled" : "pending");
    if (state === "settled") return { state: "paid", amount: isMsat(tx.amount) ? Math.floor(tx.amount / 1000) : invoice.amount };
    if (state === "expired" || state === "failed") return { state: "expired" };
    return { state: expired ? "expired" : "open" };
  }

  /**
   * Pays through the wallet. NIP-47 carries no fee limit: the wallet applies its own, and the fee it
   * reports is passed on as it is.
   */
  async payInvoice(invoice: string, _maxFee: number): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    if (!decoded?.paymentHash || decoded.amountSat === null) throw new NothingSpentError("That invoice cannot be paid through NWC");
    if (!this.capabilities.send) throw new NothingSpentError("This wallet connection may not pay invoices");
    let result: Record<string, unknown>;
    try {
      result = await this.request("pay_invoice", { invoice: decoded.invoice }, { ms: this.options.payMs ?? PAY_MS, expiresIn: PAY_EXPIRY_S });
    } catch (error) {
      if (error instanceof NotDelivered) throw new NothingSpentError(`The payment did not reach the wallet: ${error.message}`);
      if (error instanceof NwcError && REFUSED_BEFORE_PAYING.has(error.code)) throw new NothingSpentError(`The wallet refused the payment: ${error.message}`);
      // Any other code may come after the wallet tried (Alby Hub answers INTERNAL with LND's failure reason).
      if (error instanceof NwcError) return this.confirmFailure(decoded.invoice, decoded.paymentHash, error);
      throw error;
    }
    const preimage = typeof result.preimage === "string" ? result.preimage.toLowerCase() : "";
    // "Paid" without a proof that pays this invoice is not taken at its word: it is looked up instead.
    if (!HEX64.test(preimage) || hex(sha256(bytes(preimage))) !== decoded.paymentHash) throw new Error("The wallet said it paid, without a proof that matches the invoice");
    return { state: "paid", preimage, fee: isMsat(result.fees_paid) ? Math.ceil(result.fees_paid / 1000) : undefined };
  }

  /**
   * An error after the wallet may have tried (`PAYMENT_FAILED` "may be due to a timeout", `INTERNAL`,
   * `OTHER`…): its own record decides. Only a payment it records as failed is `NothingSpentError`; one it
   * records as paid is paid; anything else is pending, or unknown when it cannot be asked.
   */
  private async confirmFailure(invoice: string, paymentHash: string, failure: NwcError): Promise<LightningPayResult> {
    let status: LightningPaymentStatus;
    try { status = await this.paymentStatus({ invoice, paymentHash }); }
    catch { throw new Error(`The wallet said the payment failed (${failure.message}), and cannot confirm it yet`); }
    if (status.state === "failed") throw new NothingSpentError(`The payment failed: ${failure.message}`);
    return status.state === "paid" ? { state: "paid", fee: status.fee, preimage: status.preimage } : { state: "pending" };
  }

  async paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus> {
    let tx: NwcTransaction;
    try { tx = await this.lookup(payment.paymentHash); }
    catch (error) {
      if (!(error instanceof NwcError && error.code === "NOT_FOUND")) throw error;
      // The wallet never heard of it: failed once nobody can pay that invoice anymore, until then it may still start.
      const expiresAt = (decodeBolt11(payment.invoice)?.expiresAt ?? Infinity) * 1000;
      return { state: expiresAt + EXPIRED_MARGIN_MS < Date.now() ? "failed" : "pending" };
    }
    // Our own invoice (a wallet paying itself): not an answer about the payment.
    if (tx.type === "incoming") return { state: "pending" };
    const preimage = typeof tx.preimage === "string" && HEX64.test(tx.preimage.toLowerCase()) ? tx.preimage.toLowerCase() : undefined;
    const proven = !!preimage && hex(sha256(bytes(preimage))) === payment.paymentHash;
    const state = tx.state ?? (tx.settled_at || proven ? "settled" : "pending");
    const fee = isMsat(tx.fees_paid) ? Math.ceil(tx.fees_paid / 1000) : undefined;
    if (state === "settled") {
      if (preimage && !proven) throw new Error("The wallet's proof of payment does not match the invoice");
      return { state: "paid", fee, preimage };
    }
    if (state === "failed" || state === "expired") return { state: "failed" };
    return { state: "pending" };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error("The wallet connection is closed")); }
    this.relay.close();
  }
}

export const nwc: LightningProviderDescriptor = {
  id: "nwc",
  label: "Nostr Wallet Connect",
  kind: "lightning",
  description: "A wallet you connect with its NWC URI (Alby Hub, a node's NWC service, a hosted wallet). That wallet holds the sats and sets its own fee limit: custodial or not depends on the wallet.",
  networks: ["bitcoin", "testnet", "signet", "mutinynet", "regtest"],
  platforms: PROVIDER_PLATFORMS,
  fields: [{
    name: "uri", label: "Connection URI", kind: "secret", placeholder: "nostr+walletconnect://…",
    help: "From your wallet's app connections. Allow making, paying and looking up invoices, and reading the balance.",
  }],
  validate({ secrets }) { parseNwcUri(secrets.uri ?? ""); },
  async create({ secrets }, host) { return NwcLightning.connect(secrets.uri, { signal: host.signal }); },
};
