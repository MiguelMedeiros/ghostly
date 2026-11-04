/**
 * The bridge: the one page of the app's own on a contact's app origin (`/_ghostly-svc/bridge.html`), framed by the
 * app's page. It takes the MessagePort the app hands it, registers the services worker for this origin, and frames
 * the contact's app (`/`) once the worker is in place. From then on it only passes each request the worker hands it on
 * to the app, with the request's own port, so the answer goes straight back to the worker. Built on its own into
 * `/_ghostly-svc/bridge.js` (apps/web/svcBuild.ts).
 */
import { BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_PORT, BRIDGE_READY, SERVICE_FRAME_ALLOW, WORKER_SCRIPT, isServiceHostname, parseServicesHost } from "./protocol";
import { clearSite, dropSharedCookies } from "./clearSite";

declare const __SERVICES_HOST__: string;
/** The app's own origin: the one page that may hand this bridge its port. */
declare const __SERVICES_APP_ORIGIN__: string;

function say(text: string): void {
  document.body.textContent = text;
}

function start(): void {
  const host = parseServicesHost(__SERVICES_HOST__);
  // Only framed, and only on a contact's app origin: anywhere else (the app's own, opened directly) it does nothing.
  if (!host || !isServiceHostname(host, location.hostname) || window.parent === window || !navigator.serviceWorker) {
    say("Nothing to show here.");
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
    // One left by another contact's app (any chat, any profile) is not this one's to read.
    dropSharedCookies(host.suffix);
    void workers.register(WORKER_SCRIPT, { scope: "/", updateViaCache: "none" })
      .then(() => workers.ready)
      .then(() => {
        const frame = document.createElement("iframe");
        frame.title = document.title;
        frame.setAttribute("allow", SERVICE_FRAME_ALLOW);
        // This page sends no referrer (its server says so); the worker forwards a navigation only with this origin's.
        frame.setAttribute("referrerpolicy", "same-origin");
        frame.src = "/";
        document.body.replaceChildren(frame);
      }, () => say("This browser cannot open the app here."));
  });
  window.parent.postMessage({ type: BRIDGE_READY }, __SERVICES_APP_ORIGIN__);
}

start();
