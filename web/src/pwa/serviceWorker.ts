import { receiveShare, type IncomingShare } from "../../../src/lib/incomingShare";
import { activeProfileId, listProfiles, switchProfile } from "../../../src/lib/profiles";
import type { FromWorker, ToWorker } from "../sw/messages";

/*
 * The page's side of the service worker (`src/sw/sw.ts`): registering it, putting a new version in place when
 * the user presses Reload, and taking what another app shared. Everything here is behind feature detection: a
 * browser without service workers runs the app exactly as before, from the network.
 */

const SCRIPT = "/sw.js";

function container(): ServiceWorkerContainer | null {
  return "serviceWorker" in navigator && window.isSecureContext ? navigator.serviceWorker : null;
}

function tell(worker: ServiceWorker | null | undefined, message: ToWorker): void {
  worker?.postMessage(message);
}

/**
 * Registers the worker once the page has loaded (its precache download must not compete with the app's own
 * start). Builds only: the dev server serves no `/sw.js`. `updateViaCache: "none"`: the browser asks the server
 * for the worker's script itself on every check, never an HTTP-cached copy.
 */
export function registerServiceWorker(): void {
  const workers = container();
  if (!workers || !import.meta.env.PROD) return;
  const register = () => void workers.register(SCRIPT, { scope: "/", updateViaCache: "none" }).catch(() => {
    // Refused (private mode, storage off): the app works from the network, as it did before there was a worker.
  });
  if (document.readyState === "complete") register();
  else addEventListener("load", register, { once: true });
}

/** A deploy was found (`/version.json`): the browser fetches the new worker now, so it is ready when Reload is pressed. */
export function prepareUpdate(): void {
  void container()?.getRegistration().then((registration) => registration?.update()).catch(() => {});
}

function installed(registration: ServiceWorkerRegistration, timeoutMs: number): Promise<ServiceWorker | null> {
  if (registration.waiting) return Promise.resolve(registration.waiting);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(registration.waiting), timeoutMs);
    const follow = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") { clearTimeout(timer); resolve(worker); }
        if (worker.state === "redundant") { clearTimeout(timer); resolve(null); }
      });
    };
    if (registration.installing) follow(registration.installing);
    else registration.addEventListener("updatefound", () => follow(registration.installing), { once: true });
  });
}

/**
 * Reload into the new version: the waiting worker (fetched now if it is not yet) takes over, then the page
 * reloads on it. The worker never does this on its own, so a deploy never swaps the app under a chat. With no
 * worker, or none newer after a while, it is a plain reload.
 */
export async function applyUpdate({ timeoutMs = 60_000, reload = () => window.location.reload() } = {}): Promise<void> {
  const workers = container();
  const registration = await workers?.getRegistration().catch(() => undefined);
  if (workers && registration?.active && workers.controller) {
    await registration.update().catch(() => {});
    const next = await installed(registration, timeoutMs);
    if (next) {
      await new Promise<void>((resolve) => {
        workers.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 10_000);
        tell(next, { type: "skip-waiting" });
      });
    }
  }
  reload();
}

// ---------- share target ----------

/** Whether this page was opened for a share (the worker redirects there after the POST). */
export function openedForShare(): boolean {
  return window.location.hash === "#/shared" || window.location.hash.startsWith("#/shared?");
}

/**
 * Shares the worker hands this page, now and later: a share made while this tab is the app arrives here from
 * another tab that opened for it. Each goes to the "Share to…" picker.
 */
export function listenForShares(): void {
  const workers = container();
  if (!workers) return;
  workers.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message?.type === "open-chat") { openChat(message.path, message.profile); return; }
    if (message?.type !== "share" || !message.item) return;
    receiveShare(message.item as IncomingShare);
    if (!openedForShare()) window.location.hash = "#/shared";
  });
  workers.startMessages();
}

/**
 * A wake-up notification was tapped: its chat, in its profile. Another profile's chat means switching to it (the
 * app restarts as that profile, on that chat). Only a chat or group route; anything else is ignored.
 */
export function openChat(path: string, profile: string): void {
  if (typeof path !== "string" || !/^\/(chat|group)\/[^/?#]+$/.test(path)) return;
  if (profile === activeProfileId()) {
    if (window.location.hash !== `#${path}`) window.location.hash = path;
    return;
  }
  if (listProfiles().some((p) => p.id === profile)) switchProfile(profile, { route: path });
}

/** This page holds the peer: ask the worker for the share it is holding for it. */
export function askForShare(): void {
  const workers = container();
  if (!workers || !openedForShare()) return;
  void workers.ready.then((registration) => tell(workers.controller ?? registration.active, { type: "share-ready" })).catch(() => {});
}

/** How long a tab opened for a share waits for the peer's lock before it hands the share to the tab that holds it. */
export const SHARE_FORWARD_AFTER_MS = 3000;

/** Another tab holds the peer: the worker hands the share to that one instead. */
export function forwardShare(): void {
  const workers = container();
  if (!workers || !openedForShare()) return;
  void workers.ready.then((registration) => tell(workers.controller ?? registration.active, { type: "share-forward" })).catch(() => {});
}
