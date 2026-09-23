import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11 } from "@ghostly/core";
import * as nip04 from "nostr-tools/nip04";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { fakeInvoice } from "../../src/engine/paymentAdapters/providers/testing";

/**
 * A Nostr relay and a Nostr Wallet Connect (NIP-47) wallet service, both in the test process, for the NWC
 * provider's contract suite and its e2e without a node: regtest "sats" in memory, nothing leaves the
 * machine. Wallets started here form one little network: paying another fake wallet's invoice settles it
 * and hands back its real preimage; any other invoice has no route.
 */

type Filter = { kinds?: number[]; authors?: string[]; ids?: string[]; since?: number; until?: number; limit?: number } & Record<`#${string}`, string[] | undefined>;

const matches = (event: Event, filter: Filter) =>
  (!filter.kinds || filter.kinds.includes(event.kind)) &&
  (!filter.authors || filter.authors.includes(event.pubkey)) &&
  (!filter.ids || filter.ids.includes(event.id)) &&
  (filter.since === undefined || event.created_at >= filter.since) &&
  (filter.until === undefined || event.created_at <= filter.until) &&
  Object.entries(filter).every(([key, values]) => !key.startsWith("#") || !Array.isArray(values) || event.tags.some((t) => t[0] === key.slice(1) && (values as string[]).includes(t[1])));

/** A NIP-01 relay: stores regular and replaceable events, passes ephemeral ones (NWC requests and answers) on. */
export class TestRelay {
  /** Every event it was sent, in order: a test can read the requests a provider made. */
  readonly received: Event[] = [];
  private readonly stored: Event[] = [];
  private readonly server: Server;
  private readonly sockets = new Map<WebSocket, Map<string, Filter>>();
  /** Answer `OK false` with this reason to the events it returns one for. */
  refuse?: (event: Event) => string | undefined;
  /** Never answer `OK` (a relay that loses its acknowledgements). */
  silent = false;
  url = "";

  private constructor() {
    this.server = createServer((_, response) => { response.writeHead(426); response.end(); });
    const wss = new WebSocketServer({ server: this.server, maxPayload: 512 * 1024 });
    wss.on("connection", (socket) => {
      const subs = new Map<string, Filter>();
      this.sockets.set(socket, subs);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("message", (raw) => {
        let message: unknown[];
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message[0] === "REQ") {
          const id = String(message[1]), filter = (message[2] ?? {}) as Filter;
          subs.set(id, filter);
          const found = this.stored.filter((e) => matches(e, filter)).sort((a, b) => b.created_at - a.created_at).slice(0, filter.limit ?? 500);
          for (const event of found) socket.send(JSON.stringify(["EVENT", id, event]));
          socket.send(JSON.stringify(["EOSE", id]));
        } else if (message[0] === "CLOSE") subs.delete(String(message[1]));
        else if (message[0] === "EVENT") this.accept(socket, message[1] as Event);
      });
    });
  }

  static async start(port = 0): Promise<TestRelay> {
    const relay = new TestRelay();
    await new Promise<void>((resolve) => relay.server.listen(port, "127.0.0.1", resolve));
    relay.url = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
    return relay;
  }

  private accept(from: WebSocket, event: Event) {
    if (!event || !verifyEvent(event)) { from.send(JSON.stringify(["OK", event?.id ?? "", false, "invalid: bad signature"])); return; }
    this.received.push(event);
    const refusal = this.refuse?.(event);
    if (refusal) { from.send(JSON.stringify(["OK", event.id, false, refusal])); return; }
    if (!this.silent) from.send(JSON.stringify(["OK", event.id, true, ""]));
    this.publish(event);
  }

  /** Stores (unless ephemeral) and sends to every matching subscription, signature checked or not. */
  publish(event: Event) {
    if (event.kind >= 10000 && event.kind < 20000) {
      const old = this.stored.findIndex((e) => e.kind === event.kind && e.pubkey === event.pubkey);
      if (old >= 0) this.stored.splice(old, 1);
    }
    if (event.kind < 20000 || event.kind >= 30000) this.stored.push(event);
    for (const [socket, subs] of this.sockets) for (const [id, filter] of subs) if (matches(event, filter)) socket.send(JSON.stringify(["EVENT", id, event]));
  }

  /** Drops every connection (clients must reconnect). */
  disconnectAll() { for (const socket of this.sockets.keys()) socket.terminate(); }

  async close() {
    this.disconnectAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * How the fake wallet answers `pay_invoice`:
 *  - settle:  pays (when it can), answers with the preimage.
 *  - hang:    pays, and its answer is lost (never sent).
 *  - silent:  never hears of it: no payment, no answer.
 *  - fail:    fails the payment and says PAYMENT_FAILED; `lookup_invoice` says failed.
 *  - timeout: says PAYMENT_FAILED (a timeout on its side) while the payment is still in flight.
 *  - internal: pays, and answers INTERNAL.
 *  - refuse:  answers `refuseCode` before trying.
 */
export type FakeNwcBehaviour = "settle" | "hang" | "silent" | "fail" | "timeout" | "internal" | "refuse";

export interface FakeNwcOptions {
  /** Sats. */
  balance?: number;
  /** The info event's `encryption` tag; `null` leaves it out (a NIP-04-only wallet). */
  encryption?: string | null;
  methods?: string[];
  /** What `get_info` says; `null` leaves the field out. */
  network?: string | null;
  alias?: string;
  behaviour?: FakeNwcBehaviour;
  refuseCode?: string;
  /** Routing fee in millisats charged per payment. */
  feeMsat?: number;
}

interface Incoming { invoice: string; paymentHash: string; preimage: string; amountMsat: number; createdAt: number; expiresAt: number; settledAt?: number }
interface Outgoing { invoice: string; paymentHash: string; amountMsat: number; state: "pending" | "settled" | "failed"; preimage?: string; feeMsat: number; createdAt: number; settledAt?: number }

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const now = () => Math.floor(Date.now() / 1000);
export const ALL_METHODS = ["get_info", "get_balance", "make_invoice", "pay_invoice", "lookup_invoice"];

export class FakeNwcWallet {
  /** Every fake wallet's invoices, by payment hash: the whole "Lightning network" of a test. */
  static readonly network = new Map<string, { wallet: FakeNwcWallet; incoming: Incoming }>();
  readonly key = generateSecretKey();
  readonly pubkey = getPublicKey(this.key);
  readonly incoming = new Map<string, Incoming>();
  readonly outgoing = new Map<string, Outgoing>();
  /** The requests it read, in order (method and the encryption they came in). */
  readonly requests: { method: string; encryption: string; client: string }[] = [];
  /** Ignore every request (a test answers by hand with `respond`). */
  mute = false;
  balanceMsat: number;
  behaviour: FakeNwcBehaviour;
  private readonly clients = new Set<string>();
  private socket?: WebSocket;
  private closed = false;

  private constructor(readonly relayUrl: string, readonly options: FakeNwcOptions) {
    this.balanceMsat = (options.balance ?? 100_000) * 1000;
    this.behaviour = options.behaviour ?? "settle";
  }

  static async start(relayUrl: string, options: FakeNwcOptions = {}): Promise<FakeNwcWallet> {
    const wallet = new FakeNwcWallet(relayUrl, options);
    await wallet.connect();
    return wallet;
  }

  private async connect() {
    const socket = new WebSocket(this.relayUrl);
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    this.socket = socket;
    socket.on("message", (raw) => {
      let message: unknown[];
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message[0] === "EVENT" && message[1] === "requests") void this.handle(message[2] as Event);
    });
    socket.on("close", () => { if (!this.closed) setTimeout(() => void this.connect().catch(() => {}), 100); });
    socket.send(JSON.stringify(["REQ", "requests", { kinds: [23194], "#p": [this.pubkey] }]));
    const encryption = this.options.encryption === undefined ? "nip44_v2 nip04" : this.options.encryption;
    this.send(finalizeEvent({ kind: 13194, created_at: now(), tags: encryption === null ? [] : [["encryption", encryption]], content: (this.options.methods ?? ALL_METHODS).join(" ") }, this.key));
  }

  /** A new app connection: its URI (a fresh client key, allowed from now on). */
  uri(relayUrl = this.relayUrl): string {
    const secret = generateSecretKey();
    this.clients.add(getPublicKey(secret));
    return `nostr+walletconnect://${this.pubkey}?relay=${encodeURIComponent(relayUrl)}&secret=${hex(secret)}`;
  }

  private send(event: Event) { this.socket?.send(JSON.stringify(["EVENT", event])); }

  /** Sats it holds. */
  get balance() { return Math.floor(this.balanceMsat / 1000); }

  /** Someone outside the fake network paid this invoice of ours. */
  markPaid(paymentHash: string) {
    const invoice = this.incoming.get(paymentHash);
    if (!invoice || invoice.settledAt) return;
    invoice.settledAt = now();
    this.balanceMsat += invoice.amountMsat;
  }

  /** An invoice of this wallet, for someone else to pay. */
  makeInvoice(amountSat: number, description = "", expirySeconds = 3600): Incoming {
    const preimage = crypto.getRandomValues(new Uint8Array(32)), hash = sha256(preimage);
    const created = now();
    const incoming: Incoming = { invoice: fakeInvoice(amountSat, hash, description, expirySeconds), paymentHash: hex(hash), preimage: hex(preimage), amountMsat: amountSat * 1000, createdAt: created, expiresAt: created + expirySeconds };
    this.incoming.set(incoming.paymentHash, incoming);
    FakeNwcWallet.network.set(incoming.paymentHash, { wallet: this, incoming });
    return incoming;
  }

  private async handle(event: Event) {
    if (this.mute || !verifyEvent(event) || !this.clients.has(event.pubkey)) return;
    const encryption = event.tags.find((t) => t[0] === "encryption")?.[1] ?? "nip04";
    let request: { method: string; params: Record<string, unknown> };
    try {
      request = JSON.parse(encryption === "nip44_v2" ? nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(this.key, event.pubkey)) : nip04.decrypt(this.key, event.pubkey, event.content));
    } catch { return; }
    this.requests.push({ method: request.method, encryption, client: event.pubkey });
    const answer = this.execute(request.method, request.params ?? {});
    if (answer) this.respond(event, { result_type: request.method, ...answer });
  }

  /** Sends an answer to `request`, encrypted the way it came. `key` and `tags` let a test forge one; `send: false` only builds it. */
  respond(request: Event, body: Record<string, unknown>, { key = this.key, tags, send = true }: { key?: Uint8Array; tags?: string[][]; send?: boolean } = {}) {
    const nip44Used = request.tags.some((t) => t[0] === "encryption" && t[1] === "nip44_v2");
    const content = JSON.stringify(body);
    const encrypted = nip44Used ? nip44.v2.encrypt(content, nip44.v2.utils.getConversationKey(key, request.pubkey)) : nip04.encrypt(key, request.pubkey, content);
    const event = finalizeEvent({ kind: 23195, created_at: now(), tags: tags ?? [["p", request.pubkey], ["e", request.id]], content: encrypted }, key);
    if (send) this.send(event);
    return event;
  }

  private execute(method: string, params: Record<string, unknown>): { result?: unknown; error?: { code: string; message: string } } | undefined {
    const error = (code: string, message: string) => ({ error: { code, message } });
    if (!(this.options.methods ?? ALL_METHODS).includes(method)) return error("NOT_IMPLEMENTED", `${method} is not supported`);
    switch (method) {
      case "get_info": {
        const network = this.options.network === undefined ? "regtest" : this.options.network;
        return { result: { alias: this.options.alias ?? "Fake NWC", pubkey: this.pubkey, block_height: 1, methods: this.options.methods ?? ALL_METHODS, ...(network === null ? {} : { network }) } };
      }
      case "get_balance": return { result: { balance: this.balanceMsat } };
      case "make_invoice": {
        const amount = Number(params.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 1000) return error("OTHER", "Amounts are whole sats here");
        const incoming = this.makeInvoice(amount / 1000, String(params.description ?? ""), Number(params.expiry) || 3600);
        return { result: { type: "incoming", state: "pending", invoice: incoming.invoice, payment_hash: incoming.paymentHash, amount: incoming.amountMsat, fees_paid: 0, created_at: incoming.createdAt, expires_at: incoming.expiresAt } };
      }
      case "lookup_invoice": {
        const hash = String(params.payment_hash ?? decodeBolt11(String(params.invoice ?? ""))?.paymentHash ?? "");
        const outgoing = this.outgoing.get(hash), incoming = this.incoming.get(hash);
        if (outgoing) return { result: { type: "outgoing", state: outgoing.state, invoice: outgoing.invoice, payment_hash: hash, amount: outgoing.amountMsat, fees_paid: outgoing.feeMsat, created_at: outgoing.createdAt, settled_at: outgoing.settledAt ?? null, ...(outgoing.preimage ? { preimage: outgoing.preimage } : {}) } };
        if (incoming) {
          const state = incoming.settledAt ? "settled" : incoming.expiresAt < now() ? "expired" : "pending";
          return { result: { type: "incoming", state, invoice: incoming.invoice, payment_hash: hash, amount: incoming.amountMsat, fees_paid: 0, created_at: incoming.createdAt, expires_at: incoming.expiresAt, settled_at: incoming.settledAt ?? null, preimage: incoming.preimage } };
        }
        return error("NOT_FOUND", "No such invoice");
      }
      case "pay_invoice": return this.pay(String(params.invoice ?? ""));
      default: return error("NOT_IMPLEMENTED", `${method} is not supported`);
    }
  }

  private pay(text: string) {
    const error = (code: string, message: string) => ({ error: { code, message } });
    const decoded = decodeBolt11(text);
    if (!decoded?.paymentHash || decoded.amountMsat === null) return error("OTHER", "Not an invoice this wallet can pay");
    const behaviour = this.behaviour, hash = decoded.paymentHash, amountMsat = Number(decoded.amountMsat), feeMsat = this.options.feeMsat ?? 0;
    if (behaviour === "silent") return undefined;
    if (behaviour === "refuse") return error(this.options.refuseCode ?? "RESTRICTED", "Refused (fake)");
    if (this.outgoing.get(hash)?.state === "settled") return error("OTHER", "Already paid");
    if (amountMsat + feeMsat > this.balanceMsat) return error("INSUFFICIENT_BALANCE", "Not enough sats (fake)");
    const payment: Outgoing = { invoice: decoded.invoice, paymentHash: hash, amountMsat, state: "pending", feeMsat, createdAt: now() };
    this.outgoing.set(hash, payment);
    if (behaviour === "timeout") return error("PAYMENT_FAILED", "Timed out (fake)");
    const payee = FakeNwcWallet.network.get(hash);
    if (behaviour === "fail" || !payee || payee.wallet.closed || payee.incoming.settledAt) { payment.state = "failed"; return error("PAYMENT_FAILED", "No route (fake)"); }
    payee.wallet.markPaid(hash);
    this.balanceMsat -= amountMsat + feeMsat;
    Object.assign(payment, { state: "settled", preimage: payee.incoming.preimage, settledAt: now() });
    if (behaviour === "hang") return undefined;
    if (behaviour === "internal") return error("INTERNAL", "Something broke (fake)");
    return { result: { preimage: payee.incoming.preimage, fees_paid: feeMsat } };
  }

  async close() {
    this.closed = true;
    this.socket?.close();
    for (const hash of this.incoming.keys()) FakeNwcWallet.network.delete(hash);
  }
}
