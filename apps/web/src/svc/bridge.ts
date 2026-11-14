/**
 * The bridge: the one page of the app's own on a contact's app origin (`/_ghostly-svc/bridge.html`), framed by the
 * app's page. It takes the MessagePort the app hands it, registers the services worker for this origin, and frames
 * the contact's app (`/`) once the worker is in place. From then on it only passes each request the worker hands it on
 * to the app, with the request's own port, so the answer goes straight back to the worker. Built on its own into
 * `/_ghostly-svc/bridge.js` (apps/web/svcBuild.ts).
 */
import { BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_OPEN_LINK, BRIDGE_PORT, BRIDGE_READY, BRIDGE_REFUSED, BRIDGE_SHOWN, SERVICE_FRAME_ALLOW, WORKER_SCRIPT, isServiceHostname, parseServicesHost, type BridgeRefusal } from "./protocol";
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
const stateOf = describe(Document.prototype, "readyState")?.get;
const ownNavigator = navigator;
const activationOf = describe(Navigator.prototype, "userActivation")?.get;
const activeOf = typeof UserActivation === "undefined" ? undefined : describe(UserActivation.prototype, "isActive")?.get;
const clock = Date.now;

/**
 * How long a tap or a key in the app's page counts as the person's (a browser's activation lasts about 5 s): a link the
 * app opens later is not opened for them.
 */
const INPUT_COUNTS_MS = 5_000;

/**
 * Whether the person is using the app's page in `win` now: they pressed or tapped in it in the last few seconds, and
 * that activates this page too, as its parent. Not a tap or a key in Ghostly's page around it (another origin), which
 * activates neither; nor the tap on Open that started the app, whose activation the browser also hands the frames it
 * makes right after, this one and the app's: no input of the app's page came with it. False where the browser cannot
 * say. The app's page can stop its own inputs reaching here, which only makes it open nothing.
 */
export function watchUse(win: Window): () => boolean {
  let input = -Infinity;
  const seen = (event: Event) => { if (event.isTrusted) input = clock(); };
  for (const type of ["pointerdown", "keydown", "touchend"]) win.addEventListener(type, seen, true);
  return () => {
    if (clock() - input > INPUT_COUNTS_MS) return false;
    try {
      const activation = activationOf ? apply(activationOf, ownNavigator, []) as UserActivation | undefined : undefined;
      return !!activation && !!activeOf && apply(activeOf, activation, []) === true;
    } catch {
      return false;
    }
  };
}

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
    return guardRan(doc);
  } catch {
    return false;
  }
}

/** Whether the clipboard guard ran in this document: it marked it and fixed its window's `execCommand` in place. */
export function guardRan(doc: Document): boolean {
  try {
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
 * alone, `window.open` with no target or `_blank`; one to a name no window or frame has yet, such as `_new`, which a
 * browser opens in a new window too), which the view's sandbox would drop with no word: the app's page opens one to
 * another site in a new tab (`outsideLink` in opener.ts). A name one of the page's frames has stays that frame's. Not
 * a guard: the page can skip it, or ask for any link, and the app's page decides what opens.
 */
export function forwardLinks(win: Window, ask: (url: string) => void): void {
  const blank = (target: unknown) => typeof target === "string" && target.toLowerCase() === "_blank";
  // This page or a frame around it, never a new window.
  const here = (target: string) => ["_self", "_parent", "_top"].includes(target.toLowerCase());
  const open = win.open;
  // The browser finds the window a name points to: with no address it loads nothing there, and the sandbox refuses
  // the new window a name nobody has would open (null), which leaves the person's tap in place.
  const named = (target: string) => apply(open, win, ["", target]) !== null;
  win.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.composedPath().find((node) => ["a", "area"].includes((node as Element).localName)) as HTMLAnchorElement | undefined;
    if (!link?.href) return;
    const target = link.getAttribute("target") ?? win.document.querySelector("base[target]")?.getAttribute("target");
    if (!target || here(target) || (!blank(target) && named(target))) return;
    event.preventDefault();
    ask(link.href);
  });
  win.open = function (url?: string | URL, target?: string, features?: string) {
    if (target && !blank(target)) {
      const found = apply(open, win, [url, target, features]) as Window | null;
      if (found || here(target)) return found;
    }
    try { ask(new URL(String(url ?? ""), win.document.baseURI).href); } catch { /* not a URL: nothing opens */ }
    return null;
  };
}

/** Whether the frame still shows its first empty page (`about:blank`), or one this page cannot read: not the app. */
export function shownBlank(frame: HTMLIFrameElement): boolean {
  try {
    const doc = documentOf ? apply(documentOf, frame, []) as Document | null : null;
    return !doc || !urlOf || apply(urlOf, doc, []) === "about:blank";
  } catch {
    return true;
  }
}

/**
 * Whether the frame's page of the app is parsed, and one it may show (`guardedPage`): there to be seen, though its
 * pictures and frames may still be on their way. Its `load` waits for them, each up to the "too slow" answer.
 */
export function parsedPage(frame: HTMLIFrameElement): boolean {
  try {
    const doc = documentOf ? apply(documentOf, frame, []) as Document | null : null;
    return !!doc && !!stateOf && !shownBlank(frame) && apply(stateOf, doc, []) !== "loading" && guardedDocument(doc);
  } catch {
    return false;
  }
}

/** How often the bridge looks whether the app's first page is parsed, until it is. */
const PARSED_LOOK_MS = 100;

function say(text: string): void {
  document.body.textContent = text;
}

/** Shows no app, and tells the app's page why: it says so in the profile's words (`BRIDGE_REFUSED`). */
function refuse(reason: BridgeRefusal, text: string): void {
  say(text);
  window.parent.postMessage({ type: BRIDGE_REFUSED, reason }, __SERVICES_APP_ORIGIN__);
}

/** One of this page's guards did not run: what the person sees, and why for whoever runs the server. */
function refused(guard: string): void {
  console.error(`Ghostly: this page's Content-Security-Policy refused ${guard}; its script-src must carry the hashes of this build (nginx-services.conf).`);
  say("This app cannot be opened here: this server's policy is out of date.");
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
        // Only one the person opens in the app (`watchUse`): the app's page checks its own activation too, which a tap
        // on Ghostly's Open, or one in Ghostly's page, gives it for seconds while the app's page loads or runs.
        if (win) {
          const using = watchUse(win);
          forwardLinks(win, (url) => { if (using()) window.parent.postMessage({ type: BRIDGE_OPEN_LINK, url }, __SERVICES_APP_ORIGIN__); });
        }
      } catch { /* a page that is not HTML: nothing to hand on */ }
      // Not the frame's first empty page: the contact's own, or what Ghostly says in its place (too slow, unreachable).
      if (!shownBlank(app)) window.parent.postMessage({ type: BRIDGE_SHOWN }, __SERVICES_APP_ORIGIN__);
      return;
    }
    app = null;
    refuse("unguarded", "This page of the app cannot be shown here.");
  }, true);
  // The app's page reaches this window (same origin): its `execCommand`, and a frame it would put here, are guarded too.
  guardHere(CLIPBOARD_GUARD_SCRIPT);
  // A policy that does not allow it (a server's stale hash for it) refuses it without a word: no app is shown then.
  if (!guardRan(document)) {
    refused("the clipboard guard");
    return;
  }
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
    if ((event.data as { relayOnly?: unknown }).relayOnly === true) {
      guardHere(VIEWER_GUARD_SCRIPT);
      if ("RTCPeerConnection" in window || "webkitRTCPeerConnection" in window) {
        refused("the WebRTC guard");
        return;
      }
    }
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
        // Its first page is said shown once it is parsed, not only at its `load`: the app's page says the app is
        // opening until then, over the frame. Only the first: the app's page needs no more.
        const parsed = setInterval(() => {
          if (app !== frame) clearInterval(parsed);
          else if (parsedPage(frame)) { clearInterval(parsed); window.parent.postMessage({ type: BRIDGE_SHOWN }, __SERVICES_APP_ORIGIN__); }
        }, PARSED_LOOK_MS);
      }, () => refuse("blocked", "This browser cannot open the app here."));
  });
  window.parent.postMessage({ type: BRIDGE_READY }, __SERVICES_APP_ORIGIN__);
}

start();
