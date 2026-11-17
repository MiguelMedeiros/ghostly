import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import { carryIncomingShare, incomingShare, receiveShare, type IncomingShare } from "../../../ui/src/lib/incomingShare";
import { activeProfileId, listProfiles, switchProfile } from "../../../ui/src/lib/profiles";
import type { ChatTaken, FromWorker, ToWorker, WindowSays } from "../sw/messages";

/*
 * The page's side of the service worker (`src/sw/sw.ts`): registering it, putting a new version in place when
 * the user presses Reload, taking what another app shared, and hearing that a file of this build is gone. Everything
 * here is behind feature detection: a browser without service workers runs the app exactly as before, from the
 * network.
 */

const SCRIPT = "/sw.js";

function container(): ServiceWorkerContainer | null {
  // Reading it can throw where the browser refuses service workers outright (site data blocked): then there is none.
  try { return "serviceWorker" in navigator && window.isSecureContext ? navigator.serviceWorker ?? null : null; } catch { return null; }
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
  const register = () => {
    // Refused, by a rejection or by throwing (private mode, storage off, a browser that blocks workers): the app
    // works from the network, as it did before there was a worker.
    try { void workers.register(SCRIPT, { scope: "/", updateViaCache: "none" }).catch(() => {}); } catch { /* no worker */ }
  };
  if (document.readyState === "complete") register();
  else addEventListener("load", register, { once: true });
}

/** A deploy was found (`/version.json`): the browser fetches the new worker now, so it is ready when Reload is pressed. */
export function prepareUpdate(): void {
  void container()?.getRegistration().then((registration) => registration?.update()).catch(() => {});
}

/**
 * The new worker once it is installed. Called after `update()` settled: a new script is `installing` by then, so
 * with neither a waiting nor an installing worker the active one is already the newest (another tab's Reload put it
 * in control of this page too) and there is nothing to wait for (`"none"`). `"failed"`: the new worker's install
 * failed (it went redundant: a file of its precache missing, storage full, the network gone mid-way) or did not
 * finish in time.
 */
function installed(registration: ServiceWorkerRegistration, timeoutMs: number): Promise<ServiceWorker | "none" | "failed"> {
  if (registration.waiting) return Promise.resolve(registration.waiting);
  const worker = registration.installing;
  if (!worker) return Promise.resolve("none");
  if (worker.state === "redundant") return Promise.resolve("failed");
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(registration.waiting ?? "failed"), timeoutMs);
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") { clearTimeout(timer); resolve(worker); }
      if (worker.state === "redundant") { clearTimeout(timer); resolve("failed"); }
    });
  });
}

/** The build this page runs, as `/version.json` names it; null where the build does not say (the dev server, tests). */
function runningBuild(): { version: string; build: string } | null {
  return typeof __APP_VERSION__ === "string" && typeof __APP_BUILD__ === "string" ? { version: __APP_VERSION__, build: __APP_BUILD__ } : null;
}

/**
 * Whether the server answers now with another build than this page's (a new version, a redeploy or a rollback).
 * False whenever that is not sure: no answer (offline, a timeout, an error status), one that does not read as a
 * version file, or a page that does not know its own build. `/version.json` always goes to the network (`policy.ts`).
 */
async function otherBuildOut(): Promise<boolean> {
  const running = runningBuild();
  if (!running) return false;
  try {
    return (await checkVersionFeed({
      url: new URL("version.json", document.baseURI).toString(),
      currentVersion: running.version,
      currentBuild: running.build,
      // Any other build than this one, whatever its version: the worker that failed to install was that build's.
      buildGone: true,
      apply: "reload",
    })) !== null;
  } catch {
    return false;
  }
}

/** This page pressed Reload and reloads on its own once the new worker takes it (not `followNewVersion`). */
let applying = false;

/**
 * Reload into the new version: the waiting worker (fetched now if it is not yet) takes over, then the page
 * reloads on it. The worker never does this on its own, so a deploy never swaps the app under a chat. With no
 * worker or none newer, it is a plain reload.
 *
 * A new worker that cannot install (its fetch refused, its install failed, or not done in time) would leave the old
 * one answering the reload with the old build's page, every time Reload is pressed. So once `/version.json` says
 * another build is out, the old worker is unregistered first: the reload then loads the new build from the network,
 * which registers its own worker again (`registerServiceWorker`), and only offline use waits for that one to install.
 * Without that answer (offline, the server down, no other build) the old worker stays: it is what opens the app
 * offline. The old build's caches stay too: the next worker's install takes the files they share from them, and its
 * activation deletes them.
 */
export async function applyUpdate({ timeoutMs = 60_000, reload = () => window.location.reload() } = {}): Promise<void> {
  const workers = container();
  const registration = await workers?.getRegistration().catch(() => undefined);
  if (workers && registration?.active && workers.controller) {
    const fetched = await registration.update().then(() => true, () => false);
    const next = await installed(registration, timeoutMs);
    if (next !== "none" && next !== "failed") {
      applying = true;
      await new Promise<void>((resolve) => {
        workers.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 10_000);
        tell(next, { type: "skip-waiting" });
      });
      applying = false;
    } else if ((next === "failed" || !fetched) && await otherBuildOut()) {
      await registration.unregister().catch(() => false);
    }
  }
  reload();
}

// ---------- another tab took a new version ----------

/**
 * Keeps this page off a build another tab replaced. Reload on "New version" in one tab activates the new worker,
 * which takes every open page of the app and deletes the old build's files: a page still running that build could
 * no longer open any screen it had not opened yet. A page that runs the app reloads into the new version at once.
 * A page waiting for another tab's lock reloads instead of starting once the lock is its own, after `handOver` (the
 * tab that pressed Reload asking for it again), so that tab runs the app and this one waits on the new build.
 *
 * Called before anything else of the page's start. Returns what the page awaits once the lock is its own: it
 * resolves when the app may start here, and never when the page reloads instead.
 */
export function followNewVersion({ reload = () => window.location.reload() } = {}): (handOver: () => Promise<void>) => Promise<void> {
  const workers = container();
  let current = workers?.controller ?? null;
  let replaced = false;
  let running = false;
  workers?.addEventListener("controllerchange", () => {
    const before = current;
    current = workers.controller;
    // The first worker of all takes a page that had none: the same build, nothing replaced.
    if (!before || current === before || applying) return;
    replaced = true;
    if (running) reload();
  });
  return async (handOver) => {
    if (replaced) {
      await handOver();
      reload();
      return new Promise<never>(() => {});
    }
    running = true;
  };
}

// ---------- a build gone from the server ----------

let gone = false;
const goneListeners = new Set<() => void>();

/**
 * Whether the worker found a file of this build gone from the server: a deploy replaced it, and a wallet or Iroh
 * opened now fails for good. Stays true for the page's life (the files do not come back), so every later check
 * offers the new build too, including a redeploy of the same version.
 */
export function buildGone(): boolean {
  return gone;
}

/** Calls `listener` when the worker says a file of this build is gone, so the app checks at once. Returns what stops it. */
export function onBuildGone(listener: () => void): () => void {
  goneListeners.add(listener);
  return () => { goneListeners.delete(listener); };
}

/** The worker said so. The check that follows fetches the new worker once it finds the deploy (`prepareUpdate`). */
function noteBuildGone(): void {
  gone = true;
  for (const listener of goneListeners) listener();
}

// ---------- share target ----------

/** Whether this page was opened for a share (the worker redirects there after the POST). */
export function openedForShare(): boolean {
  return window.location.hash === "#/shared" || window.location.hash.startsWith("#/shared?");
}

/**
 * What the worker tells this page, now and later. Shares: a share made while this tab is the app arrives here from
 * another tab that opened for it, and each goes to the "Share to…" picker. A file of this build gone from the server:
 * the app's update check runs now (`onBuildGone`). A wake-up notification tapped: `listenForTaps`. `peerLock`: the lock
 * this page holds as its profile's peer, which the worker checks before it forwards a share here.
 */
export function listenForShares(peerLock?: string): void {
  const workers = container();
  if (!workers) return;
  workers.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message?.type === "build-gone") { noteBuildGone(); return; }
    // The worker restarted since this page last said it takes shares, and has one to forward: said again, unfocused.
    if (message?.type === "share-where") { here(); return; }
    if (message?.type !== "share" || !message.item) return;
    const { item } = message;
    // The page restarts with it still in the picker (a profile switch): the worker holds it again for the next page,
    // with the count of those not kept that it shows.
    const carry = (lost?: number) => {
      if (!workers.controller) return false;
      tell(workers.controller, { type: "share-keep", item, ...(typeof lost === "number" && lost > 0 && { dropped: lost }) });
      return true;
    };
    // Any website can post to the share target: a share waits behind one already in the picker, never in its place.
    // The picker opens wherever it is not on screen, so the one it shows is never one left there unseen (the person
    // went to a chat with it still waiting). Those the worker could not keep are said with it.
    const dropped = typeof message.dropped === "number" && message.dropped > 0 ? message.dropped : 0;
    receiveShare({ ...(item as IncomingShare), carry, ...(dropped > 0 && { dropped }) }, { queue: true });
    if (incomingShare() && !openedForShare()) window.location.hash = "#/shared";
  });
  workers.startMessages();
  // A share into this same window replaces this page with one opened for it: the shares still in the picker go back
  // to the worker, which hands them to that page ahead of the new one, instead of going with this page.
  // Said to the worker too, so it forwards no share to this page on its way out without waiting for its lock to go;
  // a page that dies says nothing, and the lock the browser lets go of says it then.
  addEventListener("pagehide", () => {
    carryIncomingShare();
    tell(workers.controller, { type: "share-away" });
  });
  // This page takes the shares forwarded to its profile: the worker gives one to the page of the profile in front last.
  // With it, how Web Locks names this page as its holder (not the worker's id for the page, in Chromium): the worker
  // forwards only to a page whose lock is still held, and the browser lets go of a dead page's without a word.
  const holder = peerLock ? lockHolder(peerLock) : Promise.resolve(undefined);
  const here = () => void holder.then((lock) => tellReady({ type: "share-here", profile: activeProfileId(), ...(lock && { lock }) }));
  here();
  addEventListener("focus", here);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") here(); });
}

/** The holder of the lock `name` this page holds, as `navigator.locks.query()` names it; undefined where it cannot tell. */
async function lockHolder(name: string): Promise<string | undefined> {
  const state = await Promise.resolve().then(() => navigator.locks.query()).catch(() => null);
  return state?.held?.find((lock) => lock.name === name)?.clientId;
}

/** Tells the active worker, once there is one, even before it controls this page. */
function tellReady(message: ToWorker): void {
  const workers = container();
  void workers?.ready.then((registration) => tell(workers.controller ?? registration.active, message)).catch(() => {});
}

/**
 * A wake-up notification tapped, heard from the moment the page loads, whether it runs the app or waits behind another
 * tab. The push worker first asks every window what it runs (`open-ask`), to tell the one that holds the notice's
 * profile's peer to open the chat (`open-chat`). One that waits gets it only when no window answered for that profile
 * (a new window it opened, or pages of an older build): of its own profile, the chat is where it starts once it takes
 * over; of another, it runs nothing, so it switches. `peer`: whether this page holds its profile's peer yet.
 *
 * One that said nothing in time (frozen or busy) is told only on a guess (`silent`): holding another profile's peer, it
 * stays that profile (WISP 04) and hands the chat back, and the worker opens a new window on it.
 */
export function listenForTaps(peer: () => boolean): void {
  const workers = container();
  if (!workers) return;
  workers.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message?.type === "open-ask") { event.ports[0]?.postMessage({ profile: activeProfileId(), peer: peer() } satisfies WindowSays); return; }
    if (message?.type !== "open-chat") return;
    if (!message.silent) { openChat(message.path, message.profile); return; }
    const taken = message.profile === activeProfileId() || !peer();
    if (taken) openChat(message.path, message.profile);
    event.ports[0]?.postMessage({ taken } satisfies ChatTaken);
  });
  workers.startMessages();
}

/**
 * A wake-up notification was tapped: its chat, in its profile. Another profile's chat means switching to it (the
 * app restarts as that profile, on that chat). Only a chat or group route, or the app's home (`/`: the notice of a
 * device that is not the active one, which opens its standby screen, WISP 06 § Push and the phone); anything else is
 * ignored.
 */
export function openChat(path: string, profile: string): void {
  if (typeof path !== "string" || (path !== "/" && !/^\/(chat|group)\/[^/?#]+$/.test(path))) return;
  if (profile === activeProfileId()) {
    if (window.location.hash !== `#${path}`) window.location.hash = path;
    return;
  }
  if (listProfiles().some((p) => p.id === profile)) switchProfile(profile, { route: path });
}

/**
 * This page holds the peer: ask the worker for the share it is holding for it. `opened`: whether this page was opened
 * for one, when its address may no longer say so (a link reached it while it waited behind another tab).
 */
export function askForShare(opened = openedForShare()): void {
  const workers = container();
  if (!workers || !opened) return;
  tellReady({ type: "share-ready" });
}

/** How long a tab opened for a share waits for the peer's lock before it hands the share to the tab that holds it. */
export const SHARE_FORWARD_AFTER_MS = 3000;

/**
 * Another tab of this profile holds the peer: the worker hands the share to that one instead, and to no other.
 * `answered` hears what came of it: handed over (true), or nothing was held to forward (false). Told at once to the
 * worker that controls this page, so it is said even from `pagehide`. `opened`: whether this page was opened for one,
 * when its address may no longer say so.
 */
export function forwardShare(answered: (forwarded: boolean) => void = () => {}, opened = openedForShare()): void {
  const workers = container();
  if (!workers || !opened) return;
  workers.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    const type = event.data?.type;
    if (type === "share-forwarded" || type === "share-none") answered(type === "share-forwarded");
  });
  workers.startMessages();
  const message: ToWorker = { type: "share-forward", profile: activeProfileId() };
  if (workers.controller) tell(workers.controller, message);
  else tellReady(message);
}

/**
 * This tab opened for a share while another tab of its profile is the app: that tab gets it. Not at once: a share
 * posted from this same window (the system opens the app's window for it) replaces a page that holds the lock a moment
 * longer on its way out, so the share is forwarded after `afterMs`, unless this tab holds the peer by then (`peer`:
 * it asks for it itself). Closed or left before that, it forwards as it goes. Either way the worker hands it only to a
 * page that holds the peer's lock and still does a moment later, so never to the page on its way out; none, it keeps
 * it for the next app page. `answered`: the worker handed it over, or there was none. A link that reaches this tab
 * meanwhile takes its address (and the tab that is the app takes it out again): the share is forwarded all the same.
 */
export function handShareOver(peer: () => boolean, answered: (state: "shared" | "shareNone") => void, afterMs = SHARE_FORWARD_AFTER_MS): void {
  const opened = openedForShare();
  let asked = false;
  const forward = () => {
    if (asked || peer()) return;
    asked = true;
    forwardShare((forwarded) => { if (!peer()) answered(forwarded ? "shared" : "shareNone"); }, opened);
  };
  setTimeout(forward, afterMs);
  addEventListener("pagehide", forward);
}
