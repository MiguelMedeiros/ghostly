/**
 * The app's side of opening a contact's shared web app on the web (WISP 701; the design is in `protocol.ts`): the app
 * on an origin of its own, full screen over the app, and every request it makes sent over the contact's data link
 * from this page, where the peer runs. Closing it ends the app, its requests and its cookies.
 */
import { GhostlyHttpError, VIEWER_SERVICE_CSP_RELAY_ONLY, guardViewerAnswer, viewerResponseHeaders, type ClientRequest, type ClientResponse } from "@ghostly/core";
import { BRIDGE_PAGE, BRIDGE_PORT, BRIDGE_READY, HEAD_TIMEOUT_MS, MAX_RESPONSE_BYTES, SERVICE_FRAME_ALLOW, SERVICE_VIEW_CLOSE, SERVICE_VIEW_ID, closeServiceView, readRequest, serviceOrigin, type ServiceReply, type ServicesHost } from "./protocol";
import { callWindowOn } from "../../../ui/src/lib/serviceWindows";
import { appInput } from "../../../ui/src/lib/apps/open";

/** How a request reaches the contact: the engine's `request` for that contact and service. */
export type ServiceSend = (request: ClientRequest) => Promise<ClientResponse>;

/**
 * What the opener says when there is no answer: the profile's language, from the app. `hostError`: what it says for
 * an answer the contact's machine gave in place of their app (`hostErrorText`), null for the app's own. `tooSlow`: no
 * answer before the services worker would give up with words of its own. `offline` and `retry`: the view's notice
 * while the contact is offline. `label` and `owner`: whose app it is and that it is not Ghostly (`serviceFraming`), the
 * view's name and the line under the app's name.
 */
export interface OpenerWords { unreachable: string; failed: string; close: string; callOn: string; tooSlow: string; offline: string; retry: string; label: string; owner: string; hostError: (headers: readonly (readonly [string, string])[]) => string | null }

/**
 * Whether the contact is offline now (`offline`), and a way to hear when that may have changed (`watch`, which returns
 * how to stop hearing it): the open view says so over the app, rather than leaving its last page up.
 */
export interface ContactPresence { offline: () => boolean; watch: (changed: () => void) => () => void }

/**
 * The page answers a request a little before the services worker gives up on it (`HEAD_TIMEOUT_MS`), so what the
 * person reads is the profile's words in its language, never the worker's English.
 */
export const ANSWER_BY_MS = HEAD_TIMEOUT_MS - 5_000;

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

/**
 * Sends one request from the app over the link and streams the answer back on its port. `view`: aborted once the page
 * that asked is gone (the view closed, its frame loaded again), so a request still waiting on the contact ends there
 * too, rather than running on their machine and holding one of the link's places. `relayOnly`: Hide my IP from contacts
 * was on when the app opened, and its answers carry `VIEWER_SERVICE_CSP_RELAY_ONLY` after the contact's own policy: the
 * app loads nothing but its own origin. Its pages run the WebRTC guard first (`guardViewerAnswer`).
 */
export async function serve(port: MessagePort, data: unknown, send: ServiceSend, jar: CookieJar, words: OpenerWords, view?: AbortSignal, relayOnly = false): Promise<void> {
  const request = readRequest(data);
  if (!request) { port.close(); return; }
  // Once an error went, nothing more does: the port is the worker's, and it took that as the whole answer.
  let ended = false;
  const post = (reply: ServiceReply, transfer: Transferable[] = []) => {
    if (ended) return;
    if (reply.type === "error") {
      ended = true;
      // Said in the profile's language and direction, as the app's page reads them.
      const root = typeof document === "undefined" ? null : document.documentElement;
      if (root?.lang) reply = { ...reply, lang: root.lang };
      if (root?.dir === "rtl" || root?.dir === "ltr") reply = { ...reply, dir: root.dir };
    }
    port.postMessage(reply, transfer);
  };
  const stop = new AbortController();
  port.onmessage = (event) => { if ((event.data as { type?: unknown } | null)?.type === "cancel") stop.abort(); };
  const pageGone = () => stop.abort();
  if (view?.aborted) stop.abort();
  else view?.addEventListener("abort", pageGone);
  let headed = false;
  const late = setTimeout(() => {
    if (headed) return;
    post({ type: "error", status: 504, text: words.tooSlow });
    stop.abort();
  }, ANSWER_BY_MS);
  try {
    const cookie = jar.header();
    const headers = request.headers.filter(([name]) => name.toLowerCase() !== "cookie");
    if (cookie) headers.push(["cookie", cookie]);
    const answer = await send({ method: request.method, path: request.path, headers, body: request.body ? new Uint8Array(request.body) : null, maxResponseBytes: MAX_RESPONSE_BYTES, signal: stop.signal });
    const hostError = words.hostError(answer.headers);
    if (hostError !== null) {
      stop.abort();
      post({ type: "error", status: answer.status, text: hostError });
      return;
    }
    let out: [string, string][] = [];
    for (const [name, value] of viewerResponseHeaders(answer.headers)) {
      if (name.toLowerCase() === "set-cookie") jar.take(value);
      else out.push([name, value]);
    }
    let body = answer.body;
    if (relayOnly) {
      // No policy keeps a page off WebRTC: each of the app's pages runs the guard first.
      ({ headers: out, body } = await guardViewerAnswer(out, body, request.destination ?? null));
      // A browser enforces every policy it is sent: the contact's own cannot widen this one.
      out.push(["content-security-policy", VIEWER_SERVICE_CSP_RELAY_ONLY]);
    }
    headed = true;
    clearTimeout(late);
    if (ended) return;
    post({ type: "head", status: answer.status, headers: out });
    for await (const chunk of body) {
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
    clearTimeout(late);
    view?.removeEventListener("abort", pageGone);
    port.close();
  }
}

/**
 * How often an open view looks whether the person is using the app (`navigator.userActivation`): well within the time
 * a tap or a key keeps the page active (5 s in Chromium, Firefox and WebKit), so none goes unseen.
 */
const INPUT_LOOK_MS = 1_000;

/** What `openServiceView` puts over the app, so a test (or a second open, or the lock) can find and close it. */
export const VIEW_ID = SERVICE_VIEW_ID;

/**
 * The mark on the history entry an open view adds, at the app's own address and with the router's state, so Back
 * (Android's back gesture, the browser's) closes the view and leaves the app's route where it was.
 */
const ENTRY = "ghostlyServiceView";
const isViewEntry = (state: unknown) => !!state && typeof state === "object" && (state as Record<string, unknown>)[ENTRY] === true;
/** Set while a second open closes the first: the new view keeps the entry. */
let handingOver = false;

/**
 * Back to the entry the view was opened on. Straight to it where the browser can (the Navigation API): the contact's
 * app may have moved its own history, and once its frame is gone a plain Back lands on its steps and does nothing.
 */
function leaveViewEntry(): void {
  type Going = { committed: Promise<unknown>; finished: Promise<unknown> };
  type Navigation = { currentEntry: { index: number } | null; entries(): { key: string }[]; traverseTo(key: string): Going };
  const navigation = (globalThis as { navigation?: Navigation }).navigation;
  const here = navigation?.currentEntry;
  const under = here ? navigation!.entries()[here.index - 1] : undefined;
  if (!under) { history.back(); return; }
  const going = navigation!.traverseTo(under.key);
  going.committed.catch(() => {});
  going.finished.catch(() => {});
}

/**
 * A view's entry with no view open (Forward after a close, or Back onto it from a step past it) is not a place to stop:
 * nothing is shown there, and the next Back would only leave it. The page goes on to the entry under it, where the
 * chat was: Forward shows the chat it was on, and a Back carries on past it.
 */
let watchingDeadEntries = false;
function watchDeadEntries(): void {
  if (watchingDeadEntries) return;
  watchingDeadEntries = true;
  addEventListener("popstate", () => { if (isViewEntry(history.state) && !document.getElementById(VIEW_ID)) leaveViewEntry(); });
}

/**
 * Shows a contact's app full screen over the app, on its own origin under `host`, with a bar to close it. One at a
 * time: opening another closes the one before. `relayOnly`: Hide my IP from contacts is on (`serve`).
 */
export async function openServiceView(options: { host: ServicesHost; tag: string; peer: string; service: string; title: string; send: ServiceSend; words: OpenerWords; presence?: ContactPresence; relayOnly?: boolean }): Promise<void> {
  handingOver = true;
  try { closeServiceView(); } finally { handingOver = false; }
  const origin = serviceOrigin(options.host, await serviceLabel(options.tag, options.peer, options.service));
  // Drawn over everything, a call's windows too: not over a call on screen (one that comes later closes it).
  if (callWindowOn()) throw new Error(options.words.callOn);
  const jar = new CookieJar();
  const view = document.createElement("div");
  view.id = VIEW_ID;
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-modal", "true");
  // Never the contact's name for it alone: they choose it freely ("Ghostly", "Security check").
  view.setAttribute("aria-label", options.words.label);
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
  // The contact's name for it, in its own direction: a Latin name in the Arabic app is cut at its end, not its start.
  name.dir = "auto";
  name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  // Under it, always on screen (a phone has no hover): whose app this is, and that it is not Ghostly, in Ghostly's
  // words. The page under the bar is all the contact's, and the address and the tab's title stay Ghostly's.
  const owner = document.createElement("span");
  owner.dataset.testid = "service-view-owner";
  owner.textContent = options.words.owner;
  owner.style.cssText = "font-weight:400;font-size:12px;line-height:1.3;color:var(--color-text-secondary,#aaa)";
  const named = document.createElement("div");
  named.style.cssText = "display:flex;flex-direction:column;min-width:0";
  named.append(name, owner);
  bar.append(close, named);
  const frame = document.createElement("iframe");
  frame.dataset.testid = "service-view-frame";
  frame.title = options.words.label;
  // Its own origin keeps it from the app's storage. The sandbox keeps it and every frame in it from navigating the
  // app's tab away, and from opening a window: one would be a tab of its own on its origin, outliving the view. No
  // `allow-modals`: the browser's own alert or prompt over the view would be a Ghostly-looking dialog the app draws. No
  // `allow-downloads`: the contact's code saves no file on this device by itself, under a name it picks, as on Desktop.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  frame.setAttribute("allow", SERVICE_FRAME_ALLOW);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.cssText = "flex:1;width:100%;border:0;background:#fff";
  // While the contact is offline: said here, in the app's look and the person's language and direction (the view is
  // the app's page), in place of the contact's last page; its requests are answered as unreachable meanwhile.
  const notice = document.createElement("div");
  notice.dataset.testid = "service-view-offline";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  notice.style.cssText = "flex:1;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;color:var(--color-text-primary,#eee);font:15px/1.5 system-ui,sans-serif";
  const said = document.createElement("p");
  said.style.cssText = "margin:0;max-width:32em";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.dataset.testid = "service-view-retry";
  retry.textContent = options.words.retry;
  retry.style.cssText = "min-height:40px;padding:0 16px;border:1px solid var(--color-border,#333);border-radius:8px;background:transparent;color:inherit;font:600 14px system-ui,sans-serif;cursor:pointer";
  notice.append(said, retry);
  view.append(bar, notice, frame);
  const src = `${origin}${BRIDGE_PAGE}`;
  /** The notice while the contact is offline; once back, the app again, loaded anew (its last page may be stale). */
  const present = () => {
    const offline = options.presence?.offline() ?? false;
    if (offline === !notice.hidden) return;
    if (offline) {
      said.textContent = options.words.offline;
      notice.hidden = false;
      notice.style.display = "flex";
      frame.style.display = "none";
      if (view.contains(document.activeElement) && document.activeElement !== close) close.focus({ preventScroll: true });
    } else {
      notice.hidden = true;
      notice.style.display = "none";
      frame.style.display = "";
      frame.src = src;
    }
  };
  retry.addEventListener("click", present);

  const ports = new Set<MessagePort>();
  // The requests of the bridge now in the frame: aborted, still waiting on the contact or not, once it is gone.
  let bridge = new AbortController();
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || (event.data as { type?: unknown } | null)?.type !== BRIDGE_READY) return;
    // A new bridge (the frame loaded again): a new channel, and the old one's requests end.
    for (const old of ports) old.close();
    ports.clear();
    bridge.abort();
    bridge = new AbortController();
    const { signal } = bridge;
    const channel = new MessageChannel();
    ports.add(channel.port1);
    channel.port1.onmessage = (request) => { if (request.ports[0]) void serve(request.ports[0], request.data, options.send, jar, options.words, signal, options.relayOnly === true); };
    // With Hide my IP on, the bridge runs the WebRTC guard too: the app's frame, on its origin, reaches its window.
    frame.contentWindow!.postMessage({ type: BRIDGE_PORT, relayOnly: options.relayOnly === true }, origin, [channel.port2]);
  };
  // A dialog over the whole app: the app under it is out of the keyboard's reach while it is open (Tab never lands on
  // the hidden chat), and closing it gives the focus back to what had it (the Open button), not to the page's body.
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const shut = [...document.body.children].filter((el) => !el.hasAttribute("inert"));
  let unwatch = () => {};
  // The person's taps and keys in the app go to its frame, never to this page, whose lock screen would lock them out
  // mid-use and close the app with what they typed. The browser's user activation does reach it: real input in a frame
  // activates every frame above it, and no script can, so the contact's page cannot keep the lock away by itself.
  const using = setInterval(() => { if (navigator.userActivation?.isActive) appInput(); }, INPUT_LOOK_MS);
  const end = () => {
    clearInterval(using);
    unwatch();
    removeEventListener("message", onMessage);
    removeEventListener("keydown", onKey);
    removeEventListener("popstate", onPop);
    for (const port of ports) port.close();
    bridge.abort();
    view.remove();
    for (const el of shut) el.removeAttribute("inert");
    const active = document.activeElement;
    if (before?.isConnected && (!active || active === document.body)) before.focus({ preventScroll: true });
    // Closed by ✕, Escape or the lock: its entry goes too, back to the one the app was on.
    if (!handingOver && isViewEntry(history.state)) leaveViewEntry();
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") end(); };
  const onPop = () => { if (!isViewEntry(history.state)) end(); };
  watchDeadEntries();
  if (!isViewEntry(history.state)) history.pushState({ ...(history.state as Record<string, unknown> | null), [ENTRY]: true }, "");
  addEventListener("message", onMessage);
  addEventListener("keydown", onKey);
  addEventListener("popstate", onPop);
  close.addEventListener("click", end);
  view.addEventListener(SERVICE_VIEW_CLOSE, end);
  frame.src = src;
  for (const el of shut) el.setAttribute("inert", "");
  document.body.append(view);
  close.focus();
  if (options.presence) {
    unwatch = options.presence.watch(present);
    present();
  }
}
