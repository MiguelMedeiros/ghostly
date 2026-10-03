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
import { CACHE_PREFIX, SHARED_ROUTE, classify, pushNotice, pushScopeProfile, readShare, readShareBody, type SharedItem } from "./policy";
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
  // `reload`: past the browser's HTTP cache, so the shell is this deploy's and not an older copy.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(__SW_PRECACHE__.map((path) => new Request(path, { cache: "reload" })))));
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
async function asset(key: string, request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.status === 200 && response.type === "basic") await cache.put(key, response.clone()).catch(() => {});
  return response;
}

// ---------- share target ----------

let held: { item: SharedItem; done: () => void } | null = null;

function share(event: FetchEvent): void {
  let done = () => {};
  const delivered = new Promise<void>((resolve) => { done = resolve; });
  event.respondWith((async () => {
    try {
      // Read with a cap before it is parsed: `formData()` alone would hold a body of any size in memory.
      const body = await readShareBody(event.request);
      if (!body) throw new Error("share too large");
      const type = event.request.headers.get("content-type") ?? "";
      const item = readShare(await new Response(body, { headers: { "content-type": type } }).formData());
      held?.done();
      held = { item, done };
      setTimeout(() => { if (held?.done === done) { held = null; done(); } }, SHARE_HOLD_MS);
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
  else event.respondWith(asset(key, request));
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
