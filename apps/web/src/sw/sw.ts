/**
 * Ghostly's service worker (web app only). Built on its own into `/sw.js` by `apps/web/pwa.ts`, which fills in the
 * build id and the list of files to precache.
 *
 * - The app shell comes from the cache of the version this worker was built with, so the app opens offline
 *   and a deploy never swaps the code under a running chat. A new worker installs in the background and
 *   waits; it takes over when the user presses Reload on "New version" (the page says `skip-waiting`), or
 *   once no tab of the app is left.
 * - Nothing else is stored: `policy.ts` lets only the build's own files into the cache.
 * - What another app shares into Ghostly arrives here as a POST, is held in memory (never in a cache) until
 *   the app's page asks for it, and is dropped after `SHARE_HOLD_MS` if nobody does.
 * - The same script, registered again at `/push/<profile>/`, is that profile's push worker: it controls no
 *   page and caches nothing, and only shows wake-ups (WISP 401 § Wake-up push). A scope per profile gives each
 *   profile a push subscription of its own, so contacts of two profiles cannot tell they share a browser.
 */
import { CACHE_PREFIX, SHARED_ROUTE, assetAnswer, classify, precacheMode, pushNotice, pushScopeProfile, readShare, readShareBody, TOO_LARGE_SHARE, type SharedItem } from "./policy";
import { readWakeEntry, readWakeText } from "./wakeStore";
import { readPushDeviceView } from "./deviceState";
import { deviceNoticeWords } from "./deviceWords";
import { takeWakeSlot } from "./wakeLimit";
import { readWake } from "../../../../packages/core/src/pairedWake";
import { SHARE_HOLD_MS, type FromWorker, type ToWorker } from "./messages";

declare const __SW_BUILD__: string;
declare const __SW_PRECACHE__: string[];

// The few worker APIs used here, typed locally: the web app's tsconfig has the DOM library, not WebWorker's.
interface ExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(response: Promise<Response> | Response): void }
interface WindowClient { id: string; url: string; focused?: boolean; visibilityState?: string; postMessage(message: FromWorker): void; focus?(): Promise<WindowClient> }
interface PushEvent extends ExtendableEvent { data: { text(): string } | null }
interface Shown { data: unknown; close(): void }
interface NotificationEvent extends ExtendableEvent { notification: Shown }
interface MessageEvent_ extends ExtendableEvent { data: unknown; source: WindowClient | null }
interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  registration: { scope: string; showNotification(title: string, options: object): Promise<void>; getNotifications(filter?: { tag?: string }): Promise<Shown[]> };
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled?: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<WindowClient | null>;
  };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent_) => void): void;
}
const worker = self as unknown as WorkerScope;

const CACHE = CACHE_PREFIX + __SW_BUILD__;
const PRECACHED = new Set(__SW_PRECACHE__);
/** The profile this worker wakes, when it is a push worker (`/push/<profile>/`); null for the app's own. */
const PUSH_PROFILE = pushScopeProfile(worker.registration.scope);

worker.addEventListener("install", (event) => {
  if (PUSH_PROFILE !== null) return;
  // The page and the files beside it past the browser's HTTP cache; the hashed files from it when it has them.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(__SW_PRECACHE__.map((path) => new Request(path, { cache: precacheMode(path) })))));
});

worker.addEventListener("activate", (event) => {
  // Only ever active on a first install, after Reload (the page reloads at once), or with no tab open: taking
  // the open pages swaps nothing under anyone.
  if (PUSH_PROFILE !== null) return;
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE).map((name) => caches.delete(name)));
    await worker.clients.claim();
  })());
});

async function fromCache(key: string, request: Request): Promise<Response> {
  const cached = await caches.match(key, { cacheName: CACHE });
  return cached ?? fetch(request);
}

/** A build file that was not precached: kept once fetched. Only whole, same-origin answers. */
async function asset(key: string, request: Request, event: ExtendableEvent): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  // Answered at once and stored behind it: `put` settles with the last byte, and these are the wasm modules (2 to
  // 12 MiB) the page compiles while they arrive. A 404 means a deploy replaced this build and the file is gone, so
  // the open pages are told to look for the new version now, instead of hours later at their next check.
  const verdict = assetAnswer(response);
  if (verdict === "store") event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  else if (verdict === "gone") event.waitUntil(tellBuildGone());
  return response;
}

/** Told once per life of this worker: a wallet's Try again asks for the same gone file, and the pages already know. */
let toldGone = false;

/** Every open page of the app is told a file of its build is gone: it checks for the new version at once. */
async function tellBuildGone(): Promise<void> {
  if (toldGone) return;
  toldGone = true;
  const all = await worker.clients.matchAll({ type: "window" });
  for (const client of all) client.postMessage({ type: "build-gone" });
}

// ---------- share target ----------

let held: { item: SharedItem; done: () => void } | null = null;

/** Holds a share for the page that asks for it, in place of one held before; `done` once it is taken or dropped. */
function hold(item: SharedItem, done: () => void): void {
  held?.done();
  held = { item, done };
  setTimeout(() => { if (held?.done === done) { held = null; done(); } }, SHARE_HOLD_MS);
}

function share(event: FetchEvent): void {
  let done = () => {};
  const delivered = new Promise<void>((resolve) => { done = resolve; });
  event.respondWith((async () => {
    try {
      // Read with a cap before it is parsed: `formData()` alone would hold a body of any size in memory.
      // A larger one is held all the same, as a share with nothing in it but that it was too large: the picker says so.
      const body = await readShareBody(event.request);
      const type = event.request.headers.get("content-type") ?? "";
      const item = body ? readShare(await new Response(body, { headers: { "content-type": type } }).formData()) : TOO_LARGE_SHARE;
      hold(item, done);
    } catch {
      done();
    }
    return Response.redirect(SHARED_ROUTE, 303);
  })());
  // The worker stays up while the share waits, so what is held in memory is not lost with it.
  event.waitUntil(delivered);
}

worker.addEventListener("message", (event) => {
  const message = event.data as ToWorker | null;
  if (!message || typeof message !== "object") return;
  if (message.type === "skip-waiting") { void worker.skipWaiting(); return; }
  if (message.type === "open-notification") {
    if (PUSH_PROFILE === null || typeof message.tag !== "string") return;
    event.waitUntil(worker.registration.getNotifications({ tag: message.tag }).then(([shown]) => (shown ? openFrom(shown) : undefined)));
    return;
  }
  if (message.type === "share-keep") {
    if (PUSH_PROFILE !== null || !message.item || typeof message.item !== "object") return;
    // The worker stays up while it waits again, as a share just posted does.
    event.waitUntil(new Promise<void>((resolve) => hold(message.item, resolve)));
    return;
  }
  const source = event.source;
  if (!source) return;
  if (message.type === "share-ready") {
    const taken = held;
    held = null;
    source.postMessage(taken ? { type: "share", item: taken.item } : { type: "share-none" });
    taken?.done();
    return;
  }
  if (message.type === "share-forward") {
    const taken = held;
    if (!taken) { source.postMessage({ type: "share-none" }); return; }
    event.waitUntil(worker.clients.matchAll({ type: "window" }).then((all) => {
      const others = all.filter((client) => client.id !== source.id);
      // No other window to give it to: it stays held, for whichever page asks next (this one, once it is the app).
      if (!others.length || held !== taken) return;
      held = null;
      for (const client of others) client.postMessage({ type: "share", item: taken.item });
      taken.done();
    }));
  }
});

// ---------- fetch ----------

worker.addEventListener("fetch", (event) => {
  if (PUSH_PROFILE !== null) return;
  const { request } = event;
  const route = classify(
    { method: request.method, url: request.url, mode: request.mode, range: request.headers.has("range") },
    worker.location.origin,
    PRECACHED,
  );
  if (route === "pass") return;
  if (route === "share") { share(event); return; }
  const key = new URL(request.url).pathname;
  if (route === "shell") event.respondWith(fromCache("/", request));
  else if (route === "precache") event.respondWith(fromCache(key, request));
  else event.respondWith(asset(key, request, event));
});

// ---------- wake-up push ----------

/** The windows showing the app (its page, any screen): they belong to the app's own worker, not to this one. */
async function appWindows(): Promise<WindowClient[]> {
  const all = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.filter((client) => { try { return ["/", "/index.html"].includes(new URL(client.url).pathname); } catch { return false; } });
}

worker.addEventListener("push", (event) => {
  if (PUSH_PROFILE === null) return;
  const profile = PUSH_PROFILE;
  event.waitUntil((async () => {
    const wake = readWake(event.data?.text());
    const found = wake ? await readWakeEntry(profile, wake.token).catch(() => undefined) : undefined;
    const appVisible = (await appWindows()).some((client) => client.focused || client.visibilityState === "visible");
    const now = Date.now();
    // In a profile on several devices the worker reads the device state itself (WISP 06 § Push and the phone): a device
    // that is not the active one shows the quiet notices, and a wake-up from another of the person's devices says so.
    const text = wake ? await readWakeText(profile).catch(() => undefined) : undefined;
    const device = wake ? await readPushDeviceView(text?.db).catch(() => null) : null;
    // A device that was never active may have no words of a page yet: the browser's language, not English, until one writes them.
    const words = { ...deviceNoticeWords(navigator.languages?.length ? navigator.languages : [navigator.language]), ...text };
    const notice = pushNotice(wake, found, device, { now, appVisible, profile, text: words });
    if (!notice || !wake) return;
    if (notice.quiet) {
      // Quiet: no sound, no vibration, nothing that stays up, and one notice per profile, replaced in place.
      await worker.registration.showNotification(notice.title, { body: notice.body, tag: notice.tag, data: notice.data, icon: "/icon-192.png", badge: "/icon-192.png", silent: true, renotify: false, requireInteraction: false });
      return;
    }
    const options = { body: notice.body, tag: notice.tag, data: notice.data, icon: "/icon-192.png", badge: "/icon-192.png", requireInteraction: notice.call };
    // A device asking for a handoff may ask again soon (its own limit is one per 30 s): it is counted like a call.
    if (!(await takeWakeSlot(profile, wake.token, notice.call || wake.kind === "device", now))) {
      // Too soon after this token's last one (`WAKE_NOTICE_GAP_MS`): no new notice and no sound. The one still on
      // screen is shown again, silently, since browsers expect every push to show something; a dismissed one stays gone.
      const [shown] = await worker.registration.getNotifications({ tag: notice.tag });
      if (shown) await worker.registration.showNotification(notice.title, { ...options, renotify: false, silent: true });
      return;
    }
    // A call stays until it is answered or dismissed, and buzzes again: a web app cannot ring like a phone call.
    await worker.registration.showNotification(notice.title, {
      ...options, renotify: notice.call, ...(notice.call && { vibrate: [300, 200, 300, 200, 300] }),
    });
  })());
});

/** A tap on a wake-up: the app's window comes forward on that chat, or a new one opens there. */
async function openFrom(notification: Shown): Promise<void> {
  notification.close();
  const data = notification.data as { path?: unknown; profile?: unknown } | null;
  if (typeof data?.path !== "string" || typeof data.profile !== "string") return;
  const message: FromWorker = { type: "open-chat", path: data.path, profile: data.profile };
  const [open] = await appWindows();
  if (open) {
    await open.focus?.().catch(() => undefined);
    open.postMessage(message);
    return;
  }
  // A new window of the app: it takes the chat (and the profile) from this message once it has started.
  const opened = await worker.clients.openWindow(`/#${data.path}`);
  opened?.postMessage(message);
}

worker.addEventListener("notificationclick", (event) => {
  event.waitUntil(openFrom(event.notification));
});
