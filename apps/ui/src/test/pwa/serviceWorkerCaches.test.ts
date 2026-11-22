import { afterEach, describe, expect, it, vi } from "vitest";

// covers: app.pwa.offline, app.pwa.update

/**
 * Two deploys' workers (apps/web/src/sw/sw.ts) on one registration, against a cache storage that behaves as the
 * Service Workers spec says: `caches.delete(name)` takes the name away, and a cache already opened under it stays
 * writable but is reachable by no one any more. B's worker waits (its "New version" banner not pressed), C's is
 * found later, and B activates while C still installs: the last tab closed, or an older page's Reload told B to
 * skip waiting. C must still open the app offline once it takes over.
 */
const ORIGIN = "https://app.ghostly.tools";

/** What a cache holds: which build answered for which path. */
type Stored = { build: string; path: string };

const pathOf = (request: string | { url: string }) => {
  const url = typeof request === "string" ? request : request.url;
  return url.startsWith("http") ? new URL(url).pathname : url;
};

class MemoryCache {
  readonly entries = new Map<string, Stored>();
  constructor(private readonly serve: (path: string) => Promise<Stored>) {}
  async match(request: string | { url: string }) { return this.entries.get(pathOf(request)); }
  async put(request: string | { url: string }, response: Stored) { this.entries.set(pathOf(request), response); }
  // All fetched first, then all stored: the spec's addAll.
  async addAll(requests: { url: string }[]) {
    const answers = await Promise.all(requests.map((request) => this.serve(pathOf(request))));
    requests.forEach((request, at) => this.entries.set(pathOf(request), answers[at]!));
  }
  async keys() { return [...this.entries.keys()].map((path) => ({ url: ORIGIN + path })); }
}

class MemoryCacheStorage {
  readonly byName = new Map<string, MemoryCache>();
  constructor(private readonly serve: (path: string) => Promise<Stored>) {}
  async keys() { return [...this.byName.keys()]; }
  async open(name: string) {
    let cache = this.byName.get(name);
    if (!cache) { cache = new MemoryCache(this.serve); this.byName.set(name, cache); }
    return cache;
  }
  async delete(name: string) { return this.byName.delete(name); }
  async match(request: string | { url: string }, options?: { cacheName?: string }) {
    if (options?.cacheName) return this.byName.get(options.cacheName)?.match(request);
    for (const cache of this.byName.values()) { const found = await cache.match(request); if (found) return found; }
    return undefined;
  }
}

type Listener = (event: Record<string, unknown>) => void;

describe("an older version's worker that activates while a newer one installs", () => {
  /** The deploy the server has now; each install asks it for its files. */
  let serving: string;
  /** Holds every answer of the server until released: C's install still filling its cache. */
  let held: { release: () => void; wait: Promise<void> } | null = null;
  let storage: MemoryCacheStorage;
  /** The one registration both workers belong to: what each sees as `self.registration`. */
  let registration: { scope: string; installing: object | null; waiting: object | null };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    held = null;
  });

  function setUp() {
    serving = "B";
    storage = new MemoryCacheStorage(async (path) => {
      const build = serving;
      if (held) await held.wait;
      return { build, path };
    });
    registration = { scope: `${ORIGIN}/`, installing: null, waiting: null };
    vi.stubGlobal("caches", storage);
    vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });
    vi.stubGlobal("Request", class { url: string; constructor(url: string) { this.url = url; } });
    // Offline: whatever the worker does not answer from its cache fails.
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
  }

  /** Starts one build's worker script: its event listeners. */
  async function startWorker(build: string): Promise<Map<string, Listener>> {
    const listeners = new Map<string, Listener>();
    vi.resetModules();
    vi.stubGlobal("__SW_BUILD__", build);
    vi.stubGlobal("__SW_PRECACHE__", ["/", `/assets/main-${build}.js`, "/manifest.json"]);
    vi.stubGlobal("__SW_LANGUAGES__", {});
    vi.stubGlobal("__SW_LAZY__", []);
    vi.stubGlobal("self", {
      location: new URL(`${ORIGIN}/sw.js`),
      registration,
      clients: { claim: async () => {}, matchAll: async () => [] },
      skipWaiting: async () => {},
      addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
    });
    await import("../../../../web/src/sw/sw");
    return listeners;
  }

  /** Fires an install or activate event: what it waited for. */
  function fire(listeners: Map<string, Listener>, type: "install" | "activate"): Promise<unknown> {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } });
    return Promise.all(waits);
  }

  /** The app's page asked of a worker (a navigation): what it answered with. */
  function open(listeners: Map<string, Listener>): Promise<Stored> {
    let answer: Promise<Stored> | undefined;
    listeners.get("fetch")!({
      request: { method: "GET", url: `${ORIGIN}/`, mode: "navigate", headers: new Headers() },
      respondWith: (response: Promise<Stored>) => { answer = response; },
      waitUntil: () => {},
    });
    return answer!;
  }

  /** B installed and waiting; C found and installing, its server answers held: both workers' listeners. */
  async function newerInstalling() {
    setUp();
    const b = await startWorker("B");
    await fire(b, "install");
    registration.waiting = { build: "B" };
    serving = "C";
    let release = () => {};
    held = { release: () => release(), wait: new Promise<void>((resolve) => { release = resolve; }) };
    const c = await startWorker("C");
    registration.installing = { build: "C" };
    const cInstalled = fire(c, "install");
    await vi.waitFor(() => expect(storage.byName.has("ghostly-shell-C")).toBe(true));
    return { b, c, cInstalled };
  }

  it("keeps the newer one's cache, so once that one takes over the app opens offline", async () => {
    const { b, c, cInstalled } = await newerInstalling();
    // B activates (the last tab closed, or an older page's Reload) while C still fills its cache.
    registration.waiting = null;
    await fire(b, "activate");
    held!.release();
    await cInstalled;
    registration.installing = null;
    registration.waiting = { build: "C" };
    // Later C takes over (its own Reload, or no tab left).
    registration.waiting = null;
    await fire(c, "activate");

    await expect(open(c)).resolves.toEqual({ build: "C", path: "/" });
    expect(await storage.keys()).toEqual(["ghostly-shell-C"]);
  });

  it("the same when the newer one finished installing and waits by the time the older one's activation looks", async () => {
    const { b, c, cInstalled } = await newerInstalling();
    held!.release();
    await cInstalled;
    registration.installing = null;
    registration.waiting = { build: "C" };
    await fire(b, "activate");
    registration.waiting = null;
    await fire(c, "activate");

    await expect(open(c)).resolves.toEqual({ build: "C", path: "/" });
    expect(await storage.keys()).toEqual(["ghostly-shell-C"]);
  });

  it("the older one still opens offline meanwhile, from its own cache", async () => {
    const { b } = await newerInstalling();
    registration.waiting = null;
    await fire(b, "activate");
    await expect(open(b)).resolves.toEqual({ build: "B", path: "/" });
  });

  it("a newer one whose install failed: the older one's activation deletes the half-filled cache with the rest", async () => {
    const { b, cInstalled } = await newerInstalling();
    // C went redundant (a precache file missing): the registration has no installing worker any more.
    registration.installing = null;
    registration.waiting = null;
    held!.release();
    await cInstalled;
    await fire(b, "activate");
    expect(await storage.keys()).toEqual(["ghostly-shell-B"]);
  });

  it("with no newer worker, an activation deletes every other build's cache, as before", async () => {
    setUp();
    serving = "A";
    const a = await startWorker("A");
    await fire(a, "install");
    serving = "B";
    const b = await startWorker("B");
    await fire(b, "install");
    await fire(b, "activate");
    expect(await storage.keys()).toEqual(["ghostly-shell-B"]);
    await expect(open(b)).resolves.toEqual({ build: "B", path: "/" });
  });
});
