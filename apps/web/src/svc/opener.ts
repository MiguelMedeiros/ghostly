/**
 * The app's side of opening a contact's shared web app on the web (WISP 701; the design is in `protocol.ts`): the app
 * on an origin of its own, full screen over the app, and every request it makes sent over the contact's data link
 * from this page, where the peer runs. Closing it ends the app, its requests and its cookies.
 */
import { CLIPBOARD_GUARD_HASH, CLIPBOARD_GUARD_SCRIPT, GhostlyHttpError, WEBRTC_GUARD, guardViewerAnswer, viewerResponseHeaders, viewerServicePolicy, type ClientRequest, type ClientResponse, type PageGuard } from "@ghostly/core";
import { ANSWER_AHEAD_BYTES, BRIDGE_OPEN_LINK, BRIDGE_PAGE, BRIDGE_PORT, BRIDGE_READY, BRIDGE_REFUSED, HEAD_TIMEOUT_MS, MAX_RESPONSE_BYTES, SERVICE_FRAME_ALLOW, SERVICE_VIEW_CLOSE, SERVICE_VIEW_ID, closeServiceView, readRequest, serviceOrigin, type ServiceReply, type ServiceRequestMessage, type ServicesHost } from "./protocol";
import { SERVICE_LOCKED, callWindowOn, serviceWindowsClosedSince } from "../../../ui/src/lib/serviceWindows";
import { appInput } from "../../../ui/src/lib/apps/open";
import { isLocalHost } from "../../../ui/src/lib/parse/linkPreview";

const CLIPBOARD_GUARD: PageGuard = { script: CLIPBOARD_GUARD_SCRIPT, hash: CLIPBOARD_GUARD_HASH };

/**
 * How a request reaches the contact: the engine's `request` for that contact and service. Each chunk of the answer's
 * `body` is handed over to `serve`: one that spans a whole buffer of its own goes to the services worker as it is (its
 * buffer moves there, and reads empty here after), any other is copied first.
 */
export type ServiceSend = (request: ClientRequest) => Promise<ClientResponse>;

/**
 * A chunk that is all of a plain buffer (the engine's `HttpClient` gives each one so, already copied out of the link's
 * frame) is moved to the worker as it is. A view into a larger or shared buffer would move, or fail on, bytes that are
 * not its own: that one is copied.
 */
function ownsBuffer(chunk: Uint8Array): chunk is Uint8Array<ArrayBuffer> {
  return chunk.buffer instanceof ArrayBuffer && chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength;
}

/**
 * What the opener says when there is no answer: the profile's language, from the app. `hostError`: what it says for
 * an answer the contact's machine gave in place of their app (`hostErrorText`), null for the app's own. `tooSlow`: no
 * answer before the services worker would give up with words of its own. `offline` and `retry`: the view's notice
 * while the contact is offline; `reaching` while Try again asks the engine to reach them, and `stillOffline` once that
 * ended with them still offline (without these, `offline`). `blocked` and `unguarded`: the view's notice when the bridge shows no app
 * (`BRIDGE_REFUSED`). `label` and `owner`: whose app it is and that it is not Ghostly (`serviceFraming`), the view's
 * name and the line under the app's name.
 */
export interface OpenerWords { unreachable: string; failed: string; close: string; callOn: string; tooSlow: string; offline: string; retry: string; reaching?: string; stillOffline?: string; blocked: string; unguarded: string; label: string; owner: string; hostError: (headers: readonly (readonly [string, string])[]) => string | null }

/**
 * Whether the contact is offline now (`offline`), and a way to hear when that may have changed (`watch`, which returns
 * how to stop hearing it): the open view says so over the app, rather than leaving its last page up. `connect`: asks
 * the engine to reach the contact now (the chat's Reconnect), settled once that attempt ended; Try again runs it.
 */
export interface ContactPresence { offline: () => boolean; watch: (changed: () => void) => () => void; connect?: () => Promise<void> }

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
 * browser would for that origin (by name and path, while they last; never another app's). The app's own script cannot
 * read them.
 */
export class CookieJar {
  /** By name and path, as a browser keeps them: `sid` at `/` and `sid` at `/admin` are two cookies. */
  private readonly cookies = new Map<string, { name: string; value: string; path: string; until: number }>();
  static readonly MAX = 64;

  /** `requestPath`: the path the answer that set it is for, whose directory is the cookie's path when it names none. */
  take(setCookie: string, requestPath = "/"): void {
    const [pair, ...attributes] = setCookie.split(";");
    const at = pair?.indexOf("=") ?? -1;
    const name = at > 0 ? pair!.slice(0, at).trim() : "";
    if (!name) return;
    const value = pair!.slice(at + 1).trim();
    // As RFC 6265 §5.3 reads them: the last of each that parses counts, and a Max-Age wins over an Expires.
    let maxAge: number | undefined;
    let expires: number | undefined;
    let path = defaultCookiePath(requestPath);
    for (const a of attributes) {
      const eq = a.indexOf("=");
      const key = (eq < 0 ? a : a.slice(0, eq)).trim();
      const v = eq < 0 ? "" : a.slice(eq + 1).trim();
      if (/^max-age$/i.test(key) && /^-?\d+$/.test(v)) maxAge = Number(v);
      if (/^expires$/i.test(key)) { const when = Date.parse(v); if (Number.isFinite(when)) expires = when; }
      if (/^path$/i.test(key)) path = v.startsWith("/") ? v : defaultCookiePath(requestPath);
    }
    const now = Date.now();
    const until = maxAge !== undefined ? now + maxAge * 1000 : expires ?? Infinity;
    const key = `${path}\n${name}`;
    if (until <= now) { this.cookies.delete(key); return; }
    if (!this.cookies.has(key) && this.cookies.size >= CookieJar.MAX) return;
    this.cookies.set(key, { name, value, path, until });
  }

  /**
   * The `Cookie` header for a request to `path`: the cookies whose path it is under and that have not run out, the
   * longer paths first (RFC 6265 §5.4).
   */
  header(path = "/"): string | null {
    const now = Date.now();
    const sent: { name: string; value: string; path: string }[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.until <= now) this.cookies.delete(key);
      else if (pathMatches(path, cookie.path)) sent.push(cookie);
    }
    // A stable sort: cookies of one path length go in the order they were first set.
    sent.sort((a, b) => b.path.length - a.path.length);
    return sent.length ? sent.map(({ name, value }) => `${name}=${value}`).join("; ") : null;
  }
}

/** A cookie's path when its `Set-Cookie` names none: the request path's directory (RFC 6265 §5.1.4). */
function defaultCookiePath(requestPath: string): string {
  const path = requestPath.split("?")[0]!;
  const last = path.lastIndexOf("/");
  return path.startsWith("/") && last > 0 ? path.slice(0, last) : "/";
}

/** Whether a request to `path` carries a cookie of `cookiePath`: that path, or one under it (RFC 6265 §5.1.4). */
function pathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true;
  return path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/");
}

/**
 * What one opened app (its jar) may have in this page at once: requests sent on the link, more waiting their turn
 * (a page asks for all its images and modules together, 100 at once in Chromium), and the bytes of their bodies and
 * headers. Past the waiting ones or the bytes, a request is refused at once, so the app cannot make the page that runs
 * the peer hold unbounded memory.
 */
export const MAX_PENDING_REQUESTS = 32;
export const MAX_WAITING_REQUESTS = 256;
export const MAX_PENDING_BODY_BYTES = 32 * 1024 * 1024;
const pendingOf = new WeakMap<CookieJar, { count: number; bytes: number; waiting: (() => void)[] }>();

/**
 * Takes room for one request of the app's, at once or when one sent before it ends: how to give it back, or null with
 * no room left, or once `signal` aborts while it waits (it leaves its turn).
 */
async function holdRoom(jar: CookieJar, bytes: number, signal: AbortSignal): Promise<(() => void) | null> {
  const pending = pendingOf.get(jar) ?? { count: 0, bytes: 0, waiting: [] };
  pendingOf.set(jar, pending);
  if (pending.bytes + bytes > MAX_PENDING_BODY_BYTES) return null;
  if (pending.count < MAX_PENDING_REQUESTS) pending.count++;
  else if (pending.waiting.length >= MAX_WAITING_REQUESTS || signal.aborted) return null;
  else {
    pending.bytes += bytes;
    // Its turn comes with the place of one that ended (`count` stays), or never once the page lets go of it.
    const turn = await new Promise<boolean>((resolve) => {
      const go = () => { signal.removeEventListener("abort", leave); resolve(true); };
      const leave = () => { pending.waiting.splice(pending.waiting.indexOf(go), 1); resolve(false); };
      pending.waiting.push(go);
      signal.addEventListener("abort", leave, { once: true });
    });
    pending.bytes -= bytes;
    if (!turn) return null;
  }
  pending.bytes += bytes;
  return () => {
    pending.bytes -= bytes;
    const next = pending.waiting.shift();
    if (next) next();
    else pending.count--;
  };
}

/** What a request holds in this page while it waits or goes: its body and its headers. */
function heldBytes(request: ServiceRequestMessage): number {
  let bytes = request.body?.byteLength ?? 0;
  for (const [name, value] of request.headers) bytes += name.length + value.length;
  return bytes;
}

/**
 * Sends one request from the app over the link and streams the answer back on its port. `view`: aborted once the page
 * that asked is gone (the view closed, its frame loaded again), so a request still waiting on the contact ends there
 * too, rather than running on their machine and holding one of the link's places. Every answer carries Ghostly's viewer
 * policy after the contact's own (`viewerServicePolicy`, as Desktop, the extension and `ghostly service open` add it):
 * the app talks to nothing but its own origin, and nothing over plain http. Its pages run the clipboard guard first
 * (`guardViewerAnswer`, `CLIPBOARD_GUARD_SCRIPT`): it writes the clipboard only in the person's own tap in it.
 * `relayOnly`: Hide my IP from contacts was on when the app opened, and the policy is `VIEWER_SERVICE_CSP_RELAY_ONLY`:
 * the app loads nothing but its own origin. Its pages run the WebRTC guard first too.
 */
export async function serve(port: MessagePort, data: unknown, send: ServiceSend, jar: CookieJar, words: OpenerWords, view?: AbortSignal, relayOnly = false): Promise<void> {
  const request = readRequest(data);
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
  // One this page does not take (a path past its length, a method it does not read) never goes on the link, and is
  // answered now: left unanswered, the worker waited `HEAD_TIMEOUT_MS` and said so in its own English.
  if (!request) {
    post({ type: "error", status: 400, text: words.failed });
    port.close();
    return;
  }
  const stop = new AbortController();
  // What the app's frame read of the answer, as the worker says (`flow`), and the wait for it to read on.
  let read = 0;
  let readOn: (() => void) | null = null;
  const wake = () => { readOn?.(); readOn = null; };
  stop.signal.addEventListener("abort", wake);
  port.onmessage = (event) => {
    const said = event.data as { type?: unknown; bytes?: unknown } | null;
    if (said?.type === "cancel") stop.abort();
    else if (said?.type === "read" && typeof said.bytes === "number" && said.bytes > read) { read = said.bytes; wake(); }
  };
  const pageGone = () => stop.abort();
  if (view?.aborted) stop.abort();
  else view?.addEventListener("abort", pageGone);
  let headed = false;
  const late = setTimeout(() => {
    if (headed) return;
    post({ type: "error", status: 504, text: words.tooSlow });
    stop.abort();
  }, ANSWER_BY_MS);
  let release: (() => void) | null = null;
  try {
    // Its turn on the link, after the app's requests sent before it: none past the room this page keeps for them.
    release = await holdRoom(jar, heldBytes(request), stop.signal);
    if (!release) {
      post({ type: "error", status: 503, text: words.failed });
      return;
    }
    const path = request.path.split("?")[0]!;
    const cookie = jar.header(path);
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
      if (name.toLowerCase() === "set-cookie") jar.take(value, path);
      else out.push([name, value]);
    }
    // No policy keeps a page off `execCommand("copy")`, nor (Hide my IP from contacts) off WebRTC: each of the app's
    // pages runs the guards first.
    const guards: PageGuard[] = [CLIPBOARD_GUARD, ...(relayOnly ? [WEBRTC_GUARD] : [])];
    const guarded = await guardViewerAnswer(out, answer.body, request.destination ?? null, guards);
    out = guarded.headers;
    const body = guarded.body;
    // A browser enforces every policy it is sent: the contact's own cannot widen this one.
    out.push(["content-security-policy", viewerServicePolicy(relayOnly)]);
    headed = true;
    clearTimeout(late);
    if (ended) return;
    post({ type: "head", status: answer.status, headers: out });
    let sent = 0;
    for await (const chunk of body) {
      if (stop.signal.aborted) break;
      const bytes = ownsBuffer(chunk) ? chunk : chunk.slice();
      sent += bytes.byteLength;
      post({ type: "chunk", bytes }, [bytes.buffer]);
      // Not read on from the link until the frame takes what went ahead: left unread there, the engine lets it go.
      while (request.flow && sent - read > ANSWER_AHEAD_BYTES && !stop.signal.aborted) await new Promise<void>((resolve) => { readOn = resolve; });
    }
    post({ type: "end" });
  } catch (error) {
    const gone = error instanceof GhostlyHttpError && ["unreachable", "timeout", "closed", "offline", "unknown-peer"].includes(error.code);
    if (!gone && !stop.signal.aborted) console.warn("Service request failed:", error);
    post({ type: "error", status: gone ? 503 : 502, text: gone ? words.unreachable : words.failed });
  } finally {
    release?.();
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

/**
 * Least time between two links an open view opens outside, and the most it opens in its life: as Desktop's viewer
 * window (`viewer.rs`), so an app that asks on every tap does not fill the browser with tabs.
 */
const LINK_SPACING_MS = 2_000;
const LINKS_PER_VIEW = 20;

/**
 * How long a tap or a key on this page (Open, the view's bar) keeps it active, as one in the app would (5 s in Chromium,
 * Firefox and WebKit): a link the app asks for meanwhile is not one the person tapped in it.
 */
const OWN_INPUT_MS = 5_000;

/**
 * Where a link the contact's app opens in a new window goes outside it (`BRIDGE_OPEN_LINK`), as on Desktop
 * (`external_target` in viewer.rs): a plain http(s) link to another site. Null for anything else, for a site on this
 * machine or the local network (`isLocalHost`), whose request would carry the browser's cookies there, for an app's
 * origin under the services host (a tab of its own there would outlive the view) and for Ghostly's own.
 */
export function outsideLink(url: unknown, host: ServicesHost): string | null {
  if (typeof url !== "string" || url.length > 4096) return null;
  let link: URL;
  try { link = new URL(url); } catch { return null; }
  if ((link.protocol !== "http:" && link.protocol !== "https:") || link.href.length > 4096) return null;
  const name = link.hostname.toLowerCase().replace(/\.$/, "");
  if (isLocalHost(name) || name === host.suffix || name.endsWith(`.${host.suffix}`) || name === location.hostname) return null;
  return link.href;
}

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
/** Counts the opens: one overtaken by a later open while it waits draws nothing (the last one wins). */
let opens = 0;

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
  // The profile locking while it opens closes nothing yet: it is never drawn, behind the lock or over its screen.
  const locked = serviceWindowsClosedSince();
  // The tap or the key on Open, now: it activates this page for seconds, as one in the app does (`openOutside`).
  let ownInput = Date.now();
  const open = ++opens;
  handingOver = true;
  try { closeServiceView(); } finally { handingOver = false; }
  const origin = serviceOrigin(options.host, await serviceLabel(options.tag, options.peer, options.service));
  // Open tapped again, or another app opened, before this one was drawn: that one is shown, this one never is.
  if (open !== opens) return;
  if (locked()) throw new Error(SERVICE_LOCKED);
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
  // app's tab away, and from opening a window: one would be a tab of its own on its origin, outliving the view (a link
  // the app opens in a new window comes here from the bridge instead, `openOutside`). No
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
  /** Why the bridge shows no app (`BRIDGE_REFUSED`), in the profile's words: said until Try again. */
  let refused: string | null = null;
  /** What the notice says now: null while the app is on screen. */
  let shown: string | null = null;
  /** Try again is asking the engine to reach the contact; `tried`: it did, and they were still offline after. */
  let reaching = false, tried = false;
  /**
   * The notice while the contact is offline, or while the bridge shows no app; once neither, the app again, loaded anew
   * (its last page may be stale).
   */
  const present = () => {
    const offline = options.presence?.offline() === true;
    // Back: the next time they are offline is said as the first.
    if (!offline) tried = false;
    const text = offline ? (reaching && options.words.reaching) || (tried && options.words.stillOffline) || options.words.offline : refused;
    // Still in reach of the focus while it tries (`disabled` would drop it to the page), and pressed again, it asks nothing more.
    if (offline && reaching) { notice.setAttribute("aria-busy", "true"); retry.setAttribute("aria-disabled", "true"); }
    else { notice.removeAttribute("aria-busy"); retry.removeAttribute("aria-disabled"); }
    if (text === shown) return;
    shown = text;
    if (text !== null) {
      said.textContent = text;
      notice.hidden = false;
      notice.style.display = "flex";
      frame.style.display = "none";
      // The focus in the hidden app goes to ✕; on Try again, whose words changed, it stays.
      if (view.contains(document.activeElement) && document.activeElement !== close && !notice.contains(document.activeElement)) close.focus({ preventScroll: true });
    } else {
      // Try again had the focus: hidden under it, the browser drops it to the page's body. It goes to the app.
      const had = notice.contains(document.activeElement);
      notice.hidden = true;
      notice.style.display = "none";
      frame.style.display = "";
      frame.src = src;
      if (had) frame.focus({ preventScroll: true });
    }
  };
  // While the contact is offline, it asks the engine to reach them now (rather than waiting on its own next try, minutes
  // away for an older chat), says so meanwhile, and that they are still offline if the attempt did not bring them back.
  retry.addEventListener("click", () => {
    if (reaching) return;
    refused = null;
    const connect = options.presence?.offline() ? options.presence.connect : undefined;
    if (connect) {
      reaching = true;
      void connect().catch(() => {}).finally(() => {
        reaching = false;
        tried = options.presence?.offline() === true;
        if (view.isConnected) present();
      });
    }
    present();
  });

  const ports = new Set<MessagePort>();
  // The requests of the bridge now in the frame: aborted, still waiting on the contact or not, once it is gone.
  let bridge = new AbortController();
  let linksOpened = 0;
  let lastLink = -Infinity;
  /**
   * A link the app opens in a new window, which its sandbox drops: opened here in a new tab with no opener and no
   * referrer, as Ghostly's own external links (`externalLinkProps`). Only within the person's own tap in the app, which
   * activates this page too and no script can: never one the app opens by itself. Not while a tap or a key on this page
   * still activates it (`OWN_INPUT_MS`): the bridge checks for a tap in the app, but it is on the app's origin, and the
   * contact's page can run a script of its own there and ask as it does, right on the tap on Open.
   */
  const openOutside = (url: unknown) => {
    const link = outsideLink(url, options.host);
    const now = Date.now();
    if (!link || !navigator.userActivation?.isActive || now - ownInput <= OWN_INPUT_MS || linksOpened >= LINKS_PER_VIEW || now - lastLink < LINK_SPACING_MS) return;
    linksOpened++;
    lastLink = now;
    window.open(link, "_blank", "noopener,noreferrer");
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    const message = event.data as { type?: unknown; reason?: unknown; url?: unknown } | null;
    if (message?.type === BRIDGE_OPEN_LINK) {
      openOutside(message.url);
      return;
    }
    if (message?.type === BRIDGE_REFUSED) {
      refused = message.reason === "blocked" ? options.words.blocked : options.words.unguarded;
      present();
      return;
    }
    if (message?.type !== BRIDGE_READY) return;
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
  // The strip and the Services dialog drop the Open button once the contact goes offline or stops sharing the app: the
  // focus then goes to the dialog it was in, or else to the chat's composer.
  const holder = before?.parentElement?.closest<HTMLElement>("[role=dialog]") ?? null;
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
    removeEventListener("keydown", onKey, true);
    removeEventListener("popstate", onPop);
    for (const type of OWN_INPUTS) removeEventListener(type, onOwnInput, true);
    for (const port of ports) port.close();
    bridge.abort();
    view.remove();
    for (const el of shut) el.removeAttribute("inert");
    const active = document.activeElement;
    if (!active || active === document.body) {
      const composer = document.querySelector<HTMLElement>("[data-composer] textarea:not(:disabled)");
      for (const el of [before, holder, composer]) {
        if (!el?.isConnected) continue;
        el.focus({ preventScroll: true });
        if (document.activeElement === el) break;
      }
    }
    // Closed by ✕, Escape or the lock: its entry goes too, back to the one the app was on.
    if (!handingOver && isViewEntry(history.state)) leaveViewEntry();
  };
  // Taken before the page's own listeners and spent here: a modal of the app under the view (the chat's Shared services
  // dialog it was opened from) would close on the same Escape.
  const onKey = (event: KeyboardEvent) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); end(); };
  const onPop = () => { if (!isViewEntry(history.state)) end(); };
  // Input in the app's frame never reaches this page (another origin): what does is the person's on Ghostly's own.
  const onOwnInput = () => { ownInput = Date.now(); };
  const OWN_INPUTS = ["pointerdown", "keydown", "touchend"] as const;
  watchDeadEntries();
  if (!isViewEntry(history.state)) history.pushState({ ...(history.state as Record<string, unknown> | null), [ENTRY]: true }, "");
  addEventListener("message", onMessage);
  addEventListener("keydown", onKey, true);
  addEventListener("popstate", onPop);
  for (const type of OWN_INPUTS) addEventListener(type, onOwnInput, true);
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
