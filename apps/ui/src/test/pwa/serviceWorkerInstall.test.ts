import { afterEach, describe, expect, it, vi } from "vitest";

// covers: app.pwa.offline

/**
 * What the web app's service worker (apps/web/src/sw/sw.ts) asks the server for when it installs. The worker's own
 * script runs here against a stand-in for its scope: the files it precaches are the build's, and the ones under
 * `/assets/` have a digest of their content in their names, which the server calls immutable (apps/web/nginx.conf).
 * The page has just loaded most of them, and a deploy changes few, so those come from the browser's HTTP cache;
 * only the page and the files beside it, whose names stay, are asked past it.
 */
const PRECACHE = ["/", "/assets/main-abc.css", "/assets/main-abc.js", "/assets/pt-def.js", "/assets/ring-ghi.mp3", "/boot-guard.js", "/icon-192.png", "/manifest.json"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Runs the worker's script in a scope of the given address and installs it: the requests its precache made. */
async function install(scope: string): Promise<{ url: string; cache: string }[] | null> {
  const listeners = new Map<string, (event: { waitUntil(promise: Promise<unknown>): void }) => void>();
  let asked: { url: string; cache: string }[] | null = null;
  vi.stubGlobal("__SW_BUILD__", "test-1");
  vi.stubGlobal("__SW_PRECACHE__", PRECACHE);
  vi.stubGlobal("Request", class { url: string; cache: string; constructor(url: string, init?: { cache?: string }) { this.url = url; this.cache = init?.cache ?? "default"; } });
  vi.stubGlobal("caches", { open: async () => ({ addAll: async (requests: { url: string; cache: string }[]) => { asked = requests.map(({ url, cache }) => ({ url, cache })); } }) });
  vi.stubGlobal("self", {
    location: new URL("https://app.ghostly.tools/sw.js"),
    registration: { scope },
    addEventListener: (type: string, listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void) => { listeners.set(type, listener); },
  });
  await import("../../../../web/src/sw/sw");
  const waits: Promise<unknown>[] = [];
  listeners.get("install")!({ waitUntil: (promise) => { waits.push(promise); } });
  await Promise.all(waits);
  return asked;
}

describe("what the worker's install asks the server for", () => {
  it("every precached file once, the hashed ones from the browser's HTTP cache when it has them", async () => {
    const asked = (await install("https://app.ghostly.tools/"))!;
    expect(asked.map((request) => request.url)).toEqual(PRECACHE);
    const pastTheCache = asked.filter((request) => request.cache === "reload").map((request) => request.url);
    // The names that stay from one deploy to the next: always the server's copy.
    expect(pastTheCache).toEqual(["/", "/boot-guard.js", "/icon-192.png", "/manifest.json"]);
    // The rest are named after their content: the copy the page loaded a moment ago is the file.
    expect(asked.filter((request) => request.url.startsWith("/assets/")).map((request) => request.cache)).toEqual(["default", "default", "default", "default"]);
  });

  it("nothing at all for a profile's push worker, which caches nothing", async () => {
    expect(await install("https://app.ghostly.tools/push/default/")).toBeNull();
  });
});
