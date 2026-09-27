/**
 * Ghostly's service worker (web app only). Built on its own into `/sw.js` by `web/pwa.ts`, which fills in the
 * build id and the list of files to precache.
 *
 * - The app shell comes from the cache of the version this worker was built with, so the app opens offline
 *   and a deploy never swaps the code under a running chat. A new worker installs in the background and
 *   waits; it takes over when the user presses Reload on "New version" (the page says `skip-waiting`), or
 *   once no tab of the app is left.
 * - Nothing else is stored: `policy.ts` lets only the build's own files into the cache.
 * - What another app shares into Ghostly arrives here as a POST, is held in memory (never in a cache) until
 *   the app's page asks for it, and is dropped after `SHARE_HOLD_MS` if nobody does.
 */
import { CACHE_PREFIX, SHARED_ROUTE, classify, readShare, type SharedItem } from "./policy";
import { SHARE_HOLD_MS, type FromWorker, type ToWorker } from "./messages";

declare const __SW_BUILD__: string;
declare const __SW_PRECACHE__: string[];

// The few worker APIs used here, typed locally: the web app's tsconfig has the DOM library, not WebWorker's.
interface ExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(response: Promise<Response> | Response): void }
interface WindowClient { id: string; postMessage(message: FromWorker): void }
interface MessageEvent_ extends ExtendableEvent { data: unknown; source: WindowClient | null }
interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(options: { type: "window" }): Promise<WindowClient[]> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent_) => void): void;
}
const worker = self as unknown as WorkerScope;

const CACHE = CACHE_PREFIX + __SW_BUILD__;
const PRECACHED = new Set(__SW_PRECACHE__);

worker.addEventListener("install", (event) => {
  // `reload`: past the browser's HTTP cache, so the shell is this deploy's and not an older copy.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(__SW_PRECACHE__.map((path) => new Request(path, { cache: "reload" })))));
});

worker.addEventListener("activate", (event) => {
  // Only ever active on a first install, after Reload (the page reloads at once), or with no tab open: taking
  // the open pages swaps nothing under anyone.
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
      const item = readShare(await event.request.formData());
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
    held = null;
    if (!taken) { source.postMessage({ type: "share-none" }); return; }
    event.waitUntil(worker.clients.matchAll({ type: "window" }).then((all) => {
      for (const client of all) if (client.id !== source.id) client.postMessage({ type: "share", item: taken.item });
    }).finally(taken.done));
  }
});

// ---------- fetch ----------

worker.addEventListener("fetch", (event) => {
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
