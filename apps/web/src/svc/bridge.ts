/**
 * The bridge: the one page of the app's own on a contact's app origin (`/_ghostly-svc/bridge.html`), framed by the
 * app's page. It takes the MessagePort the app hands it, registers the services worker for this origin, and frames
 * the contact's app (`/`) once the worker is in place. From then on it only passes each request the worker hands it on
 * to the app, with the request's own port, so the answer goes straight back to the worker. Built on its own into
 * `/_ghostly-svc/bridge.js` (apps/web/svcBuild.ts).
 */
import { BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_OPEN_LINK, BRIDGE_PORT, BRIDGE_READY, BRIDGE_REFUSED, SERVICE_FRAME_ALLOW, WORKER_SCRIPT, isServiceHostname, parseServicesHost, type BridgeRefusal } from "./protocol";
import { clearSite, dropSharedCookies } from "./clearSite";
import { VIEWER_GUARD_SCRIPT } from "../../../../packages/core/src/viewerGuard";
import { CLIPBOARD_GUARD_SCRIPT } from "../../../../packages/core/src/clipboardGuard";

declare const __SERVICES_HOST__: string;
/** The app's own origin: the one page that may hand this bridge its port. */
declare const __SERVICES_APP_ORIGIN__: string;

// Read before the app's frame is made: its page, on this origin, can change what this page's globals say.
const apply = Reflect.apply;
const describe = Object.getOwnPropertyDescriptor;
const protoOf = Object.getPrototypeOf;
const documentOf = describe(HTMLIFrameElement.prototype, "contentDocument")?.get;
const windowOf = describe(HTMLIFrameElement.prototype, "contentWindow")?.get;
const typeOf = describe(Document.prototype, "contentType")?.get;
const urlOf = describe(Document.prototype, "URL")?.get;

/**
 * Whether the page in the app's frame may be shown: one the clipboard guard ran first in (`CLIPBOARD_GUARD_SCRIPT`
 * marks the document it watches and leaves its window's `execCommand` fixed in place), or one that runs no script (an
 * empty frame; a page that is not HTML, which the app's page sends with `script-src 'none'`). A page whose policy or
 * browser refused the guard, or one this page cannot read (a `sandbox` policy of its own), is not.
 */
export function guardedPage(frame: HTMLIFrameElement): boolean {
  try {
    return guardedDocument(documentOf ? apply(documentOf, frame, []) as Document | null : null);
  } catch {
    return false;
  }
}

/** `guardedPage` for the document in the frame (null: one this page cannot read). */
export function guardedDocument(doc: Document | null): boolean {
  try {
    if (!doc || !typeOf || !urlOf) return false;
    if (apply(urlOf, doc, []) === "about:blank" || apply(typeOf, doc, []) !== "text/html") return true;
    const mark = describe(doc, "ghostlyClipboardGuard");
    if (!mark || mark.value !== true || mark.configurable || mark.writable) return false;
    for (let proto = protoOf(doc) as object | null; proto; proto = protoOf(proto) as object | null) {
      const found = describe(proto, "execCommand");
      if (found) return !found.configurable && !found.writable && typeof found.value === "function";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Hands `ask` each link the page in `win` opens in a new window (a click on a `target="_blank"` link the page left
 * alone, `window.open` with no target or `_blank`), which the view's sandbox would drop with no word: the app's page
 * opens one to another site in a new tab (`outsideLink` in opener.ts). Not a guard: the page can skip it, or ask for
 * any link, and the app's page decides what opens.
 */
export function forwardLinks(win: Window, ask: (url: string) => void): void {
  const blank = (target: unknown) => typeof target === "string" && target.toLowerCase() === "_blank";
  win.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.composedPath().find((node) => ["a", "area"].includes((node as Element).localName)) as HTMLAnchorElement | undefined;
    if (!link?.href) return;
    const target = link.getAttribute("target") ?? win.document.querySelector("base[target]")?.getAttribute("target");
    if (!blank(target)) return;
    event.preventDefault();
    ask(link.href);
  });
  const open = win.open;
  win.open = function (url?: string | URL, target?: string, features?: string) {
    if (target !== undefined && target !== "" && !blank(target)) return apply(open, win, [url, target, features]) as Window | null;
    try { ask(new URL(String(url ?? ""), win.document.baseURI).href); } catch { /* not a URL: nothing opens */ }
    return null;
  };
}

function say(text: string): void {
  document.body.textContent = text;
}

/** Shows no app, and tells the app's page why: it says so in the profile's words (`BRIDGE_REFUSED`). */
function refuse(reason: BridgeRefusal, text: string): void {
  say(text);
  window.parent.postMessage({ type: BRIDGE_REFUSED, reason }, __SERVICES_APP_ORIGIN__);
}

/** This page's own copy of the clipboard guard, inline (its policy allows it by its hash, `bridgeHtml`). */
function guardHere(script: string): void {
  const guard = document.createElement("script");
  guard.textContent = script;
  document.head.append(guard);
}

function start(): void {
  const host = parseServicesHost(__SERVICES_HOST__);
  // Only framed, and only on a contact's app origin: anywhere else (the app's own, opened directly) it does nothing.
  if (!host || !isServiceHostname(host, location.hostname) || window.parent === window || !navigator.serviceWorker) {
    say("Nothing to show here.");
    return;
  }
  let app: HTMLIFrameElement | null = null;
  // Each page the app's frame loads is looked at before this page's guard goes over the frame (both listen on the
  // document, as no `load` reaches the window; this one, put there first, runs first): one without the guard of its
  // own is taken away.
  // A page that may be shown has the links it opens in a new window handed to the app's page.
  document.addEventListener("load", (event) => {
    if (!app || event.target !== app) return;
    if (guardedPage(app)) {
      const win = windowOf ? apply(windowOf, app, []) as Window | null : null;
      try {
        if (win) forwardLinks(win, (url) => window.parent.postMessage({ type: BRIDGE_OPEN_LINK, url }, __SERVICES_APP_ORIGIN__));
      } catch { /* a page that is not HTML: nothing to hand on */ }
      return;
    }
    app = null;
    refuse("unguarded", "This page of the app cannot be shown here.");
  }, true);
  // The app's page reaches this window (same origin): its `execCommand`, and a frame it would put here, are guarded too.
  guardHere(CLIPBOARD_GUARD_SCRIPT);
  let appPort: MessagePort | null = null;
  const workers = navigator.serviceWorker;
  workers.addEventListener("message", (event) => {
    // A request from this origin's worker (no one else can post here), with the port its answer goes back on.
    if (!appPort) return;
    const reply = event.ports[0];
    if (!reply) return;
    const body = (event.data as { body?: unknown } | null)?.body;
    appPort.postMessage(event.data, body instanceof ArrayBuffer ? [reply, body] : [reply]);
  });
  workers.startMessages();

  addEventListener("message", (event) => {
    if (appPort || event.source !== window.parent || event.origin !== __SERVICES_APP_ORIGIN__) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    // The chat, its data or its profile went: what the contact's app kept here goes too.
    if (type === BRIDGE_CLEAR) {
      void clearSite(host.suffix).then(() => window.parent.postMessage({ type: BRIDGE_CLEARED }, __SERVICES_APP_ORIGIN__));
      return;
    }
    if (type !== BRIDGE_PORT || !event.ports[0]) return;
    appPort = event.ports[0];
    // Hide my IP from contacts: the app's frame is on this origin and reaches this window, so the WebRTC guard runs here
    // too, before the frame is made. Inline, as this page's policy allows it by its hash (`bridgeHtml`).
    if ((event.data as { relayOnly?: unknown }).relayOnly === true) guardHere(VIEWER_GUARD_SCRIPT);
    // One left by another contact's app (any chat, any profile) is not this one's to read: not framed while it stays.
    void dropSharedCookies(host.suffix)
      .then(() => workers.register(WORKER_SCRIPT, { scope: "/", updateViaCache: "none" }))
      .then(() => workers.ready)
      .then(() => {
        const frame = document.createElement("iframe");
        frame.title = document.title;
        frame.setAttribute("allow", SERVICE_FRAME_ALLOW);
        // This page sends no referrer (its server says so); the worker forwards a navigation only with this origin's.
        frame.setAttribute("referrerpolicy", "same-origin");
        frame.src = "/";
        app = frame;
        document.body.replaceChildren(frame);
      }, () => refuse("blocked", "This browser cannot open the app here."));
  });
  window.parent.postMessage({ type: BRIDGE_READY }, __SERVICES_APP_ORIGIN__);
}

start();
