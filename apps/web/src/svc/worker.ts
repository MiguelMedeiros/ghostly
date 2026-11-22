/**
 * The services worker: registered by the bridge (`bridge.ts`) on one contact's app origin, never on the app's own
 * (`isServiceHostname`). Every request that origin's pages make, but the bridge's own files, is handed to the bridge
 * page with a port of its own, and answered with what comes back on it: the contact's answer, streamed. A navigation
 * goes only when it is a frame's this origin started (`startedHere`): at the top, the app says it opens inside Ghostly. Built on its
 * own into `/ghostly-services-sw.js` (apps/web/svcBuild.ts). It keeps nothing: no cache, no storage, only a navigation
 * it could not place for the few seconds its own page takes to go on with it (`goOn`).
 */
import { BRIDGE_DIR, BRIDGE_PAGE, WORKER_SCRIPT, HEAD_TIMEOUT_MS, MAX_REQUEST_BYTES, NULL_BODY, answerStatus, fromView, isServiceHostname, parseServicesHost, workerRelayOnly, type ServiceRead, type ServiceReply, type ServiceRequestMessage } from "./protocol";
import { WEBRTC_GUARD, guardViewerAnswer, type PageGuard } from "../../../../packages/core/src/viewerGuard";
import { CLIPBOARD_GUARD_HASH, CLIPBOARD_GUARD_SCRIPT } from "../../../../packages/core/src/clipboardGuard";
import { viewerResponseHeaders, viewerServicePolicy } from "../../../../packages/core/src/http";
import type { HeaderList } from "../../../../packages/core/src/frames";

declare const __SERVICES_HOST__: string;
declare const __SERVICES_APP_ORIGIN__: string;

interface ExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; clientId: string; respondWith(response: Promise<Response> | Response): void }
interface WindowClient { id: string; url: string; type?: string; frameType?: string; postMessage(message: unknown, transfer: Transferable[]): void }
interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; get(id: string): Promise<WindowClient | undefined>; matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
}
const worker = self as unknown as WorkerScope;

const host = parseServicesHost(__SERVICES_HOST__);
/** Anywhere but a contact's app origin (the app's own, above all) this worker does nothing at all. */
const active = !!host && isServiceHostname(host, worker.location.hostname);
/** Hide my IP from contacts, as the bridge registered this worker (`workerScript`). */
const relayOnly = workerRelayOnly(worker.location.href);
/**
 * What each page of the app runs first: the clipboard guard always, the WebRTC guard while Hide my IP from contacts is
 * on (no policy keeps a page off `execCommand("copy")`, nor off WebRTC).
 */
const GUARDS: PageGuard[] = [{ script: CLIPBOARD_GUARD_SCRIPT, hash: CLIPBOARD_GUARD_HASH }, ...(relayOnly ? [WEBRTC_GUARD] : [])];

worker.addEventListener("install", (event) => {
  // Refused where it does not belong: the registration fails and nothing is left behind.
  event.waitUntil(active ? worker.skipWaiting() : Promise.reject(new Error("Not a services origin")));
});
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

/** The pages of this origin may sit in the bridge (this origin), under the app's page, and nowhere else. */
export function frameAncestors(): string {
  return `frame-ancestors 'self' ${__SERVICES_APP_ORIGIN__}`;
}

/** A policy without its `frame-ancestors`: the one this worker adds says who may frame the app here. */
export function withoutFrameAncestors(policy: string): string {
  return policy.split(",").map((one) => one.split(";").filter((d) => !/^\s*frame-ancestors(\s|$)/i.test(d)).join(";").trim())
    .filter((one) => one.replace(/;/g, "").trim()).join(", ");
}

/**
 * An answer's headers and body as the frame gets them. Put here, and not only in Ghostly's page: the answer comes on a
 * port the bridge hands on, and the bridge is on the app's own origin, where the app's pages can take a request's port
 * and answer it themselves. So whoever answered, the contact's headers are a viewer's (`viewerResponseHeaders`), each
 * page of the app runs the guards first (`guardViewerAnswer`), Ghostly's policy goes after the contact's own
 * (`viewerServicePolicy`; a browser enforces every policy it is sent), and only the bridge and the app's page frame it:
 * the app's own X-Frame-Options would refuse the bridge, so this policy takes its place.
 */
async function guarded(headers: unknown, body: AsyncIterable<Uint8Array>, destination: string): Promise<{ headers: Headers; body: AsyncIterable<Uint8Array> }> {
  if (!Array.isArray(headers)) throw new TypeError("No headers");
  const own: HeaderList = [];
  for (const [name, value] of viewerResponseHeaders(headers as HeaderList)) {
    const lower = name.toLowerCase();
    if (lower === "x-frame-options") continue;
    const kept = lower === "content-security-policy" ? withoutFrameAncestors(value) : value;
    if (kept) own.push([name, kept]);
  }
  const answer = await guardViewerAnswer(own, body, destination, GUARDS);
  const out = new Headers();
  for (const [name, value] of answer.headers) {
    try { out.append(name, value); } catch { /* not a header a Response takes */ }
  }
  out.append("content-security-policy", viewerServicePolicy(relayOnly));
  out.append("content-security-policy", frameAncestors());
  return { headers: out, body: answer.body };
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": frameAncestors() } });
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The app's words for a request it could not answer, as a page in the profile's language and direction (`lang`,
 * `dir`, from the app's page), in place of a plain-text one: no script, nothing loaded, its style its own.
 */
export function said(status: number, text: string, lang?: string, dir?: string): Response {
  if (!lang && !dir) return plain(status, text);
  const language = lang && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(lang) ? ` lang="${lang}"` : "";
  const direction = dir === "rtl" || dir === "ltr" ? ` dir="${dir}"` : "";
  const html = `<!doctype html><html${language}${direction}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(text)}</title>`
    + `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font:15px/1.5 system-ui,sans-serif;text-align:center}p{max-width:32em;margin:0}</style>`
    + `</head><body><p>${escape(text)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `${frameAncestors()}; default-src 'none'; style-src 'unsafe-inline'` } });
}

/**
 * The app's error answer at a status a Response may carry, as the head's (`answerStatus`): one outside 200-599 is a
 * 502, and one that takes no body (a 304, say) goes without the words.
 */
function failed(status: number, text: string, lang?: string, dir?: string): Response {
  const kept = answerStatus(status);
  if (NULL_BODY.has(kept)) return new Response(null, { status: kept, headers: { "cache-control": "no-store", "content-security-policy": frameAncestors() } });
  return said(kept, text, lang, dir);
}

/** The bridge page open on this origin, among its pages: the one way to the app, and so to the contact. */
function bridge(all: WindowClient[]): WindowClient | undefined {
  // Framed, as the app frames it: a bridge page opened on its own (by another site, say) has no way to the app.
  return all.find((client) => { try { return client.frameType === "nested" && new URL(client.url).pathname === BRIDGE_PAGE; } catch { return false; } });
}

/**
 * Whether this origin started a navigation: a frame's (the bridge's first, a link in the app), with this origin's
 * referrer or, with none, from one of its own pages. Another site may navigate a window or a frame of its own here;
 * where this worker is in its partition (a services host on the app's own site), that would reach the contact as this
 * person, with the page's cookies. Undefined when nothing says: a frame's navigation with no referrer (the app's page
 * sends none) and no client, as Firefox and WebKit hand every one.
 */
function startedHere(event: FetchEvent, all: WindowClient[]): boolean | undefined {
  const { destination, referrer } = event.request;
  if (destination !== "iframe" && destination !== "frame") return false;
  if (referrer) { try { return new URL(referrer).origin === worker.location.origin; } catch { return false; } }
  if (!event.clientId) return undefined;
  return all.some((client) => client.id === event.clientId);
}

/** A navigation `goOn` keeps until its page goes on with it: what goes to the contact then, in its place. */
interface Kept { url: string; method: string; headers: Headers; body: ArrayBuffer | null; until: number }
const kept = new Map<string, Kept>();
const KEPT_MS = 30_000;
const MAX_KEPT = 4;

/** The query key the "go on" page puts its token under, on its own address: the next navigation's referrer. */
export const GO_KEY = "ghostly-go";
/** The "go on" page's one script: its token into its own address, then the same navigation again, with a referrer. */
export const GO_SCRIPT = `(()=>{const to=location.href,at=new URL(to);at.searchParams.set("${GO_KEY}",document.currentScript.dataset.go);history.replaceState(null,"",at);location.replace(to)})()`;
let goHash: Promise<string> | undefined;

/**
 * A frame's navigation nothing places (`startedHere`), answered with a page of this worker's own in place of the
 * contact's: one that renders only inside Ghostly (`frame-ancestors`), so in another site's frame nothing runs and
 * nothing reaches the contact. Inside Ghostly its script asks again, now with this origin's referrer and a token, and
 * the request kept here goes as it was made (a form's POST and its body too). Kept once, for a little while.
 */
async function goOn(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (body === "too-large") return plain(413, "The request body is too large.");
  const now = Date.now();
  for (const [token, one] of kept) if (one.until <= now || kept.size >= MAX_KEPT) kept.delete(token);
  const token = crypto.randomUUID();
  kept.set(token, { url: request.url, method: request.method, headers: new Headers(request.headers), body, until: now + KEPT_MS });
  goHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(GO_SCRIPT))
    .then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  const html = `<!doctype html><meta charset="utf-8"><script data-go="${token}">${GO_SCRIPT}</script>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "content-security-policy": `${frameAncestors()}; default-src 'none'; script-src ${await goHash}` } });
}

/** The navigation a "go on" page asked for again (its token in the referrer, the same address): taken, once. */
function takeKept(request: Request): Kept | undefined {
  let token: string | null;
  try { token = new URL(request.referrer).searchParams.get(GO_KEY); } catch { return undefined; }
  const one = token ? kept.get(token) : undefined;
  if (!one) return undefined;
  kept.delete(token!);
  return one.url === request.url && one.until > Date.now() ? one : undefined;
}

/** The request body, read up to the data link's limit: "too-large" past it, null when there is none. */
async function readBody(request: Request): Promise<ArrayBuffer | null | "too-large"> {
  if (["GET", "HEAD"].includes(request.method)) return null;
  // Firefox has no `Request.body` (undefined, where null means no body): its body is read whole, within the limit.
  if (request.body === undefined) return readWhole(request);
  if (!request.body) return null;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) { void reader.cancel().catch(() => {}); return "too-large"; }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { body.set(part, at); at += part.byteLength; }
  return body.buffer;
}

/**
 * The body of a request with no stream to read it by (Firefox's): refused unread when its declared length is past the
 * limit, and refused after reading when it turns out past it. An empty one is no body, as where the stream is null.
 */
async function readWhole(request: Request): Promise<ArrayBuffer | null | "too-large"> {
  const declared = request.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) return "too-large";
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) return "too-large";
  return body.byteLength ? body : null;
}

/**
 * The contact's answer to one request. Headers the page's browser set go as they are (the engine drops the ones a
 * proxy must not pass on); cookies are the app's to keep, by the bridge's jar, as a worker never sees them.
 */
async function forward(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const all = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  let again: Kept | undefined;
  if (request.mode === "navigate") {
    const started = startedHere(event, all);
    if (started === undefined) return goOn(request);
    if (!started) return plain(403, "This app opens only inside Ghostly.");
    again = takeKept(request);
  }
  const to = bridge(all);
  if (!to) return plain(503, "This app is open only while Ghostly shows it.");
  const body = again ? again.body : await readBody(request);
  if (body === "too-large") return plain(413, "The request body is too large.");
  const url = new URL(request.url);
  const headers: [string, string][] = [];
  (again?.headers ?? request.headers).forEach((value, name) => { if (name !== "cookie") headers.push([name, value]); });
  const message: ServiceRequestMessage = { type: "request", method: again?.method ?? request.method, path: url.pathname + url.search, headers, body, destination: request.destination, flow: true };
  const channel = new MessageChannel();
  const port = channel.port1;
  // The answer's chunks wait here, not in the stream, until the frame reads (or the guards look for their place in a
  // page): the page is told what was read, and sends only `ANSWER_AHEAD_BYTES` past that, so an answer the frame leaves
  // unread stays on the link.
  const waiting: Uint8Array[] = [];
  let last: { error: Error } | "end" | null = null;
  let read = 0;
  let wanted: (() => void) | null = null;
  const arrived = () => { wanted?.(); wanted = null; };
  const next = async (): Promise<IteratorResult<Uint8Array>> => {
    for (;;) {
      const bytes = waiting.shift();
      if (bytes) {
        read += bytes.byteLength;
        port.postMessage({ type: "read", bytes: read } satisfies ServiceRead);
        return { done: false, value: bytes };
      }
      if (last === "end") return { done: true, value: undefined };
      if (last) throw last.error;
      await new Promise<void>((resolve) => { wanted = resolve; });
    }
  };
  const incoming: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next }) };
  const nothing: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) };
  const streamOf = (body: AsyncIterable<Uint8Array>) => {
    const chunks = body[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        const one = await chunks.next();
        if (one.done) c.close();
        else c.enqueue(one.value);
      },
      cancel() { waiting.length = 0; port.postMessage({ type: "cancel" }); port.close(); },
    }, { highWaterMark: 0 });
  };
  return new Promise<Response>((resolve) => {
    let answered = false;
    const timer = setTimeout(() => { if (!answered) { answered = true; port.close(); resolve(plain(504, "The app did not answer in time.")); } }, HEAD_TIMEOUT_MS);
    // The app's page gave up on it before any answer (its own abort): the page lets go of it too, body and all.
    request.signal.addEventListener("abort", () => { if (!answered) port.postMessage({ type: "cancel" }); }, { once: true });
    /** The page's answer, once: a Response refused by the browser (a status it takes no body with) ends it as a 502. */
    const settle = (make: () => Response): boolean => {
      answered = true;
      clearTimeout(timer);
      try { resolve(make()); return true; } catch { resolve(plain(502, "The request failed.")); return false; }
    };
    const drop = () => { port.postMessage({ type: "cancel" }); port.close(); };
    port.onmessage = (event: MessageEvent<ServiceReply>) => {
      const reply = event.data;
      if (reply?.type === "head" && !answered) {
        answered = true;
        clearTimeout(timer);
        const status = answerStatus(reply.status);
        const empty = NULL_BODY.has(status) || request.method === "HEAD";
        guarded(reply.headers, empty ? nothing : incoming, request.destination).then((answer) => {
          if (!settle(() => new Response(empty ? null : streamOf(answer.body), { status, headers: answer.headers }))) drop();
          else if (empty) port.close();
        }, () => { settle(() => plain(502, "The request failed.")); drop(); });
      } else if (reply?.type === "chunk" && answered && !last) {
        waiting.push(reply.bytes);
        arrived();
      } else if (reply?.type === "end") {
        last ??= "end";
        arrived();
        port.close();
      } else if (reply?.type === "error") {
        if (!answered) settle(() => failed(reply.status, reply.text, reply.lang, reply.dir));
        else { last ??= { error: new Error(reply.text) }; arrived(); }
        port.close();
      }
    };
    to.postMessage(message, [channel.port2, ...(body ? [body] : [])]);
  });
}

worker.addEventListener("fetch", (event) => {
  if (!active) return;
  const url = new URL(event.request.url);
  // The bridge's own files come from the server; another origin is not this app's.
  if (url.origin !== worker.location.origin || url.pathname.startsWith(BRIDGE_DIR) || url.pathname === WORKER_SCRIPT) return;
  const answer = async () => {
    // A tab of its own on this origin (a window the app opened, a link from elsewhere) outlives the view: refused.
    const client = event.clientId ? await worker.clients.get(event.clientId) : undefined;
    if (!fromView(event.request, client)) return plain(403, "This app opens only inside Ghostly.");
    return forward(event);
  };
  event.respondWith(answer().catch(() => plain(502, "The request failed.")));
});
