import { bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11, type Bolt11Invoice } from "./bolt11";

/**
 * Paying a Lightning address or an LNURL: the payer's side of
 * [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md) (`name@domain`),
 * [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md) (`payRequest`),
 * [LUD-01](https://github.com/lnurl/luds/blob/luds/01.md) (`lnurl1…` bech32),
 * [LUD-17](https://github.com/lnurl/luds/blob/luds/17.md) (`lnurlp://`),
 * [LUD-12](https://github.com/lnurl/luds/blob/luds/12.md) (a comment) and
 * [LUD-09](https://github.com/lnurl/luds/blob/luds/09.md) (a success message).
 *
 * Resolving reveals the request to the service's domain (it is an HTTPS fetch), so the domain is part of
 * what a person is shown before anything is fetched. Everything the service answers is checked: the
 * amounts it allows, the invoice it returns (its amount, and that it commits to the metadata the person
 * saw), and how much of it is read at all. Paying then goes through the active Lightning source like any
 * other invoice. Receiving on a Lightning address needs a server the person runs; it is not here.
 */

export interface LightningDestination {
  kind: "address" | "lnurl";
  /** What was pasted, normalised: a lower-cased `name@domain`, or the `lnurl…` / `lnurlp://…` text. */
  text: string;
  /** Where the pay request is fetched from. */
  url: string;
  /** The host that learns about the request. */
  domain: string;
  /** LUD-16: the part before the `@`. */
  name?: string;
}

export interface LnurlSuccessAction {
  tag: "message" | "url";
  message?: string;
  description?: string;
  url?: string;
}

/** A service's `payRequest`, checked. Amounts in `minSendable`/`maxSendable` are millisats, `minSat`/`maxSat` whole sats. */
export interface LnurlPayParams {
  destination: LightningDestination;
  callback: string;
  /** The host the invoice is asked from, when it is not the one that answered. */
  callbackDomain: string;
  minSendable: number;
  maxSendable: number;
  minSat: number;
  maxSat: number;
  /** The metadata string as the service sent it: what the invoice must commit to. */
  metadata: string;
  /** sha256 of `metadata`, hex: the invoice's `h` tag when it has one. */
  descriptionHash: string;
  /** The `text/plain` entry: what the payment is for, as the service says. */
  description: string;
  /** The `text/identifier` or `text/email` entry, when the service names an address. */
  identifier?: string;
  /** LUD-12: how long a comment may be; 0 when none is taken. */
  commentAllowed: number;
}

export interface LnurlFetchOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export const LNURL_LIMITS = { timeoutMs: 15_000, maxBytes: 64 * 1024, maxUrlLength: 2048, maxMetadataLength: 8 * 1024, maxComment: 2000 } as const;

const ADDRESS = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?)$/i;
const LNURL_BECH32 = /^lnurl1[02-9ac-hj-np-z]{6,}$/i;
/** A Lightning address or LNURL inside free text: `lightning:` and `⚡` prefixes are tolerated. */
export const LIGHTNING_DESTINATION_PATTERN = /(?:lightning:|lnurlp:\/\/|lnurl1|[a-z0-9._+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i;

const isLoopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

/** HTTPS, or plain HTTP only for a hidden service or a test server on this machine; never credentials. */
function acceptUrl(text: string): URL {
  if (text.length > LNURL_LIMITS.maxUrlLength) throw new Error("That LNURL is too long");
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("That LNURL does not point to a valid address"); }
  const plainAllowed = url.hostname.endsWith(".onion") || isLoopback(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && plainAllowed)) throw new Error("Lightning addresses and LNURLs must use HTTPS");
  if (url.username || url.password) throw new Error("That LNURL carries credentials, which is not allowed");
  return url;
}

/** Reads what was pasted as a Lightning address or an LNURL; null when it is neither. Throws when it is one, but a bad one. */
export function parseLightningDestination(input: string): LightningDestination | null {
  const text = input.trim().replace(/^(lightning:|⚡\s*)/i, "").trim();
  if (!text) return null;
  if (LNURL_BECH32.test(text)) {
    let decoded: { prefix: string; words: number[] };
    try { decoded = bech32.decode(text.toLowerCase() as `${string}1${string}`, LNURL_LIMITS.maxUrlLength); }
    catch { throw new Error("That LNURL is not valid"); }
    const url = acceptUrl(new TextDecoder().decode(bech32.fromWords(decoded.words)));
    return { kind: "lnurl", text: text.toLowerCase(), url: url.href, domain: url.host };
  }
  if (/^lnurlp:\/\//i.test(text)) {
    const bare = text.slice("lnurlp://".length);
    const host = bare.split(/[/?#]/)[0].toLowerCase();
    const scheme = host.endsWith(".onion") || isLoopback(host.replace(/:\d+$/, "")) ? "http" : "https";
    const url = acceptUrl(`${scheme}://${bare}`);
    return { kind: "lnurl", text: `lnurlp://${bare}`, url: url.href, domain: url.host };
  }
  const address = ADDRESS.exec(text);
  if (!address) return null;
  const name = address[1].toLowerCase(), domain = address[2].toLowerCase();
  const hostname = domain.replace(/:\d+$/, "");
  if (!hostname.includes(".") && !isLoopback(hostname)) return null;
  const scheme = hostname.endsWith(".onion") || isLoopback(hostname) ? "http" : "https";
  const url = acceptUrl(`${scheme}://${domain}/.well-known/lnurlp/${name}`);
  return { kind: "address", text: `${name}@${domain}`, url: url.href, domain: url.host, name };
}

/** The first Lightning address or LNURL in a message, with whatever else the message says. */
export function findLightningDestination(text: string): { destination: LightningDestination; rest: string } | null {
  const match = LIGHTNING_DESTINATION_PATTERN.exec(text);
  if (!match) return null;
  // Take the whole token the match starts in: an lnurl runs to the next space, an address stops at its domain.
  const start = match.index, end = text.slice(start).search(/\s|$/);
  // The sentence's closing punctuation stays out, taken off one by one: `/[…]+$/` retries from every character of a
  // long run that does not reach the end, which is quadratic.
  let stop = start + end;
  while (stop > start && "),.;:!?".includes(text[stop - 1])) stop--;
  const token = text.slice(start, stop);
  let destination: LightningDestination | null;
  try { destination = parseLightningDestination(token); } catch { return null; }
  if (!destination) return null;
  return { destination, rest: (text.slice(0, start) + text.slice(start + token.length)).trim() };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const reason = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 200) : "");
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("The server's answer is too large");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error("The server's answer is too large"); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

/** One GET to an LNURL service: bounded in time and size, no credentials, no referrer, and the answer must be JSON. */
export async function fetchLnurlJson(url: string, options: LnurlFetchOptions = {}): Promise<unknown> {
  const target = acceptUrl(url);
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error("No way to reach the network here");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("The server took too long to answer")), options.timeoutMs ?? LNURL_LIMITS.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await doFetch(target.href, { signal: controller.signal, headers: { accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow" });
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("The request was cancelled");
      throw new Error(`Could not reach ${target.host}. It may be down, or not allow web apps to read it (CORS).`);
    }
    // A redirect may not lead somewhere plain HTTP or with credentials.
    if (response.url) acceptUrl(response.url);
    const text = await readBounded(response, options.maxBytes ?? LNURL_LIMITS.maxBytes);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`${target.host} did not answer with JSON${response.ok ? "" : ` (HTTP ${response.status})`}`); }
    if (isRecord(body) && body.status === "ERROR") throw new Error(`${target.host} refused: ${reason(body.reason) || "no reason given"}`);
    if (!response.ok) throw new Error(`${target.host} answered HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Checks a service's `payRequest` answer (LUD-06), and reads what a person needs to see of it. */
export function parsePayParams(body: unknown, destination: LightningDestination): LnurlPayParams {
  if (!isRecord(body)) throw new Error(`${destination.domain} did not answer with a pay request`);
  if (body.tag !== "payRequest") throw new Error(`${destination.domain} answered with something other than a pay request${typeof body.tag === "string" ? ` (${reason(body.tag)})` : ""}`);
  if (typeof body.callback !== "string") throw new Error("The pay request has no callback");
  const callback = acceptUrl(body.callback);
  const { minSendable, maxSendable, metadata, commentAllowed } = body;
  if (!Number.isSafeInteger(minSendable) || !Number.isSafeInteger(maxSendable) || (minSendable as number) <= 0 || (maxSendable as number) < (minSendable as number)) throw new Error("The pay request has invalid amount limits");
  const minSat = Math.ceil((minSendable as number) / 1000), maxSat = Math.floor((maxSendable as number) / 1000);
  if (minSat > maxSat) throw new Error("The pay request only takes fractions of a sat, which cannot be paid here");
  if (typeof metadata !== "string" || metadata.length > LNURL_LIMITS.maxMetadataLength) throw new Error("The pay request has no usable metadata");
  let entries: unknown;
  try { entries = JSON.parse(metadata); } catch { throw new Error("The pay request's metadata is not JSON"); }
  if (!Array.isArray(entries) || !entries.every((e) => Array.isArray(e) && typeof e[0] === "string")) throw new Error("The pay request's metadata is malformed");
  const entry = (type: string) => (entries as unknown[][]).find((e) => e[0] === type)?.[1];
  const description = entry("text/plain");
  if (typeof description !== "string") throw new Error("The pay request says nothing about what it is for (no text/plain metadata)");
  const identifier = [entry("text/identifier"), entry("text/email")].find((v): v is string => typeof v === "string")?.toLowerCase();
  if (destination.kind === "address" && identifier && identifier !== destination.text) throw new Error(`${destination.domain} answered for ${identifier}, not ${destination.text}`);
  const comment = Number.isSafeInteger(commentAllowed) && (commentAllowed as number) > 0 ? Math.min(commentAllowed as number, LNURL_LIMITS.maxComment) : 0;
  return {
    destination, callback: callback.href, callbackDomain: callback.host,
    minSendable: minSendable as number, maxSendable: maxSendable as number, minSat, maxSat,
    metadata, descriptionHash: hex(sha256(new TextEncoder().encode(metadata))), description: description.slice(0, 280), identifier, commentAllowed: comment,
  };
}

/** Where to ask for the invoice of `amountSat` (and a comment, LUD-12). Throws when the amount or comment is not allowed. */
export function invoiceCallbackUrl(params: LnurlPayParams, amountSat: number, comment?: string): string {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) throw new Error("Enter a whole number of sats");
  if (amountSat < params.minSat || amountSat > params.maxSat) throw new Error(params.minSat === params.maxSat ? `${params.destination.domain} asks for exactly ${params.minSat.toLocaleString()} sats` : `${params.destination.domain} takes between ${params.minSat.toLocaleString()} and ${params.maxSat.toLocaleString()} sats`);
  const url = new URL(params.callback);
  url.searchParams.set("amount", String(amountSat * 1000));
  const text = comment?.trim();
  if (text) {
    if (!params.commentAllowed) throw new Error(`${params.destination.domain} does not take a comment`);
    if (text.length > params.commentAllowed) throw new Error(`The comment can be at most ${params.commentAllowed} characters`);
    url.searchParams.set("comment", text);
  }
  return url.href;
}

/**
 * Checks the invoice a service answered with (LUD-06): the amount asked, a payment hash, not expired, and
 * a commitment to the metadata the person was shown: the `h` tag is its sha256, or the invoice carries the
 * metadata itself as its description (the same commitment, unhashed).
 */
export function parseInvoiceCallback(body: unknown, params: LnurlPayParams, amountSat: number): { invoice: Bolt11Invoice; successAction?: LnurlSuccessAction } {
  if (!isRecord(body) || typeof body.pr !== "string") throw new Error(`${params.callbackDomain} did not answer with an invoice`);
  const invoice = decodeBolt11(body.pr);
  if (!invoice) throw new Error(`${params.callbackDomain} answered with an invoice that does not decode`);
  if (invoice.amountMsat !== BigInt(amountSat) * 1000n) throw new Error(`The invoice asks for ${invoice.amountSat === null ? "any amount" : `${invoice.amountSat.toLocaleString()} sats`}, not the ${amountSat.toLocaleString()} sats you chose`);
  if (!invoice.paymentHash) throw new Error("The invoice has no payment hash");
  if (invoice.descriptionHash !== params.descriptionHash && invoice.description !== params.metadata) throw new Error("The invoice does not commit to what the service said the payment is for");
  if (invoice.expiresAt * 1000 < Date.now()) throw new Error("The invoice the service answered with has already expired");
  let successAction: LnurlSuccessAction | undefined;
  const action = body.successAction;
  if (isRecord(action)) {
    if (action.tag === "message" && typeof action.message === "string") successAction = { tag: "message", message: reason(action.message) };
    else if (action.tag === "url" && typeof action.url === "string" && /^https:\/\//i.test(action.url) && action.url.length <= LNURL_LIMITS.maxUrlLength) successAction = { tag: "url", description: reason(action.description), url: action.url };
  }
  return { invoice, successAction };
}

/** Fetches and checks what a Lightning address or LNURL asks for. The service's domain learns of it. */
export async function resolveLightningDestination(text: string, options: LnurlFetchOptions = {}): Promise<LnurlPayParams> {
  const destination = parseLightningDestination(text);
  if (!destination) throw new Error("That is not a Lightning address or an LNURL");
  return parsePayParams(await fetchLnurlJson(destination.url, options), destination);
}

/** Asks the service for an invoice of `amountSat`, and checks it before it is handed to any wallet. */
export async function requestLnurlInvoice(params: LnurlPayParams, amountSat: number, comment: string | undefined, options: LnurlFetchOptions = {}): Promise<{ invoice: Bolt11Invoice; successAction?: LnurlSuccessAction }> {
  return parseInvoiceCallback(await fetchLnurlJson(invoiceCallbackUrl(params, amountSat, comment), options), params, amountSat);
}
