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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Runs the worker's script in a scope of the given address and installs it, in a browser of these languages with the
 * caches of earlier builds (name → paths): the requests its precache made.
 */
async function install(scope: string, languages: string[] = ["en-US"], older: Record<string, string[]> = {}): Promise<{ url: string; cache: string }[] | null> {
  const listeners = new Map<string, (event: { waitUntil(promise: Promise<unknown>): void }) => void>();
  let asked: { url: string; cache: string }[] | null = null;
  vi.resetModules();
  vi.stubGlobal("__SW_BUILD__", "test-1");
  vi.stubGlobal("__SW_PRECACHE__", PRECACHE);
  vi.stubGlobal("__SW_LANGUAGES__", LANGUAGES);
  vi.stubGlobal("navigator", { languages, language: languages[0] ?? "" });
  vi.stubGlobal("Request", class { url: string; cache: string; constructor(url: string, init?: { cache?: string }) { this.url = url; this.cache = init?.cache ?? "default"; } });
  vi.stubGlobal("caches", {
    keys: async () => ["ghostly-shell-test-1", ...Object.keys(older)],
    open: async (name: string) => ({
      keys: async () => (older[name] ?? []).map((path) => ({ url: "https://app.ghostly.tools" + path })),
      addAll: async (requests: { url: string; cache: string }[]) => { asked = requests.map(({ url, cache }) => ({ url, cache })); },
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

  it("nothing at all for a profile's push worker, which caches nothing", async () => {
    expect(await install("https://app.ghostly.tools/push/default/")).toBeNull();
  });
});
