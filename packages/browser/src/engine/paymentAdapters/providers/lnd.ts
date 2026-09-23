import { base64, base64url, hex } from "@scure/base";
import { decodeBolt11 } from "@ghostly/core";
import type { InvoiceStatus, LightningCapabilities, LightningInfo, LightningInvoice, LightningPayResult, LightningPaymentRef, LightningPaymentStatus, LightningProvider, LightningProviderDescriptor } from "./lightning";
import { NothingSpentError, type ProviderHost, type ProviderNetwork, type ProviderSettings } from "./types";

/**
 * Lightning through the person's own LND node, over its REST API (the gateway LND serves next to gRPC).
 *
 * Two ways to reach it, the same API behind both:
 *  - web and extension: `fetch`. The node must allow Ghostly's origin (`restcors`) and present a certificate
 *    the browser trusts (LND's own is self-signed: a reverse proxy with a real certificate, or LND's
 *    `letsencryptdomain`).
 *  - desktop: the `lnd_request` Tauri command (src-tauri/src/lnd.rs). No CORS, and when a certificate is
 *    given it is pinned: the node must present exactly that one, whatever the address says.
 *
 * The macaroon is read before anything is contacted: one that can do more than Ghostly needs (admin, on-chain
 * sends, baking macaroons) is refused, and what it allows decides what the source can do (an invoice-only
 * macaroon receives and never pays).
 */

export const LND_SOURCE = "lnd";

/** What the recommended macaroon grants: `lncli bakemacaroon info:read invoices:read invoices:write offchain:read offchain:write`. */
export const LND_SCOPE = ["info:read", "invoices:read", "invoices:write", "offchain:read", "offchain:write"];
export const LND_BAKE = `lncli bakemacaroon ${LND_SCOPE.join(" ")}`;
/** Read-only powers a macaroon may carry beyond the scope without being refused: none of them moves money. */
const HARMLESS = new Set(["onchain:read", "address:read", "peers:read", "message:read"]);
/** The RPCs this provider calls, for macaroons scoped by method (`uri:` permissions). */
const URIS = {
  info: "/lnrpc.Lightning/GetInfo",
  addInvoice: "/lnrpc.Lightning/AddInvoice",
  lookupInvoice: "/lnrpc.Lightning/LookupInvoice",
  balance: "/lnrpc.Lightning/ChannelBalance",
  send: "/routerrpc.Router/SendPaymentV2",
  track: "/routerrpc.Router/TrackPaymentV2",
} as const;

/** How long a payment is followed before it is reported `pending` (LND goes on with it), and LND's own limit. */
const PAY_WAIT_MS = 30_000;
const PAY_TIMEOUT_S = 60;
const REQUEST_MS = 15_000;
const INVOICE_EXPIRY_S = 3600;
const MAX_BODY = 1 << 20;

// -- the macaroon ------------------------------------------------------------------

export interface MacaroonOp { entity: string; actions: string[] }
export interface LndMacaroon { hex: string; ops: MacaroonOp[] }

/** Hex (what `lncli` and most node UIs show) or base64 of the binary macaroon. */
export function parseMacaroon(input: string): LndMacaroon {
  const text = input.trim().replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) bytes = hex.decode(text.toLowerCase());
    else bytes = base64.decode(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  } catch { throw new Error("The macaroon must be hex or base64"); }
  const ops = macaroonOps(bytes);
  if (!ops) throw new Error("That is not an LND macaroon");
  return { hex: hex.encode(bytes), ops };
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done() { return this.pos >= this.bytes.length; }
  varint(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (this.done) throw new Error("truncated");
      const b = this.bytes[this.pos++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
    }
    throw new Error("varint too long");
  }
  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.pos) throw new Error("truncated");
    return this.bytes.subarray(this.pos, (this.pos += length));
  }
}

/**
 * The permissions LND wrote into the macaroon's identifier: a V2 binary macaroon whose identifier is a
 * version byte (3) and a `MacaroonId` protobuf `{ nonce = 1; storageId = 2; repeated Op ops = 3 }`, each
 * `Op { entity = 1; repeated actions = 2 }`. Undefined when it is not shaped like that.
 */
function macaroonOps(bytes: Uint8Array): MacaroonOp[] | undefined {
  try {
    const r = new Reader(bytes);
    if (r.varint() !== 2) return undefined;
    let id: Uint8Array | undefined;
    for (let type = r.varint(); type !== 0; type = r.varint()) {
      const data = r.take(r.varint());
      if (type === 2) id = data;
    }
    if (!id || id[0] !== 3) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true });
    const fields = (buf: Uint8Array, each: (field: number, data: Uint8Array) => void) => {
      const p = new Reader(buf);
      while (!p.done) {
        const key = p.varint(), field = Math.floor(key / 8), wire = key & 7;
        if (wire === 2) each(field, p.take(p.varint()));
        else if (wire === 0) p.varint();
        else throw new Error("unexpected wire type");
      }
    };
    const ops: MacaroonOp[] = [];
    fields(id.subarray(1), (field, data) => {
      if (field !== 3) return;
      const op: MacaroonOp = { entity: "", actions: [] };
      fields(data, (f, d) => { if (f === 1) op.entity = text.decode(d); else if (f === 2) op.actions.push(text.decode(d)); });
      ops.push(op);
    });
    return ops.length ? ops : undefined;
  } catch { return undefined; }
}

export interface MacaroonScope { receive: boolean; send: boolean; balance: boolean; info: boolean; excess: string[] }

/** What a macaroon lets this provider do, and what it allows beyond that (which is refused). */
export function macaroonScope(ops: readonly MacaroonOp[]): MacaroonScope {
  const perms = new Set<string>(), uris = new Set<string>();
  for (const op of ops) for (const action of op.actions) {
    if (op.entity === "uri") uris.add(action); else perms.add(`${op.entity}:${action}`);
  }
  const has = (...wanted: string[]) => wanted.every((w) => (w.startsWith("/") ? uris.has(w) : perms.has(w)));
  const used = new Set<string>(Object.values(URIS));
  const excess = [...[...perms].filter((p) => !LND_SCOPE.includes(p) && !HARMLESS.has(p)), ...[...uris].filter((u) => !used.has(u))];
  return {
    info: has("info:read") || has(URIS.info),
    receive: has("invoices:read", "invoices:write") || has(URIS.addInvoice, URIS.lookupInvoice),
    send: has("offchain:read", "offchain:write") || has(URIS.send, URIS.track),
    balance: has("offchain:read") || has(URIS.balance),
    excess,
  };
}

// -- where the node is ---------------------------------------------------------------

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The REST address, normalized: https (plain http only on this machine), no path, no credentials. */
export function parseNodeUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim().includes("://") ? input.trim() : `https://${input.trim()}`); } catch { throw new Error("That is not an address"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.hostname))) throw new Error("The REST address must start with https:// (plain http only for a node on this machine)");
  if (url.username || url.password) throw new Error("Put no credentials in the address: the macaroon is enough");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("Give only the node's address and port, like https://mynode.local:8080");
  return url.origin;
}

/** A certificate as PEM (with or without its line breaks), base64 or hex DER: returned as base64 DER. */
export function parseCertificate(input: string): string {
  const text = input.trim();
  const pem = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(text);
  const body = (pem ? pem[1] : text).replace(/\s+/g, "");
  let der: Uint8Array;
  try { der = /^[0-9a-f]+$/i.test(body) && body.length % 2 === 0 ? hex.decode(body.toLowerCase()) : base64.decode(body); }
  catch { throw new Error("The TLS certificate must be PEM (tls.cert), base64 or hex"); }
  // An X.509 certificate is a DER SEQUENCE; anything else is not one.
  if (der.length < 64 || der[0] !== 0x30) throw new Error("That is not a TLS certificate");
  return base64.encode(der);
}

// -- talking to it -------------------------------------------------------------------

export interface LndRequest {
  method: "GET" | "POST";
  /** `/v1/…` or `/v2/…`, with its query. */
  path: string;
  body?: unknown;
  /**
   * A streaming RPC (newline-delimited JSON): `first` stops at the first message, `final` at a payment's
   * last one (SUCCEEDED, FAILED) or an error. Without it the body is one JSON value.
   */
  stream?: "first" | "final";
  timeoutMs: number;
}
/**
 * `lines`: the JSON values read. `timedOut`: a stream was still open at the deadline (what it said so far
 * is in `lines`). A transport throws only when nothing is known: the node was not reached, or did not
 * answer before the deadline.
 */
export interface LndResponse { status: number; lines: unknown[]; timedOut: boolean }
export interface LndTransport { request(request: LndRequest): Promise<LndResponse>; close(): void }

/** A payment update that ends the `final` stream: a result that will not change, or an error. */
export const isFinalLine = (line: unknown) => {
  const value = line as { error?: unknown; result?: { status?: string } } | null;
  return !!value && (value.error !== undefined || value.result?.status === "SUCCEEDED" || value.result?.status === "FAILED");
};

const parseLine = (text: string): unknown => { try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 200) } }; } };

/** The browser's `fetch`: CORS and the browser's own certificate checks apply. */
export function fetchTransport(url: string, macaroon: string, signal?: AbortSignal): LndTransport {
  const closed = new AbortController();
  return {
    async request({ method, path, body, stream, timeoutMs }) {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DOMException("The node did not answer in time", "TimeoutError")), timeoutMs);
      const signals = [closed.signal, deadline.signal, ...(signal ? [signal] : [])];
      try {
        let response: Response;
        try {
          response = await fetch(url + path, {
            method, signal: AbortSignal.any(signals), redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
            headers: { "Grpc-Metadata-macaroon": macaroon, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
        } catch (error) {
          if (deadline.signal.aborted || closed.signal.aborted || signal?.aborted) throw error;
          const origin = globalThis.location?.origin;
          throw Object.assign(new Error(`Could not reach the node. From a browser it must allow ${origin ? `this origin (restcors=${origin})` : "Ghostly's origin (restcors)"} and have a certificate the browser trusts.`), { cause: error });
        }
        if (!response.body) return { status: response.status, lines: [], timedOut: false };
        const reader = response.body.getReader(), decoder = new TextDecoder();
        const lines: unknown[] = [];
        let buffer = "", read = 0, timedOut = false;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            read += value.length;
            if (read > MAX_BODY) throw new Error("The node's answer is too large");
            buffer += decoder.decode(value, { stream: true });
            if (!stream) continue;
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const text = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
              if (!text) continue;
              lines.push(parseLine(text));
              if (stream === "first" || isFinalLine(lines[lines.length - 1])) { await reader.cancel().catch(() => {}); return { status: response.status, lines, timedOut: false }; }
            }
          }
        } catch (error) {
          // The deadline with a stream open: what was said so far stands. Anything else is not an answer.
          if (!(stream && deadline.signal.aborted && !closed.signal.aborted)) throw error;
          timedOut = true;
        }
        buffer += decoder.decode();
        if (buffer.trim()) lines.push(parseLine(buffer.trim()));
        return { status: response.status, lines, timedOut };
      } finally { clearTimeout(timer); }
    },
    close() { closed.abort(new DOMException("The LND source was closed", "AbortError")); },
  };
}

type Invoke = NonNullable<ProviderHost["invoke"]>;

/** Desktop: Rust makes the request (src-tauri/src/lnd.rs), pinning the certificate when there is one. */
export function tauriTransport(invoke: Invoke, url: string, macaroon: string, certificate?: string): LndTransport {
  let closed = false;
  return {
    async request({ method, path, body, stream, timeoutMs }) {
      if (closed) throw new Error("The LND source was closed");
      const answer = await invoke<{ status: number; lines: string[]; timed_out: boolean }>("lnd_request", {
        url, macaroon, certificate: certificate ?? null, method, path,
        body: body === undefined ? null : JSON.stringify(body), stream: stream ?? null, timeoutMs,
      });
      return { status: answer.status, lines: answer.lines.map(parseLine), timedOut: answer.timed_out };
    },
    close() { closed = true; },
  };
}

// -- the provider --------------------------------------------------------------------

interface RpcError { code?: number; message?: string }
interface Payment { payment_hash?: string; status?: string; fee_sat?: string; fee_msat?: string; payment_preimage?: string; failure_reason?: string }

/** The error in a REST answer: `{code, message}` for a unary call, `{error: {…}}` in a stream. */
const errorOf = (line: unknown): RpcError | undefined => {
  const value = line as ({ error?: RpcError } & RpcError) | null;
  if (!value || typeof value !== "object") return undefined;
  if (value.error && typeof value.error === "object") return value.error;
  if (typeof value.message === "string" && value.code !== undefined) return value;
  return undefined;
};
const describe = (error: RpcError) => (error.message ?? "unknown error").slice(0, 200);
/**
 * LND's own words for a payment it never started (ErrPaymentNotInitiated). Only these: a proxy's "404 not
 * found" in front of the node says nothing about the payment, and must not become "nothing was spent".
 */
const notInitiated = (error: RpcError) => /payment isn't initiated/i.test(error.message ?? "");
const sats = (value: unknown) => { const n = Number(value ?? 0); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
const feeOf = (p: Payment) => (p.fee_msat !== undefined ? Math.ceil(Number(p.fee_msat) / 1000) : sats(p.fee_sat));
const FAILURES: Record<string, string> = {
  FAILURE_REASON_NO_ROUTE: "No route to the recipient within the fee limit",
  FAILURE_REASON_INSUFFICIENT_BALANCE: "Not enough outbound liquidity in the node's channels",
  FAILURE_REASON_TIMEOUT: "The node gave up finding a route",
  FAILURE_REASON_INCORRECT_PAYMENT_DETAILS: "The recipient refused the payment (unknown or already paid invoice)",
  FAILURE_REASON_ERROR: "The payment failed",
  FAILURE_REASON_CANCELED: "The payment was canceled",
};

const NETWORKS: Record<string, ProviderNetwork> = { mainnet: "bitcoin", testnet: "testnet", testnet4: "testnet", signet: "signet", regtest: "regtest" };

export class LndLightning implements LightningProvider {
  readonly capabilities: LightningCapabilities;

  constructor(private readonly transport: LndTransport, scope: Pick<MacaroonScope, "receive" | "send" | "balance">) {
    this.capabilities = { receive: scope.receive, send: scope.send, balance: scope.balance, lookup: true };
  }

  /** A unary call: the JSON answer, or an Error with LND's message. */
  private async call<T>(method: LndRequest["method"], path: string, body?: unknown): Promise<T> {
    const { status, lines } = await this.transport.request({ method, path, body, timeoutMs: REQUEST_MS });
    const error = errorOf(lines[0]);
    if (status !== 200 || error) throw new Error(error ? `LND: ${describe(error)}` : `LND answered ${status}`);
    return lines[0] as T;
  }

  async info(): Promise<LightningInfo> {
    const info = await this.call<{ alias?: string; chains?: { chain?: string; network?: string }[] }>("GET", "/v1/getinfo");
    const chain = info.chains?.[0];
    if (chain?.chain !== "bitcoin") throw new Error(`The node runs on ${chain?.chain ?? "an unknown chain"}, not Bitcoin`);
    const network = NETWORKS[chain.network ?? ""];
    if (!network) throw new Error(`The node runs on ${chain.network ?? "an unknown network"}, which Ghostly does not support`);
    let balance: number | undefined;
    if (this.capabilities.balance) balance = sats((await this.call<{ local_balance?: { sat?: string } }>("GET", "/v1/balance/channels")).local_balance?.sat);
    return { network, alias: info.alias?.slice(0, 64) || undefined, balance };
  }

  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invoices need a whole number of sats");
    const created = await this.call<{ r_hash?: string; payment_request?: string; add_index?: string }>("POST", "/v1/invoices", { value: String(amount), memo: memo?.slice(0, 200) ?? "", expiry: String(INVOICE_EXPIRY_S) });
    const invoice = created.payment_request ?? "";
    const decoded = decodeBolt11(invoice);
    const paymentHash = created.r_hash ? hex.encode(base64.decode(created.r_hash)) : "";
    if (!decoded?.paymentHash || decoded.paymentHash !== paymentHash) throw new Error("The node returned an invoice that does not match its payment hash");
    return { invoice, paymentHash, amount, expiresAt: decoded.expiresAt * 1000, ref: created.add_index };
  }

  async invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus> {
    if (!/^[0-9a-f]{64}$/.test(invoice.paymentHash)) throw new Error("Not a payment hash");
    const found = await this.call<{ state?: string; amt_paid_sat?: string; creation_date?: string; expiry?: string }>("GET", `/v1/invoice/${invoice.paymentHash}`);
    if (found.state === "SETTLED") return { state: "paid", amount: sats(found.amt_paid_sat) };
    if (found.state === "CANCELED") return { state: "expired" };
    const expiresAt = found.creation_date && found.expiry ? (Number(found.creation_date) + Number(found.expiry)) * 1000 : invoice.expiresAt;
    return { state: expiresAt < Date.now() ? "expired" : "open" };
  }

  /**
   * SendPaymentV2, followed until it ends or for PAY_WAIT_MS (then `pending`: LND goes on by itself).
   * FAILED is LND's final word, given only once every HTLC has come back: nothing was spent. An error the
   * node answered is checked against TrackPaymentV2: a payment it never started spent nothing, one it knows
   * of is reported as it stands. A node that did not answer at all is an unknown outcome (a plain throw).
   */
  async payInvoice(invoice: string, maxFee: number): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    if (!decoded?.paymentHash) throw new NothingSpentError("That is not a Lightning invoice");
    if (decoded.amountSat === null) throw new NothingSpentError("Invoices without an amount are not supported");
    if (!Number.isSafeInteger(maxFee) || maxFee < 0) throw new NothingSpentError("Invalid fee limit");
    const { status, lines, timedOut } = await this.transport.request({
      method: "POST", path: "/v2/router/send", stream: "final", timeoutMs: PAY_WAIT_MS,
      body: { payment_request: decoded.invoice, fee_limit_sat: String(maxFee), timeout_seconds: PAY_TIMEOUT_S, no_inflight_updates: false, allow_self_payment: false },
    });
    const last = lines[lines.length - 1];
    const error = errorOf(last);
    if (!error && status === 200 && lines.length) {
      const payment = (last as { result?: Payment }).result ?? {};
      if (payment.status === "SUCCEEDED") return { state: "paid", fee: feeOf(payment), preimage: payment.payment_preimage };
      if (payment.status === "FAILED") throw new NothingSpentError(FAILURES[payment.failure_reason ?? ""] ?? "The payment failed");
      // IN_FLIGHT or INITIATED at the deadline: the node has it.
      return { state: "pending" };
    }
    if (timedOut && !lines.length) throw new Error("The node did not answer in time");
    // The node refused the call (expired, invalid, already paid, in flight…): only it knows whether a payment exists.
    const now = await this.track(decoded.paymentHash);
    if (now.state === "missing" || now.state === "failed") throw new NothingSpentError(error ? `LND: ${describe(error)}` : `LND answered ${status}`);
    return now.state === "paid" ? { state: "paid", fee: now.fee, preimage: now.preimage } : { state: "pending" };
  }

  async paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus> {
    const now = await this.track(payment.paymentHash);
    // A payment the node never started is not going anywhere.
    return now.state === "missing" ? { state: "failed" } : now;
  }

  /** TrackPaymentV2's first message: where the payment stands now. Throws when the node cannot say. */
  private async track(paymentHash: string): Promise<LightningPaymentStatus | { state: "missing" }> {
    if (!/^[0-9a-f]{64}$/.test(paymentHash)) throw new Error("Not a payment hash");
    // The REST gateway reads bytes in a path as padded base64 (URL-safe accepted): the padding is escaped.
    const hash = base64url.encode(hex.decode(paymentHash)).replace(/=/g, "%3D");
    const { status, lines } = await this.transport.request({ method: "GET", path: `/v2/router/track/${hash}?no_inflight_updates=false`, stream: "first", timeoutMs: REQUEST_MS });
    const error = errorOf(lines[0]);
    if (error) { if (notInitiated(error)) return { state: "missing" }; throw new Error(`LND: ${describe(error)}`); }
    const result = (lines[0] as { result?: Payment } | undefined)?.result;
    if (status !== 200 || !result) throw new Error(`LND answered ${status}`);
    if (result.status === "SUCCEEDED") return { state: "paid", fee: feeOf(result), preimage: result.payment_preimage };
    if (result.status === "FAILED") return { state: "failed" };
    return { state: "pending" };
  }

  async close() { this.transport.close(); }
}

export interface LndSettings { url: string; macaroon: LndMacaroon; scope: MacaroonScope; certificate?: string }

/** Everything the form says, checked before the node is contacted. Throws a message fit for the person. */
export function lndSettings({ config, secrets }: ProviderSettings): LndSettings {
  const url = parseNodeUrl(config.url ?? "");
  const macaroon = parseMacaroon(secrets.macaroon ?? "");
  const scope = macaroonScope(macaroon.ops);
  if (scope.excess.length) throw new Error(`This macaroon can do more than Ghostly needs (${scope.excess.slice(0, 4).join(", ")}${scope.excess.length > 4 ? "…" : ""}). Bake one for it: ${LND_BAKE}`);
  if (!scope.info || (!scope.receive && !scope.send)) throw new Error(`This macaroon does not allow what Ghostly needs. Bake one for it: ${LND_BAKE}`);
  return { url, macaroon, scope, certificate: secrets.certificate ? parseCertificate(secrets.certificate) : undefined };
}

export const lnd: LightningProviderDescriptor = {
  id: LND_SOURCE,
  label: "LND node",
  kind: "lightning",
  description: "Your own LND node, over its REST API. Your node holds the sats.",
  networks: ["bitcoin", "testnet", "signet", "regtest"],
  platforms: ["web", "extension", "desktop"],
  fields: [
    { name: "url", label: "REST address", kind: "url", placeholder: "https://mynode.local:8080",
      help: "LND's REST port (restlisten, 8080 by default). In a browser the node must allow this app with restcors and have a certificate the browser trusts; the desktop app needs neither." },
    { name: "macaroon", label: "Macaroon (hex)", kind: "secret", placeholder: "0201036c6e64…",
      help: `Never the admin macaroon: bake one with ${LND_BAKE} (only invoices:… to receive only).` },
    { name: "certificate", label: "TLS certificate", kind: "secret", optional: true, placeholder: "-----BEGIN CERTIFICATE-----…",
      help: "Desktop: the node's tls.cert, pinned (the node must present exactly this one). Leave empty for a certificate from a public authority." },
  ],
  experimental: true,
  validate(settings) { lndSettings(settings); },
  async create(settings, host) {
    const { url, macaroon, scope, certificate } = lndSettings(settings);
    const transport = host.platform === "desktop" && host.invoke
      ? tauriTransport(host.invoke, url, macaroon.hex, certificate)
      : fetchTransport(url, macaroon.hex, host.signal);
    return new LndLightning(transport, scope);
  },
};
