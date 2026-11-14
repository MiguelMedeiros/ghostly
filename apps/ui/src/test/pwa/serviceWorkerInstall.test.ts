import { afterEach, describe, expect, it, vi } from "vitest";

// covers: app.pwa.offline

/**
 * What the web app's service worker (apps/web/src/sw/sw.ts) asks the server for when it installs. The worker's own
 * script runs here against a stand-in for its scope: the files it precaches are the build's, and the ones under
 * `/assets/` have a digest of their content in their names, which the server calls immutable (apps/web/nginx.conf).
 * The page has just loaded most of them, and a deploy changes few, so those come from the browser's HTTP cache;
 * only the page and the files beside it, whose names stay, are asked past it.
 */
const PRECACHE = ["/", "/assets/main-abc.css", "/assets/main-abc.js", "/assets/ring-ghi.mp3", "/boot-guard.js", "/icon-192.png", "/manifest.json"];
/** The languages but English, which the entry carries: not precached, the install takes the person's own. */
const LANGUAGES = { fr: ["/assets/fr-def.js"], pt: ["/assets/pt-def.js"] };
/** The build's hashed files kept on their first use, not precached: a wallet's WebAssembly. */
const LAZY = ["/assets/wallet-jkl.wasm"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  unanswered = new Set();
});

/** What one install did: the requests its precache made, and what it put in its cache from the earlier builds' caches. */
let put: { path: string; from: string }[] = [];
/** Paths an older cache lists but no longer answers for (deleted meanwhile, by another tab's worker). */
let unanswered = new Set<string>();

/**
 * Runs the worker's script in a scope of the given address and installs it, in a browser of these languages with the
 * caches of earlier builds (name → paths): the requests its precache made.
 */
async function install(scope: string, languages: string[] = ["en-US"], older: Record<string, string[]> = {}): Promise<{ url: string; cache: string }[] | null> {
  const listeners = new Map<string, (event: { waitUntil(promise: Promise<unknown>): void }) => void>();
  let asked: { url: string; cache: string }[] | null = null;
  put = [];
  vi.resetModules();
  vi.stubGlobal("__SW_BUILD__", "test-1");
  vi.stubGlobal("__SW_PRECACHE__", PRECACHE);
  vi.stubGlobal("__SW_LANGUAGES__", LANGUAGES);
  vi.stubGlobal("__SW_LAZY__", LAZY);
  vi.stubGlobal("navigator", { languages, language: languages[0] ?? "" });
  vi.stubGlobal("Request", class { url: string; cache: string; constructor(url: string, init?: { cache?: string }) { this.url = url; this.cache = init?.cache ?? "default"; } });
  vi.stubGlobal("caches", {
    keys: async () => ["ghostly-shell-test-1", ...Object.keys(older)],
    match: async (path: string, options?: { cacheName?: string }) => {
      const found = Object.entries(older).find(([name, paths]) => (!options?.cacheName || options.cacheName === name) && paths.includes(path));
      return found && !unanswered.has(path) ? { from: found[0] } : undefined;
    },
    open: async (name: string) => ({
      keys: async () => (older[name] ?? []).map((path) => ({ url: "https://app.ghostly.tools" + path })),
      addAll: async (requests: { url: string; cache: string }[]) => { asked = requests.map(({ url, cache }) => ({ url, cache })); },
      put: async (path: string, response: { from: string }) => { put.push({ path, from: response.from }); },
    }),
  });
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
    expect(asked.filter((request) => request.url.startsWith("/assets/")).map((request) => request.cache)).toEqual(["default", "default", "default"]);
  });

  it("the browser's language, if the app has one of its own for it, and none of the others", async () => {
    expect((await install("https://app.ghostly.tools/", ["pt-BR", "fr"]))!.map((request) => request.url)).toEqual([...PRECACHE, "/assets/pt-def.js"]);
    expect((await install("https://app.ghostly.tools/", ["fr-FR"]))!.find((request) => request.url === "/assets/fr-def.js")?.cache).toBe("default");
  });

  it("after a deploy, the language the previous build's page read in too", async () => {
    const asked = await install("https://app.ghostly.tools/", ["en-US"], { "ghostly-shell-test-0": ["/", "/assets/main-old.js", "/assets/fr-old.js"] });
    expect(asked!.map((request) => request.url)).toEqual([...PRECACHE, "/assets/fr-def.js"]);
  });

  it("after a deploy, a hashed file the previous build's cache holds is taken from there, not downloaded again", async () => {
    // The browser's HTTP cache may have let these go (the worker answered from its own cache since, and a person may
    // clear it): the previous build's cache holds the same files, named after their content.
    const asked = await install("https://app.ghostly.tools/", ["en-US"], {
      "ghostly-shell-test-0": ["/", "/assets/main-abc.js", "/assets/ring-ghi.mp3", "/assets/main-old.css", "/manifest.json", "/icon-192.png"],
    });
    expect(put).toEqual([{ path: "/assets/main-abc.js", from: "ghostly-shell-test-0" }, { path: "/assets/ring-ghi.mp3", from: "ghostly-shell-test-0" }]);
    // The rest from the server: a file of a new name, and those whose names stay from one deploy to the next.
    expect(asked!.map((request) => request.url)).toEqual(["/", "/assets/main-abc.css", "/boot-guard.js", "/icon-192.png", "/manifest.json"]);
  });

  it("and a file kept on its first use that this build has too (a wallet's WebAssembly), never one it no longer has", async () => {
    const asked = await install("https://app.ghostly.tools/", ["en-US"], {
      "ghostly-shell-test-0": ["/", "/assets/wallet-jkl.wasm", "/assets/wallet-old.wasm"],
    });
    expect(put).toEqual([{ path: "/assets/wallet-jkl.wasm", from: "ghostly-shell-test-0" }]);
    // Kept on its first use: never fetched by the install.
    expect(asked!.map((request) => request.url)).toEqual(PRECACHE);
  });

  it("a file the older cache listed but no longer answers for is downloaded as any other", async () => {
    unanswered = new Set(["/assets/main-abc.js"]);
    const asked = await install("https://app.ghostly.tools/", ["en-US"], { "ghostly-shell-test-0": ["/assets/main-abc.js", "/assets/ring-ghi.mp3"] });
    expect(put.map(({ path }) => path)).toEqual(["/assets/ring-ghi.mp3"]);
    expect(asked!.map((request) => request.url)).toEqual(PRECACHE.filter((path) => path !== "/assets/ring-ghi.mp3"));
  });

  it("nothing at all for a profile's push worker, which caches nothing", async () => {
    expect(await install("https://app.ghostly.tools/push/default/")).toBeNull();
  });
});
