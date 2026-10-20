/**
 * The services worker: registered by the bridge (`bridge.ts`) on one contact's app origin, never on the app's own
 * (`isServiceHostname`). Every request that origin's pages make, but the bridge's own files, is handed to the bridge
 * page with a port of its own, and answered with what comes back on it: the contact's answer, streamed. Built on its
 * own into `/ghostly-services-sw.js` (apps/web/svcBuild.ts). It keeps nothing: no cache, no storage.
 */
import { BRIDGE_DIR, BRIDGE_PAGE, WORKER_SCRIPT, HEAD_TIMEOUT_MS, MAX_REQUEST_BYTES, NULL_BODY, answerStatus, isServiceHostname, parseServicesHost, type ServiceReply, type ServiceRequestMessage } from "./protocol";

declare const __SERVICES_HOST__: string;
declare const __SERVICES_APP_ORIGIN__: string;

interface ExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(response: Promise<Response> | Response): void }
interface WindowClient { url: string; frameType?: string; postMessage(message: unknown, transfer: Transferable[]): void }
interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
}
const worker = self as unknown as WorkerScope;

const host = parseServicesHost(__SERVICES_HOST__);
/** Anywhere but a contact's app origin (the app's own, above all) this worker does nothing at all. */
const active = !!host && isServiceHostname(host, worker.location.hostname);

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

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": frameAncestors() } });
}

/** The bridge page open on this origin: the one way to the app, and so to the contact. */
async function bridge(): Promise<WindowClient | undefined> {
  const all = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Framed, as the app frames it: a bridge page opened on its own (by another site, say) has no way to the app.
  return all.find((client) => { try { return client.frameType === "nested" && new URL(client.url).pathname === BRIDGE_PAGE; } catch { return false; } });
}

/** The request body, read up to the data link's limit: null past it. */
async function readBody(request: Request): Promise<ArrayBuffer | null | "too-large"> {
  if (["GET", "HEAD"].includes(request.method) || !request.body) return null;
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
 * The contact's answer to one request. Headers the page's browser set go as they are (the engine drops the ones a
 * proxy must not pass on); cookies are the app's to keep, by the bridge's jar, as a worker never sees them.
 */
async function forward(request: Request): Promise<Response> {
  const to = await bridge();
  if (!to) return plain(503, "This app is open only while Ghostly shows it.");
  const body = await readBody(request);
  if (body === "too-large") return plain(413, "The request body is too large.");
  const url = new URL(request.url);
  const headers: [string, string][] = [];
  request.headers.forEach((value, name) => { if (name !== "cookie") headers.push([name, value]); });
  const message: ServiceRequestMessage = { type: "request", method: request.method, path: url.pathname + url.search, headers, body };
  const channel = new MessageChannel();
  const port = channel.port1;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { port.postMessage({ type: "cancel" }); port.close(); },
  });
  return new Promise<Response>((resolve) => {
    let answered = false;
    const timer = setTimeout(() => { if (!answered) { answered = true; port.close(); resolve(plain(504, "The app did not answer in time.")); } }, HEAD_TIMEOUT_MS);
    port.onmessage = (event: MessageEvent<ServiceReply>) => {
      const reply = event.data;
      if (reply?.type === "head" && !answered) {
        answered = true;
        clearTimeout(timer);
        const status = answerStatus(reply.status);
        // Framed by the bridge, under the app, and by nothing else: no other site, nor another contact's app. The
        // app's own X-Frame-Options would refuse the bridge, so this policy takes its place.
        const out = new Headers();
        for (const [name, value] of reply.headers) {
          const lower = name.toLowerCase();
          if (lower === "x-frame-options") continue;
          const kept = lower === "content-security-policy" ? withoutFrameAncestors(value) : value;
          if (!kept) continue;
          try { out.append(name, kept); } catch { /* not a header a Response takes */ }
        }
        out.append("content-security-policy", frameAncestors());
        resolve(new Response(NULL_BODY.has(status) || request.method === "HEAD" ? null : stream, { status, headers: out }));
        if (NULL_BODY.has(status) || request.method === "HEAD") port.close();
      } else if (reply?.type === "chunk" && answered) {
        try { controller.enqueue(reply.bytes); } catch { /* the page stopped reading */ }
      } else if (reply?.type === "end") {
        try { controller.close(); } catch { /* already closed */ }
        port.close();
      } else if (reply?.type === "error") {
        if (!answered) { answered = true; clearTimeout(timer); resolve(plain(reply.status, reply.text)); }
        else { try { controller.error(new Error(reply.text)); } catch { /* already closed */ } }
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
  event.respondWith(forward(event.request).catch(() => plain(502, "The request failed.")));
});
