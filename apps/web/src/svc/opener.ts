/**
 * The app's side of opening a contact's shared web app on the web (WISP 701; the design is in `protocol.ts`): the app
 * on an origin of its own, full screen over the app, and every request it makes sent over the contact's data link
 * from this page, where the peer runs. Closing it ends the app, its requests and its cookies.
 */
import { GhostlyHttpError, viewerResponseHeaders, type ClientRequest, type ClientResponse } from "@ghostly/core";
import { BRIDGE_PAGE, BRIDGE_PORT, BRIDGE_READY, MAX_RESPONSE_BYTES, SERVICE_VIEW_CLOSE, SERVICE_VIEW_ID, closeServiceView, readRequest, serviceOrigin, type ServiceReply, type ServicesHost } from "./protocol";

/** How a request reaches the contact: the engine's `request` for that contact and service. */
export type ServiceSend = (request: ClientRequest) => Promise<ClientResponse>;

/** What the opener says when there is no answer: the profile's language, from the app. */
export interface OpenerWords { unreachable: string; failed: string; close: string }

/**
 * The label of one contact's app as this profile opens it: `viewerTag` (this side's key for the chat, so another
 * profile, or the same one made again, gets another origin and none of the storage the app kept), the contact and the
 * service, hashed, so the address names none of them. 32 z-base-32 characters: one DNS label.
 */
export async function serviceLabel(tag: string, peerPubKeyZ32: string, serviceId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ghostly-web-service/1\n${tag}\n${peerPubKeyZ32}\n${serviceId}`)));
  const alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
  let out = "", bits = 0, value = 0;
  for (const byte of digest.subarray(0, 20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}

/**
 * The cookies one opened app set, kept in this page for as long as it is open. A service worker neither sees a
 * request's cookies nor may set one, so the app's `Set-Cookie`s are taken here and sent back with its requests, as a
 * browser would for that origin (by name; never another app's). The app's own script cannot read them.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();
  static readonly MAX = 64;

  take(setCookie: string): void {
    const [pair, ...attributes] = setCookie.split(";");
    const at = pair?.indexOf("=") ?? -1;
    const name = at > 0 ? pair!.slice(0, at).trim() : "";
    if (!name) return;
    const value = pair!.slice(at + 1).trim();
    const gone = attributes.some((a) => {
      const [key, v = ""] = a.split("=").map((s) => s.trim());
      if (/^max-age$/i.test(key ?? "")) return Number(v) <= 0;
      if (/^expires$/i.test(key ?? "")) { const when = Date.parse(v); return Number.isFinite(when) && when <= Date.now(); }
      return false;
    });
    if (gone) { this.cookies.delete(name); return; }
    if (!this.cookies.has(name) && this.cookies.size >= CookieJar.MAX) return;
    this.cookies.set(name, value);
  }

  header(): string | null {
    return this.cookies.size ? [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") : null;
  }
}

/** Sends one request from the app over the link and streams the answer back on its port. */
export async function serve(port: MessagePort, data: unknown, send: ServiceSend, jar: CookieJar, words: OpenerWords): Promise<void> {
  const request = readRequest(data);
  if (!request) { port.close(); return; }
  const post = (reply: ServiceReply, transfer: Transferable[] = []) => port.postMessage(reply, transfer);
  const stop = new AbortController();
  port.onmessage = (event) => { if ((event.data as { type?: unknown } | null)?.type === "cancel") stop.abort(); };
  try {
    const cookie = jar.header();
    const headers = request.headers.filter(([name]) => name.toLowerCase() !== "cookie");
    if (cookie) headers.push(["cookie", cookie]);
    const answer = await send({ method: request.method, path: request.path, headers, body: request.body ? new Uint8Array(request.body) : null, maxResponseBytes: MAX_RESPONSE_BYTES, signal: stop.signal });
    const out: [string, string][] = [];
    for (const [name, value] of viewerResponseHeaders(answer.headers)) {
      if (name.toLowerCase() === "set-cookie") jar.take(value);
      else out.push([name, value]);
    }
    post({ type: "head", status: answer.status, headers: out });
    for await (const chunk of answer.body) {
      if (stop.signal.aborted) break;
      const bytes = chunk.slice();
      post({ type: "chunk", bytes }, [bytes.buffer]);
    }
    post({ type: "end" });
  } catch (error) {
    const gone = error instanceof GhostlyHttpError && ["unreachable", "timeout", "closed", "offline", "unknown-peer"].includes(error.code);
    if (!gone && !stop.signal.aborted) console.warn("Service request failed:", error);
    post({ type: "error", status: gone ? 503 : 502, text: gone ? words.unreachable : words.failed });
  } finally {
    port.close();
  }
}

/** What `openServiceView` puts over the app, so a test (or a second open, or the lock) can find and close it. */
export const VIEW_ID = SERVICE_VIEW_ID;

/**
 * Shows a contact's app full screen over the app, on its own origin under `host`, with a bar to close it. One at a
 * time: opening another closes the one before.
 */
export async function openServiceView(options: { host: ServicesHost; tag: string; peer: string; service: string; title: string; send: ServiceSend; words: OpenerWords }): Promise<void> {
  closeServiceView();
  const origin = serviceOrigin(options.host, await serviceLabel(options.tag, options.peer, options.service));
  const jar = new CookieJar();
  const view = document.createElement("div");
  view.id = VIEW_ID;
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-label", options.title);
  // Clear of a phone's notch and home indicator, its edges in the view's background: inside the frame the app cannot
  // keep clear of them itself (`env(safe-area-inset-*)` is 0 there). The bar takes the top.
  view.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;padding:0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);background:var(--color-app-bg,#111)";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;padding-top:max(6px,env(safe-area-inset-top));color:var(--color-text-primary,#eee);font:600 14px system-ui,sans-serif;border-bottom:1px solid var(--color-border,#333)";
  const close = document.createElement("button");
  close.type = "button";
  close.dataset.testid = "service-view-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", options.words.close);
  close.style.cssText = "min-width:40px;min-height:40px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:18px;cursor:pointer";
  const name = document.createElement("span");
  name.textContent = options.title;
  name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  bar.append(close, name);
  const frame = document.createElement("iframe");
  frame.dataset.testid = "service-view-frame";
  frame.title = options.title;
  // Its own origin keeps it from the app's storage. The sandbox keeps it, every frame in it and every window it
  // opens (popups inherit it) from navigating the app's tab away.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads");
  frame.setAttribute("allow", "fullscreen; clipboard-write");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.cssText = "flex:1;width:100%;border:0;background:#fff";
  view.append(bar, frame);

  const ports = new Set<MessagePort>();
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || (event.data as { type?: unknown } | null)?.type !== BRIDGE_READY) return;
    // A new bridge (the frame loaded again): a new channel, and the old one's requests end.
    for (const old of ports) old.close();
    ports.clear();
    const channel = new MessageChannel();
    ports.add(channel.port1);
    channel.port1.onmessage = (request) => { if (request.ports[0]) void serve(request.ports[0], request.data, options.send, jar, options.words); };
    frame.contentWindow!.postMessage({ type: BRIDGE_PORT }, origin, [channel.port2]);
  };
  const end = () => {
    removeEventListener("message", onMessage);
    removeEventListener("keydown", onKey);
    for (const port of ports) port.close();
    view.remove();
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") end(); };
  addEventListener("message", onMessage);
  addEventListener("keydown", onKey);
  close.addEventListener("click", end);
  view.addEventListener(SERVICE_VIEW_CLOSE, end);
  frame.src = `${origin}${BRIDGE_PAGE}`;
  document.body.append(view);
  close.focus();
}
