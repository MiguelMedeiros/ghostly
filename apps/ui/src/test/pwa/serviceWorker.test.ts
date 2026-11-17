import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { MAX_PAST_LIMIT_NAMES, MAX_SHARED_FILES, MAX_SHARE_BYTES, SHARE_TARGET_PATH, assetAnswer, classify, desktopOnlyFiles, installList, optionalFiles, precacheList, pushNotice, serviceWorkerFiles, pushScope, pushScopeProfile, readShare, readShareBody, wakeNotice, DEVICE_NOTICE_DEFAULTS, type NoticeDevice } from "../../../../web/src/sw/policy";
import { SHARE_LOCK_LOOK_MS, type FromWorker } from "../../../../web/src/sw/messages";
import { deviceNoticeWords } from "../../../../web/src/sw/deviceWords";

// covers: app.pwa.offline, app.pwa.share-target, push.wake.notify, push.wake.mute, push.wake.group, push.wake.online
// covers: apps.web-sandbox
// covers: app.pwa.offline
describe("the worker's policy", () => {
  /**
   * What the web app's service worker answers, and what it keeps: the build's own files only. These are the rules
   * `apps/web/src/sw/sw.ts` follows; e2e/web/pwa.spec.ts checks the worker itself.
   */
  const ORIGIN = "https://app.ghostly.tools";
  const PRECACHED = new Set(["/", "/assets/main-abc.js", "/assets/main-abc.css", "/manifest.json", "/icon-192.png"]);
  const route = (url: string, init: { method?: string; mode?: string; range?: boolean } = {}) =>
    classify({ method: init.method ?? "GET", url: url.startsWith("http") ? url : ORIGIN + url, mode: init.mode, range: init.range }, ORIGIN, PRECACHED);

  describe("what the worker answers from its cache", () => {
    it("the app's page, for every screen: the router is in the fragment, which the cache never keys on", () => {
      expect(route("/", { mode: "navigate" })).toBe("shell");
      expect(route("/index.html", { mode: "navigate" })).toBe("shell");
      // An invite link: the keys stay in the fragment; the page answered is the one shell, stored under "/".
      expect(route("/#ghostly1pqqqq", { mode: "navigate" })).toBe("shell");
      expect(route("/#/chat/abc", { mode: "navigate" })).toBe("shell");
    });

    it("the precached files, and the build's other hashed files once fetched", () => {
      expect(route("/assets/main-abc.js")).toBe("precache");
      expect(route("/manifest.json")).toBe("precache");
      expect(route("/assets/bark_ffi_wasm_bg-xyz.wasm")).toBe("asset");
      // A source map is the devtools', never the app's: not kept, and its 404 after a deploy is not the build gone.
      expect(route("/assets/main-abc.js.map")).toBe("pass");
    });
  });

  describe("what goes to the network untouched, and is never stored", () => {
    it.each([
      ["the update check", "/version.json"],
      ["the sign-in callback", "/oidc-callback.html?code=secret&state=x"],
      ["the worker's own script", "/sw.js"],
      ["a file with a query", "/assets/main-abc.js?v=2"],
      ["a path that is not the build's", "/api/anything"],
      ["a path climbing out of /assets", "/assets/../secret"],
    ])("%s (%s)", (_what, path) => {
      expect(route(path)).toBe("pass");
    });

    it("any other origin: Pkarr relays, the DHT relay, mints, wallets, GIFs, providers", () => {
      for (const url of ["https://relay.pkarr.org/abcd", "https://dht.iroh.link/x", "https://testnut.cashu.space/v1/keys", "https://mempool.space/api/tx", "https://media.giphy.com/a.gif", `${ORIGIN}.evil.example/`]) {
        expect(route(url)).toBe("pass");
        expect(route(url, { mode: "navigate" })).toBe("pass");
      }
    });

    it("pages that are not the app, even on its origin", () => {
      expect(route("/oidc-callback.html", { mode: "navigate" })).toBe("pass");
      expect(route("/?code=abc", { mode: "navigate" })).toBe("pass");
      expect(route("/voice-gallery.html", { mode: "navigate" })).toBe("pass");
    });

    it("the mini-app runner, always from the server with its sandbox header, even when a build put it in the cache", () => {
      const runners = ["/app-frame.html", "/app-frame-net.html", "/app-frame-unguarded.html"];
      const precached = new Set([...PRECACHED, ...runners]);
      for (const runner of runners) for (const mode of [undefined, "navigate"]) expect(classify({ method: "GET", url: ORIGIN + runner, mode }, ORIGIN, precached), runner).toBe("pass");
      expect(precacheList(["index.html", ...runners.map((r) => r.slice(1)), "assets/main-abc.js"])).toEqual(["/", "/assets/main-abc.js"]);
    });

    it("anything but GET, except the share target's POST", () => {
      expect(route(SHARE_TARGET_PATH, { method: "POST" })).toBe("share");
      expect(route("/", { method: "POST" })).toBe("pass");
      expect(route("/assets/main-abc.js", { method: "PUT" })).toBe("pass");
      expect(route(SHARE_TARGET_PATH)).toBe("pass");
    });

    it("a request for part of a file (a media element): the server answers 206", () => {
      expect(route("/assets/ring-abc.mp3", { range: true })).toBe("pass");
    });

    it("an unreadable address", () => {
      expect(classify({ method: "GET", url: "not a url" }, ORIGIN, PRECACHED)).toBe("pass");
    });
  });

  describe("what the build precaches", () => {
    it("the page and the build's files, without the wasm, the update check, the callback or the worker", () => {
      const files = ["index.html", "version.json", "oidc-callback.html", "sw.js", "manifest.json", "icon-192.png",
        "assets/main-abc.js", "assets/main-abc.css", "assets/fedimint_bg-1.wasm", "assets/main-abc.js.map", "assets/main-abc.js"];
      expect(precacheList(files)).toEqual(["/", "/assets/main-abc.css", "/assets/main-abc.js", "/icon-192.png", "/manifest.json"]);
    });

    it("not the language detector, which only Desktop's translation loads: a chunk made of nothing else", () => {
      const root = "/home/me/ghostly/node_modules";
      const chunk = (fileName: string, ...moduleIds: string[]) => ({ type: "chunk", fileName, moduleIds });
      const bundle = [
        chunk("assets/main-abc.js", "/home/me/ghostly/apps/ui/src/main.tsx", `${root}/react/index.js`),
        chunk("assets/langdetect-text-abc.js", `${root}/tinyld/dist/tinyld.heavy.node.js`, `${root}/@qvac/langdetect-text/index.js`),
        chunk("assets/windows-abc.js", "C:\\ghostly\\node_modules\\@qvac\\langdetect-text\\index.js"),
        // The app's own code bundled with it, or a package that only starts with the same name: kept.
        chunk("assets/translate-abc.js", `${root}/@qvac/langdetect-text/index.js`, "/home/me/ghostly/apps/ui/src/lib/translateDetector.ts"),
        chunk("assets/other-abc.js", `${root}/tinyld-other/index.js`),
        chunk("assets/pubky-abc.js", `${root}/@synonymdev/pubky/index.js`),
        { type: "asset", fileName: "assets/main-abc.css" },
      ];
      const leaveOut = desktopOnlyFiles(bundle);
      expect(leaveOut).toEqual(["assets/langdetect-text-abc.js", "assets/windows-abc.js"]);
      expect(precacheList(["index.html", ...bundle.map((file) => file.fileName)], leaveOut))
        .toEqual(["/", "/assets/main-abc.css", "/assets/main-abc.js", "/assets/other-abc.js", "/assets/pubky-abc.js", "/assets/translate-abc.js"]);
    });

    // What a build of the web app is made of, in the shape Rollup hands the plugin: the online-only flows and the languages
    // are dynamic imports, each a chunk (or two) of its own.
    const app = "/home/me/ghostly/apps/ui/src";
    const lib = "/home/me/ghostly/node_modules";
    const adapters = "/home/me/ghostly/packages/browser/src/engine/paymentAdapters";
    const chunk = (fileName: string, facade: string | null, imports: string[] = [], dynamicImports: string[] = [], isEntry = false) =>
      ({ type: "chunk", fileName, facadeModuleId: facade, moduleIds: facade ? [facade] : [], imports, dynamicImports, isEntry });
    const BUNDLE = [
      chunk("assets/index-abc.js", `${app}/main.tsx`, ["assets/vendor-abc.js"],
        ["assets/Wallet-abc.js", "assets/Chat-abc.js", "assets/pubky-abc.js", "assets/handoff-abc.js", "assets/keet-identity-key-abc.js", "assets/fr-abc.js", "assets/ja-abc.js"], true),
      chunk("assets/vendor-abc.js", null),
      chunk("assets/Chat-abc.js", `${app}/pages/Chat.tsx`, ["assets/vendor-abc.js"], ["assets/sodium-abc.js"]),
      chunk("assets/Wallet-abc.js", `${app}/pages/Wallet.tsx`, ["assets/cashu-ts-abc.js"], ["assets/usdt-abc.js", "assets/arkade-abc.js", "assets/dist-abc.js"]),
      chunk("assets/cashu-ts-abc.js", `${lib}/@cashu/cashu-ts/lib/index.js`),
      chunk("assets/usdt-abc.js", `${adapters}/usdt.ts`, ["assets/ethers-abc.js", "assets/vendor-abc.js"]),
      chunk("assets/ethers-abc.js", null),
      chunk("assets/arkade-abc.js", `${adapters}/arkade.ts`, ["assets/dist-abc.js"]),
      chunk("assets/dist-abc.js", `${lib}/@arkade-os/sdk/dist/esm/index.js`, ["assets/zod-abc.js"]),
      chunk("assets/zod-abc.js", null),
      chunk("assets/pubky-abc.js", `${lib}/@synonymdev/pubky/index.js`),
      chunk("assets/handoff-abc.js", `${app}/components/DeviceHandoff.tsx`, ["assets/vendor-abc.js"], ["assets/esm-abc.js"]),
      chunk("assets/esm-abc.js", `${lib}/@serenity-kit/opaque/esm/index.js`),
      chunk("assets/keet-identity-key-abc.js", `${lib}/keet-identity-key/index.js`, ["assets/sodium-abc.js"]),
      // The sodium build Keet's key needs, which the chat also loads: kept, since the chat is needed offline.
      chunk("assets/sodium-abc.js", null),
      chunk("assets/fr-abc.js", `${app}/locales/fr/index.ts`),
      chunk("assets/ja-abc.js", `${app}/locales/ja/index.ts`),
      { type: "asset", fileName: "assets/index-abc.css" },
    ];

    it("not what only an online flow loads (Pubky, a Keet proof, a device handoff, the USDT and Ark wallets), nor the languages", () => {
      const { precache, languages } = serviceWorkerFiles(["manifest.json", "version.json"], BUNDLE);
      expect(precache).toEqual(["/", "/assets/cashu-ts-abc.js", "/assets/Chat-abc.js", "/assets/handoff-abc.js", "/assets/index-abc.css", "/assets/index-abc.js",
        "/assets/sodium-abc.js", "/assets/vendor-abc.js", "/assets/Wallet-abc.js", "/manifest.json"]);
      expect(languages).toEqual({ fr: ["/assets/fr-abc.js"], ja: ["/assets/ja-abc.js"] });
    });

    it("names the build's other hashed files, kept on their first use: an older cache that holds one passes it on at a deploy", () => {
      const bundle = [...BUNDLE, { type: "asset", fileName: "assets/wallet-abc.wasm" }, { type: "asset", fileName: "assets/index-abc.js.map" }];
      expect(serviceWorkerFiles(["manifest.json", "version.json"], bundle).lazy).toEqual(["/assets/arkade-abc.js", "/assets/dist-abc.js", "/assets/esm-abc.js",
        "/assets/ethers-abc.js", "/assets/keet-identity-key-abc.js", "/assets/pubky-abc.js", "/assets/usdt-abc.js", "/assets/wallet-abc.wasm", "/assets/zod-abc.js"]);
    });

    /**
     * Vite's own `generateBundle` deletes an entry chunk that is nothing but imports and names those in index.html. Read
     * after that, the walk had no entry to start from: every chunk the app loads counted as online-only, and the worker
     * precached none of them (the installed app no longer opened offline). Read before, with the names the build writes.
     */
    it("an entry chunk the build does not write is left out, and what it loads is still precached", () => {
      const written = BUNDLE.map((file) => file.fileName).filter((name) => name !== "assets/index-abc.js");
      const { precache, languages, lazy } = serviceWorkerFiles(["manifest.json", "version.json"], BUNDLE, written);
      expect(precache).toEqual(["/", "/assets/cashu-ts-abc.js", "/assets/Chat-abc.js", "/assets/handoff-abc.js", "/assets/index-abc.css",
        "/assets/sodium-abc.js", "/assets/vendor-abc.js", "/assets/Wallet-abc.js", "/manifest.json"]);
      expect(languages).toEqual({ fr: ["/assets/fr-abc.js"], ja: ["/assets/ja-abc.js"] });
      expect(lazy).not.toContain("/assets/index-abc.js");
      expect(lazy).not.toContain("/assets/vendor-abc.js");
    });

    it("an online-only module another screen imports as it loads stays: the path to it is not the online flow's", () => {
      const bundle = BUNDLE.map((file) => file.fileName === "assets/Chat-abc.js" ? { ...file, imports: ["assets/vendor-abc.js", "assets/pubky-abc.js"] } : file);
      expect(optionalFiles(bundle).onlineOnly).not.toContain("assets/pubky-abc.js");
      expect(serviceWorkerFiles([], bundle).precache).toContain("/assets/pubky-abc.js");
    });

    it("starts where the app's page does: Vite drops an entry that is nothing but imports and names its `main` chunk in index.html", () => {
      // As the plugin reads it after `vite:build-html`: no entry chunk for the app, only the sign-in page's.
      const bundle = [
        ...BUNDLE.filter((file) => file.fileName !== "assets/index-abc.js"),
        chunk("assets/main-abc.js", null, ["assets/vendor-abc.js"],
          ["assets/Wallet-abc.js", "assets/Chat-abc.js", "assets/pubky-abc.js", "assets/handoff-abc.js", "assets/keet-identity-key-abc.js", "assets/fr-abc.js", "assets/ja-abc.js"]),
        chunk("assets/rolldown-runtime-abc.js", null),
        chunk("assets/oidcCallback-abc.js", "/home/me/ghostly/apps/web/oidc-callback.html", [], [], true),
        { type: "asset", fileName: "index.html", source: `<script type="module" crossorigin src="/assets/main-abc.js"></script>\n<link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-abc.js">` },
      ];
      const { precache, languages } = serviceWorkerFiles(["manifest.json"], bundle);
      expect(precache).toEqual(["/", "/assets/cashu-ts-abc.js", "/assets/Chat-abc.js", "/assets/handoff-abc.js", "/assets/index-abc.css", "/assets/main-abc.js",
        "/assets/oidcCallback-abc.js", "/assets/rolldown-runtime-abc.js", "/assets/sodium-abc.js", "/assets/vendor-abc.js", "/assets/Wallet-abc.js", "/manifest.json"]);
      expect(languages).toEqual({ fr: ["/assets/fr-abc.js"], ja: ["/assets/ja-abc.js"] });
    });

    const LANGUAGES = { fr: ["/assets/fr-abc.js"], ja: ["/assets/ja-abc.js", "/assets/ja-extra-abc.js"], pt: ["/assets/pt-abc.js"] };
    const PRECACHE = ["/", "/assets/index-abc.js"];

    it("the install takes the browser's language, the first of its languages the app speaks", () => {
      expect(installList(PRECACHE, LANGUAGES, ["ja-JP", "fr"])).toEqual([...PRECACHE, "/assets/ja-abc.js", "/assets/ja-extra-abc.js"]);
      expect(installList(PRECACHE, LANGUAGES, ["de-DE", "pt-BR"])).toEqual([...PRECACHE, "/assets/pt-abc.js"]);
      // English is in the entry: a browser in English, or in nothing the app speaks, takes no language file.
      expect(installList(PRECACHE, LANGUAGES, ["en-US", "fr"])).toEqual(PRECACHE);
      expect(installList(PRECACHE, LANGUAGES, ["de", "constructor"])).toEqual(PRECACHE);
      expect(installList(PRECACHE, LANGUAGES, [])).toEqual(PRECACHE);
    });

    it("and after a deploy, the languages a page fetched into the previous build's cache, whatever the browser's", () => {
      const held = ["/", "/assets/index-old.js", "/assets/fr-old.js"];
      expect(installList(PRECACHE, LANGUAGES, ["en-US"], held)).toEqual([...PRECACHE, "/assets/fr-abc.js"]);
    });

    it("a cache with every language (a build's that precached them all) gives every language: the person's may be any of them", () => {
      // An English browser, the app in Portuguese, updating from a build that precached every language: Portuguese is
      // in the new cache, so the first start after the update opens in it offline too.
      const everyLanguage = ["/", "/assets/index-old.js", "/assets/fr-old.js", "/assets/ja-old.js", "/assets/pt-old.js"];
      const every = [...PRECACHE, "/assets/fr-abc.js", "/assets/ja-abc.js", "/assets/ja-extra-abc.js", "/assets/pt-abc.js"];
      expect(installList(PRECACHE, LANGUAGES, ["en-US"], everyLanguage)).toEqual(every);
      expect(installList(PRECACHE, LANGUAGES, ["pt"], everyLanguage)).toEqual([...PRECACHE, "/assets/pt-abc.js", "/assets/fr-abc.js", "/assets/ja-abc.js", "/assets/ja-extra-abc.js"]);
    });
  });

  describe("a share target's form", () => {
    it("keeps the manifest's fields and the files, bounded", () => {
      const form = new FormData();
      form.set("title", "T");
      form.set("text", "x".repeat(70_000));
      form.set("url", "https://example.com");
      form.append("files", "not a file");
      for (let i = 0; i < MAX_SHARED_FILES + 3; i++) form.append("files", new File([String(i)], `f${i}.txt`));
      const item = readShare(form);
      expect(item.title).toBe("T");
      expect(item.text.length).toBe(70_000);
      expect(item.url).toBe("https://example.com");
      expect(item.files).toHaveLength(MAX_SHARED_FILES);
      expect(item.files[0]!.name).toBe("f0.txt");
    });

    it("keeps a text longer than 64 KiB whole, the character astride 64 KiB and all", () => {
      // The body is already bounded (`MAX_SHARE_BYTES`): a cut of its text would only lose the rest without a word.
      const text = `${"a".repeat(65_535)}👻${"b".repeat(40_000)}`;
      const form = new FormData();
      form.set("text", text);
      form.set("title", text);
      form.set("url", text);
      const item = readShare(form);
      // Lengths and ends, not the texts: a failure prints 100k characters otherwise.
      for (const field of [item.text, item.title, item.url]) expect([field.length, field.slice(65_533, 65_538), field === text]).toEqual([105_537, "aa👻b", true]);
    });

    it("names the files past the count cap, for the picker to say they did not come in", () => {
      const form = new FormData();
      for (let i = 1; i <= 40; i++) form.append("files", new File(["x"], `IMG_${i}.jpg`, { type: "image/jpeg" }));
      const item = readShare(form);
      expect(item.files).toHaveLength(MAX_SHARED_FILES);
      expect(item.pastLimit).toEqual(["IMG_33.jpg", "IMG_34.jpg", "IMG_35.jpg", "IMG_36.jpg", "IMG_37.jpg", "IMG_38.jpg", "IMG_39.jpg", "IMG_40.jpg"]);
    });

    it("keeps the names a website posts as a chat would show them, and only a few of those past the cap", async () => {
      // Any website can post here: names of any length, with invisible and direction marks, as many files as it likes.
      const form = new FormData();
      form.append("files", new File(["boo"], "a‮" + "x".repeat(8 * 1024 * 1024) + ".txt", { type: "text/plain", lastModified: 7 }));
      for (let i = 1; i < MAX_SHARED_FILES; i++) form.append("files", new File(["x"], `f${i}.txt`));
      for (let i = 0; i < 2000; i++) form.append("files", new File(["x"], "y".repeat(4096) + `\u200b${i}.jpg`));
      const item = readShare(form);
      const first = item.files[0]!;
      expect(first.name).toHaveLength(200);
      expect(first.name).toMatch(/^ax+$/);
      expect([first.type, first.lastModified, await first.text()]).toEqual(["text/plain", 7, "boo"]);
      expect(item.files[1]!.name).toBe("f1.txt");
      expect(item.pastLimit).toHaveLength(MAX_PAST_LIMIT_NAMES + 1);
      expect(item.pastLimit!.slice(0, -1).every((name) => name.length <= 200 && !name.includes("​"))).toBe(true);
      expect(item.pastLimit![MAX_PAST_LIMIT_NAMES]).toBe(`+${2000 - MAX_PAST_LIMIT_NAMES}`);
    });

    it("an empty form is an empty share", () => {
      expect(readShare(new FormData())).toEqual({ title: "", text: "", url: "", files: [] });
    });

    it("keeps files up to the size cap, all together", () => {
      const form = new FormData();
      for (const name of ["a", "b", "c"]) form.append("files", new File(["x".repeat(40)], `${name}.txt`));
      expect(readShare(form, 100).files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    });
  });

  describe("a share target's body", () => {
    /** A POST body in pieces, counting how many pieces were read: past the cap nothing more is. */
    function posted(pieces: number, pieceBytes: number, contentLength?: string) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled === pieces) return controller.close();
          pulled++;
          controller.enqueue(new Uint8Array(pieceBytes));
        },
      }, { highWaterMark: 0 });
      const headers = new Headers(contentLength === undefined ? {} : { "content-length": contentLength });
      return { request: { body, headers }, pulled: () => pulled };
    }

    it("is read whole up to the cap", async () => {
      const { request } = posted(4, 25);
      expect((await readShareBody(request, 100))?.size).toBe(100);
    });

    it("is dropped, and read no further, once it passes the cap", async () => {
      const { request, pulled } = posted(1000, 25);
      expect(await readShareBody(request, 100)).toBeNull();
      expect(pulled()).toBe(5);
    });

    it("is not read at all when it says it is larger", async () => {
      const { request, pulled } = posted(1, 10, String(MAX_SHARE_BYTES + 1));
      expect(await readShareBody(request)).toBeNull();
      expect(pulled()).toBe(0);
    });

    it("goes back to the form the worker reads, files and all", async () => {
      const form = new FormData();
      form.set("text", "hello");
      form.append("files", new File(["boo"], "ghost.txt", { type: "text/plain" }));
      const sent = new Request("https://app.ghostly.tools/share-target", { method: "POST", body: form });
      const body = await readShareBody(sent);
      const item = readShare(await new Response(body, { headers: { "content-type": sent.headers.get("content-type")! } }).formData());
      expect(item.text).toBe("hello");
      expect(item.files.map((f) => f.name)).toEqual(["ghost.txt"]);
      expect(await item.files[0]!.text()).toBe("boo");
    });
  });

  describe("a profile's push worker", () => {
    it("has a scope of its own, which names the profile", () => {
      expect(pushScope("")).toBe("/push/default/");
      expect(pushScope("k3j9x2m1qa")).toBe("/push/k3j9x2m1qa/");
      expect(pushScopeProfile("https://app.ghostly.tools/push/default/")).toBe("");
      expect(pushScopeProfile("https://app.ghostly.tools/push/k3j9x2m1qa/")).toBe("k3j9x2m1qa");
      // The app's own worker is none.
      expect(pushScopeProfile("https://app.ghostly.tools/")).toBeNull();
      expect(pushScopeProfile("https://app.ghostly.tools/push/")).toBeNull();
    });
  });

  describe("what a wake-up shows", () => {
    const text = { title: "Ghostly", body: "New message" };
    const now = 1_800_000_000_000;
    const show = (entry: { path: string; mutedUntil?: number | "forever" } | undefined, appVisible = false) =>
      wakeNotice(entry && { entry, text }, { now, appVisible, profile: "" });

    it("\"New message\" for a chat it knows, and the chat to open; nothing of the message", () => {
      expect(show({ path: "/chat/abc" })).toEqual({ title: "Ghostly", body: "New message", tag: "wake::/chat/abc", call: false, data: { path: "/chat/abc", profile: "" } });
    });

    it("\"Incoming call\" for a call, in the app's words, under a tag of its own", () => {
      const call = (callText?: string) => wakeNotice({ entry: { path: "/chat/abc" }, text: { ...text, ...(callText && { call: callText }) } }, { now, appVisible: false, profile: "", kind: "call" });
      expect(call("Chamada recebida")).toMatchObject({ body: "Chamada recebida", tag: "wake-call::/chat/abc", call: true, data: { path: "/chat/abc" } });
      expect(call()).toMatchObject({ body: "Incoming call" });
      // A muted chat's call wake-up shows nothing either (its contact was told not to send one).
      expect(wakeNotice({ entry: { path: "/chat/abc", mutedUntil: "forever" }, text }, { now, appVisible: false, profile: "", kind: "call" })).toBeNull();
    });

    it("nothing for a muted chat, until its mute ends", () => {
      expect(show({ path: "/chat/abc", mutedUntil: "forever" })).toBeNull();
      expect(show({ path: "/chat/abc", mutedUntil: now + 1000 })).toBeNull();
      expect(show({ path: "/chat/abc", mutedUntil: now - 1000 })).not.toBeNull();
    });

    it("a group mention: \"New message\" opening the group, one notice per group, never a call, nothing while muted", () => {
      expect(show({ path: "/group/g1" })).toEqual({ title: "Ghostly", body: "New message", tag: "wake::/group/g1", call: false, data: { path: "/group/g1", profile: "" } });
      // A member cannot ring anyone through a group: a call wake-up on a group's token is a message one.
      expect(wakeNotice({ entry: { path: "/group/g1" }, text: { ...text, call: "Incoming call" } }, { now, appVisible: false, profile: "", kind: "call" }))
        .toMatchObject({ body: "New message", tag: "wake::/group/g1", call: false });
      expect(show({ path: "/group/g1", mutedUntil: "forever" })).toBeNull();
      expect(show({ path: "/group/g1", mutedUntil: now + 1000 })).toBeNull();
    });

    it("an online notice names the contact only when the table knows the name, under a tag of its own; never for a group or a muted chat", () => {
      const words = { ...text, online: "{name} está online", onlineUnnamed: "Um contato está online" };
      const online = (entry: { path: string; name?: string; mutedUntil?: number | "forever" }, appVisible = false, t: typeof text = words) =>
        wakeNotice({ entry, text: t }, { now, appVisible, profile: "", kind: "online" });
      expect(online({ path: "/chat/abc", name: "Ana" })).toEqual({ title: "Ghostly", body: "Ana está online", tag: "wake-online::/chat/abc", call: false, data: { path: "/chat/abc", profile: "" } });
      expect(online({ path: "/chat/abc" })).toMatchObject({ body: "Um contato está online" });
      // No words from a page yet: English, still naming nobody it does not know.
      expect(online({ path: "/chat/abc" }, false, text)).toMatchObject({ body: "A contact is online" });
      expect(online({ path: "/chat/abc", name: "Ana" }, false, text)).toMatchObject({ body: "Ana is online" });
      expect(online({ path: "/chat/abc", name: "Ana" }, true)).toBeNull();
      expect(online({ path: "/chat/abc", name: "Ana", mutedUntil: "forever" })).toBeNull();
      expect(online({ path: "/group/g1", name: "Team" })).toBeNull();
    });

    it("with \"Notify me when a contact comes online\" off here, an online push has no notice of its own, whatever a contact still sends; messages and calls show as before", () => {
      const off = { ...text, online: "{name} is online", onlineUnnamed: "A contact is online", call: "Incoming call", onlineOff: true as const };
      const kinds = (t: typeof off | typeof text, kind: "message" | "call" | "online", name?: string) =>
        wakeNotice({ entry: { path: "/chat/abc", ...(name && { name }) }, text: t }, { now, appVisible: false, profile: "", kind });
      // The worker shows its quiet notice for this, as for a token it does not know.
      expect(kinds(off, "online", "Ana")).toBeNull();
      expect(kinds(off, "online")).toBeNull();
      expect(pushNotice({ token: "tok", kind: "online" }, { entry: { path: "/chat/abc", name: "Ana" }, text: off }, null, { now, appVisible: false, profile: "" })).toBeNull();
      expect(kinds(off, "message")).toMatchObject({ body: "New message", tag: "wake::/chat/abc" });
      expect(kinds(off, "call")).toMatchObject({ body: "Incoming call", call: true });
      // On (no flag in the table): as before.
      const { onlineOff: _, ...on } = off;
      expect(kinds(on, "online", "Ana")).toMatchObject({ body: "Ana is online", tag: "wake-online::/chat/abc" });
      expect(pushNotice({ token: "tok", kind: "online" }, { entry: { path: "/chat/abc", name: "Ana" }, text: on }, null, { now, appVisible: false, profile: "" }))
        .toMatchObject({ body: "Ana is online" });
    });

    it("nothing for a token it no longer knows, while the app is on screen, or for a route that is not a chat", () => {
      expect(show(undefined)).toBeNull();
      expect(show({ path: "/chat/abc" }, true)).toBeNull();
      expect(show({ path: "https://evil.example/" })).toBeNull();
      expect(show({ path: "/settings" })).toBeNull();
    });
  });

  describe("the worker's verdict on a build file the server answered", () => {
    it("keeps a whole file of this origin", () => {
      expect(assetAnswer({ status: 200, type: "basic" })).toBe("store");
    });
    it("reads a 404 of this origin as the build being gone", () => {
      expect(assetAnswer({ status: 404, type: "basic" })).toBe("gone");
    });
    it("leaves a server error, a partial answer and a cross-origin answer alone", () => {
      expect(assetAnswer({ status: 503, type: "basic" })).toBe("pass");
      expect(assetAnswer({ status: 206, type: "basic" })).toBe("pass");
      // An opaque answer says nothing, not even its status (always 0): whatever the other origin did.
      expect(assetAnswer({ status: 0, type: "opaque" })).toBe("pass");
    });
  });
});

// covers: app.pwa.share-target
describe("the shares the worker holds and forwards", () => {
  /**
   * A share still in the picker when the page restarts (a profile switch): the page hands it back to the web app's
   * service worker (apps/web/src/sw/sw.ts), which holds it again for the page that loads next, as a share just posted.
   * The worker's own script runs here against a stand-in for its scope.
   */

  // A forward waits between its looks at the peer locks: the clock is moved by hand (`looked`).
  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  type Message = { data: unknown; source: { id: string; postMessage(message: unknown): void } | null; waitUntil(promise: Promise<unknown>): void };

  /**
   * `locks`: the peer lock each window holds, by window id, as the browser keeps it (it lets go of a page's by itself when
   * the page dies). Left out: a browser with no Web Locks in workers.
   */
  async function startWorker(scope = "https://app.ghostly.tools/", windows: { id: string }[] = [], locks?: Map<string, string>) {
    const listeners = new Map<string, (event: Message) => void>();
    vi.stubGlobal("__SW_BUILD__", "test-1");
    vi.stubGlobal("__SW_PRECACHE__", []);
    vi.stubGlobal("self", {
      location: new URL("https://app.ghostly.tools/sw.js"),
      registration: { scope },
      clients: { matchAll: async () => windows },
      ...(locks && { navigator: { locks: { query: async () => ({ held: [...locks].map(([clientId, name]) => ({ name, clientId, mode: "exclusive" })) }) } } }),
      addEventListener: (type: string, listener: (event: Message) => void) => { listeners.set(type, listener); },
    });
    await import("../../../../web/src/sw/sw");
    const waits: Promise<unknown>[] = [];
    const say = (data: unknown, source: Message["source"]) => listeners.get("message")!({ data, source, waitUntil: (promise) => { waits.push(promise); } });
    /** Another app shares `text`: a POST to the share target, held once the worker read it. */
    const post = async (text: string) => {
      const form = new FormData();
      form.set("text", text);
      const request = new Request("https://app.ghostly.tools/share-target", { method: "POST", body: form });
      let answered: Promise<unknown> = Promise.resolve();
      listeners.get("fetch")!({ request, respondWith: (answer: Promise<unknown>) => { answered = answer; }, waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as never);
      await answered.catch(() => {});
    };
    /** Every forward asked for so far has looked at the locks as often as it does, and is over. */
    const looked = async () => {
      await vi.advanceTimersByTimeAsync(3 * SHARE_LOCK_LOOK_MS);
      await Promise.all(waits.slice(1));
    };
    return { say, post, waits, looked };
  }

  const item = (text: string) => ({ title: "", text, url: "", files: [] });

  /** A window: what it hears, but for the worker asking it where it is (`share-where`), which `asked` counts. */
  const page = (id: string, onAsked?: () => void) => {
    const heard: unknown[] = [];
    const self = {
      id, heard, asked: 0,
      postMessage: (message: unknown) => {
        if ((message as { type?: string }).type !== "share-where") { heard.push(message); return; }
        self.asked += 1;
        onAsked?.();
      },
    };
    return self;
  };

  it("holds a share the page gave back until the next page asks for it, and stays up meanwhile", async () => {
    const worker = await startWorker();
    const item = { title: "", text: "for Ana", url: "", files: [] };
    const leaving = page("a");
    worker.say({ type: "share-keep", item }, leaving);
    expect(worker.waits).toHaveLength(1);
    let settled = false;
    void worker.waits[0]!.then(() => { settled = true; });

    const next = page("b");
    worker.say({ type: "share-ready" }, next);
    expect(next.heard).toEqual([{ type: "share", item }]);
    await Promise.resolve();
    expect(settled).toBe(true);
    // Handed over once.
    worker.say({ type: "share-ready" }, next);
    expect(next.heard).toEqual([{ type: "share", item }, { type: "share-none" }]);
  });

  it("shares posted past the three it holds are counted, and the page that takes the others is told how many", async () => {
    const worker = await startWorker();
    for (const text of ["one", "two", "three", "four", "five"]) await worker.post(text);
    const next = page("b");
    worker.say({ type: "share-ready" }, next);
    expect(next.heard).toEqual([
      { type: "share", item: expect.objectContaining(item("one")) },
      { type: "share", item: expect.objectContaining(item("two")) },
      { type: "share", item: expect.objectContaining(item("three")), dropped: 2 },
    ]);
    // Told once.
    await worker.post("six");
    worker.say({ type: "share-ready" }, next);
    expect(next.heard[next.heard.length - 1]).toEqual({ type: "share", item: expect.objectContaining(item("six")) });
  });

  it("a page that goes with shares in its picker (a share into the same window) has them held ahead of the share it went for", async () => {
    const worker = await startWorker();
    // The window posts a new share: the worker holds it, and the page it replaces gives back the two in its picker.
    await worker.post("new");
    const leaving = page("a");
    worker.say({ type: "share-keep", item: item("shown") }, leaving);
    worker.say({ type: "share-keep", item: item("behind") }, leaving);
    const next = page("b");
    worker.say({ type: "share-ready" }, next);
    expect(next.heard).toEqual([
      { type: "share", item: item("shown") },
      { type: "share", item: item("behind") },
      { type: "share", item: expect.objectContaining(item("new")) },
    ]);
  });

  it("a page that goes with three shares in its picker keeps all three: the share it went for is the one past them", async () => {
    const worker = await startWorker();
    await worker.post("new");
    const leaving = page("a");
    for (const text of ["shown", "second", "third"]) worker.say({ type: "share-keep", item: item(text) }, leaving);
    const next = page("b");
    worker.say({ type: "share-ready" }, next);
    expect(next.heard).toEqual([
      { type: "share", item: item("shown") },
      { type: "share", item: item("second") },
      { type: "share", item: item("third"), dropped: 1 },
    ]);
  });

  it("a share given back with a count of those that could not be kept: the next page is told it, with any the worker dropped since", async () => {
    const worker = await startWorker();
    const leaving = page("a");
    worker.say({ type: "share-keep", item: item("shown"), dropped: 2 }, leaving);
    worker.say({ type: "share-keep", item: item("behind"), dropped: Number.NaN } as never, leaving);
    const next = page("b");
    worker.say({ type: "share-ready" }, next);
    expect(next.heard).toEqual([
      { type: "share", item: item("shown") },
      { type: "share", item: item("behind"), dropped: 2 },
    ]);
  });

  it("a profile's push worker holds nothing", async () => {
    const worker = await startWorker("https://app.ghostly.tools/push/default/");
    worker.say({ type: "share-keep", item: { title: "", text: "hi", url: "", files: [] } }, page("a"));
    expect(worker.waits).toEqual([]);
    const next = page("b");
    worker.say({ type: "share-ready" }, next);
    expect(next.heard).toEqual([{ type: "share-none" }]);
  });

  it("a share forwarded goes to one window: the app's page of the same profile focused last, never another profile's", async () => {
    const work = page("work");
    const older = page("home-older");
    const home = page("home");
    const opened = page("opened");
    const worker = await startWorker(undefined, [work, older, home, opened]);
    worker.say({ type: "share-here", profile: "home" }, older);
    worker.say({ type: "share-here", profile: "home" }, home);
    worker.say({ type: "share-here", profile: "work" }, work);
    const item = { title: "", text: "for Ana", url: "", files: [] };
    worker.say({ type: "share-keep", item }, opened);

    worker.say({ type: "share-forward", profile: "home" }, opened);
    await worker.looked();
    expect(home.heard).toEqual([{ type: "share", item }]);
    expect(older.heard).toEqual([]);
    expect(work.heard).toEqual([]);
    // Only that it went.
    expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
  });

  it("no page of the profile to forward it to: it waits, and goes to the first of that profile that says it is there", async () => {
    const work = page("work");
    const opened = page("opened");
    const home = page("home");
    const worker = await startWorker(undefined, [work, opened, home]);
    worker.say({ type: "share-here", profile: "work" }, work);
    const item = { title: "", text: "for Ana", url: "", files: [] };
    worker.say({ type: "share-keep", item }, opened);
    worker.say({ type: "share-forward", profile: "home" }, opened);
    await worker.looked();
    expect(work.heard).toEqual([]);

    // The worker stopped and started again meanwhile, or the profile's page was not there yet: it says so when it is.
    worker.say({ type: "share-here", profile: "work" }, work);
    expect(work.heard).toEqual([]);
    worker.say({ type: "share-here", profile: "home" }, home);
    expect(home.heard).toEqual([{ type: "share", item }]);
  });

  it("the tab that asked for a forward is told once the share is handed over, and not before", async () => {
    const home = page("home");
    const opened = page("opened");
    const worker = await startWorker(undefined, [home, opened]);
    worker.say({ type: "share-here", profile: "home" }, home);
    worker.say({ type: "share-keep", item: item("for Ana") }, opened);
    worker.say({ type: "share-forward", profile: "home" }, opened);
    expect(opened.heard).toEqual([]);
    await worker.looked();
    expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
    expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
  });

  it("no page to forward to yet: the tab that asked hears it went once one says it is there; nothing held, it hears there is none", async () => {
    const opened = page("opened");
    const home = page("home");
    const worker = await startWorker(undefined, [opened, home]);
    worker.say({ type: "share-keep", item: item("for Ana") }, opened);
    worker.say({ type: "share-forward", profile: "home" }, opened);
    await worker.looked();
    expect(opened.heard).toEqual([]);
    worker.say({ type: "share-here", profile: "home" }, home);
    expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
    expect(opened.heard).toEqual([{ type: "share-forwarded" }]);

    const late = page("late");
    worker.say({ type: "share-forward", profile: "home" }, late);
    expect(late.heard).toEqual([{ type: "share-none" }]);
  });

  it("the app's page that went without a word (no pagehide, no share-away) lets go of its lock: the share goes to the live app tab", async () => {
    const gone = page("gone");
    const live = page("live");
    const opened = page("opened");
    const locks = new Map([["lock-gone", "ghostly-peer-home"]]);
    const worker = await startWorker(undefined, [live, gone, opened], locks);
    worker.say({ type: "share-here", profile: "home", lock: "lock-live" }, live);
    worker.say({ type: "share-here", profile: "home", lock: "lock-gone" }, gone);
    // The phone killed it: still listed a moment, in front last, but the browser let go of its lock, which `live` took.
    locks.clear();
    locks.set("lock-live", "ghostly-peer-home");
    worker.say({ type: "share-keep", item: item("for Ana") }, opened);
    worker.say({ type: "share-forward", profile: "home" }, opened);
    await worker.looked();
    expect(gone.heard).toEqual([]);
    expect(live.heard).toEqual([{ type: "share", item: item("for Ana") }]);
    // The waiting tab says "Sent…".
    expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
  });

  it("the only app's page went without a word: the share is kept for the next app page, and the waiting tab hears it went", async () => {
    const gone = page("gone");
    const opened = page("opened");
    const next = page("next");
    const locks = new Map([["lock-gone", "ghostly-peer"]]);
    const worker = await startWorker(undefined, [gone, opened, next], locks);
    worker.say({ type: "share-here", profile: "home", lock: "lock-gone" }, gone);
    locks.clear();
    worker.say({ type: "share-keep", item: item("for Ana") }, opened);
    worker.say({ type: "share-forward", profile: "home" }, opened);
    await worker.looked();
    expect(gone.heard).toEqual([]);
    expect(opened.heard).toEqual([]);
    locks.set("lock-next", "ghostly-peer");
    worker.say({ type: "share-here", profile: "home", lock: "lock-next" }, next);
    expect(next.heard).toEqual([{ type: "share", item: item("for Ana") }]);
    expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
  });

  it("a share into the same window, nothing said by the page it replaces: never forwarded to it while it still holds its lock on the way out", async () => {
    const leaving = page("leaving");
    const opened = page("opened");
    const locks = new Map([["lock-leaving", "ghostly-peer-home"]]);
    const worker = await startWorker(undefined, [leaving, opened], locks);
    worker.say({ type: "share-here", profile: "home", lock: "lock-leaving" }, leaving);
    worker.say({ type: "share-keep", item: item("for Ana") }, opened);
    worker.say({ type: "share-forward", profile: "home" }, opened);
    // Its lock goes before the worker looks again: the tab opened for the share takes it, and asks for the share itself.
    await vi.advanceTimersByTimeAsync(SHARE_LOCK_LOOK_MS / 2);
    locks.clear();
    locks.set("lock-opened", "ghostly-peer-home");
    await worker.looked();
    expect(leaving.heard).toEqual([]);
    worker.say({ type: "share-ready" }, opened);
    expect(opened.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  });

  it("an app tab that keeps its lock gets the share forwarded", async () => {
    const home = page("home");
    const opened = page("opened");
    const worker = await startWorker(undefined, [home, opened], new Map([["lock-home", "ghostly-peer-home"], ["lock-other", "ghostly-peer-work"]]));
    // Web Locks names it otherwise than the worker does (Chromium): as the page said.
    worker.say({ type: "share-here", profile: "home", lock: "lock-home" }, home);
    worker.say({ type: "share-keep", item: item("for Ana") }, opened);
    worker.say({ type: "share-forward", profile: "home" }, opened);
    await vi.advanceTimersByTimeAsync(0);
    // Not before it held the lock on a second look.
    expect(home.heard).toEqual([]);
    await worker.looked();
    expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
    expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
  });

  it("the worker restarted since the app's page last came to the front: it asks the windows, and the share goes to that page unfocused", async () => {
    const opened = page("opened");
    const other = page("other");
    // The app's tab: it takes shares, so asked where it is it says so, as it would on focus.
    const home = page("home", () => worker.say({ type: "share-here", profile: "home", lock: "lock-home" }, home));
    const locks = new Map([["lock-home", "ghostly-peer"]]);
    const worker = await startWorker(undefined, [other, home, opened], locks);
    // A fresh worker: the share's POST started it, and no page said `share-here` in its life.
    await worker.post("two");
    worker.say({ type: "share-forward", profile: "home" }, opened);
    await worker.looked();
    expect(home.asked).toBe(1);
    expect(home.heard).toEqual([{ type: "share", item: expect.objectContaining(item("two")) }]);
    expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
    // Never the tab that asked for the forward. A window that does not take shares (one waiting behind the app's tab)
    // says nothing, and gets nothing.
    expect(opened.asked).toBe(0);
    expect(other.asked).toBe(1);
    expect(other.heard).toEqual([]);
  });

  it("a share forwarded never goes to the app's page on its way out (a share into the same window replaced it)", async () => {
    const leaving = page("leaving");
    const opened = page("opened");
    const next = page("next");
    // It said it goes: the worker need not wait for the lock it still holds.
    const worker = await startWorker(undefined, [leaving, opened, next], new Map([["lock-leaving", "ghostly-peer-home"]]));
    worker.say({ type: "share-here", profile: "home", lock: "lock-leaving" }, leaving);
    worker.say({ type: "share-away" }, leaving);
    worker.say({ type: "share-keep", item: item("for Ana") }, opened);
    // The tab opened for it goes before its wait is over: it forwards at once.
    worker.say({ type: "share-forward", profile: "home" }, opened);
    await worker.looked();
    expect(leaving.heard).toEqual([]);
    // Held for the next page of the profile instead.
    worker.say({ type: "share-here", profile: "home" }, next);
    expect(next.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  });
});

// covers: app.pwa.offline
describe("what the worker's install asks the server for", () => {
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

// covers: app.pwa.offline
describe("a build file that is not precached", () => {
  /**
   * A build file the worker did not precache (Iroh's WebAssembly, each wallet's: 2 to 12 MiB), the first time it is
   * asked for. This runs the worker's own script (`apps/web/src/sw/sw.ts`) against a stand-in scope: the page compiles
   * these while they arrive, so the worker must answer when the download starts and store the file behind the answer.
   */
  const ORIGIN = "https://app.ghostly.tools";
  const WASM = "/assets/ghostly_iroh_web_bg-abc.wasm";

  interface FetchEvent { request: Request; respondWith(response: Promise<Response> | Response): void; waitUntil(promise: Promise<unknown>): void }

  /** The worker's script, started in a scope whose cache stores with `put`. Returns its `fetch` listener and the
   *  messages the worker posted to open pages. */
  async function startWorker(put: (key: string, response: Response) => Promise<void>) {
    const listeners = new Map<string, (event: FetchEvent) => void>();
    const cache = { match: async () => undefined, put };
    const posted: { type: string }[] = [];
    const windowClient = { postMessage: (message: { type: string }) => { posted.push(message); } };
    vi.stubGlobal("__SW_BUILD__", "test");
    vi.stubGlobal("__SW_PRECACHE__", ["/"]);
    vi.stubGlobal("caches", { open: async () => cache, match: async () => undefined });
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: `${ORIGIN}/` },
      clients: { matchAll: async () => [windowClient] },
      addEventListener: (type: string, listener: (event: FetchEvent) => void) => { listeners.set(type, listener); },
    });
    vi.resetModules();
    await import("../../../../web/src/sw/sw");
    return { onFetch: listeners.get("fetch")!, posted };
  }

  /** One request through the worker: what it answered with, and what it asked to be kept alive for. */
  function ask(onFetch: (event: FetchEvent) => void, path: string) {
    let answer: Promise<Response> | undefined;
    const waited: Promise<unknown>[] = [];
    onFetch({
      request: new Request(ORIGIN + path),
      respondWith: (response) => { answer = Promise.resolve(response); },
      waitUntil: (promise) => { waited.push(promise); },
    });
    return { answer, waited };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is answered before it is stored: a store that never ends holds nothing back", async () => {
    const stored: string[] = [];
    const { onFetch } = await startWorker((key) => { stored.push(key); return new Promise(() => {}); });
    vi.stubGlobal("fetch", async () => new Response("wasm bytes"));

    const { answer, waited } = ask(onFetch, WASM);
    const response = await Promise.race([answer, new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 200))]);

    expect(response).not.toBe("held");
    expect(await (response as Response).text()).toBe("wasm bytes");
    // Stored all the same, and the worker stays up until it is.
    expect(stored).toEqual([WASM]);
    expect(waited).toHaveLength(1);
  });

  it("is answered when the store fails, and the failure stays in the worker", async () => {
    const { onFetch } = await startWorker(() => Promise.reject(new Error("quota")));
    vi.stubGlobal("fetch", async () => new Response("wasm bytes"));

    const { answer, waited } = ask(onFetch, WASM);

    expect(await (await answer)!.text()).toBe("wasm bytes");
    await expect(Promise.all(waited)).resolves.toBeDefined();
  });

  it("is not stored when the answer is a server error, and the error stays in the worker", async () => {
    const stored: string[] = [];
    const { onFetch } = await startWorker(async (key) => { stored.push(key); });
    vi.stubGlobal("fetch", async () => new Response("later", { status: 503 }));

    const { answer, waited } = ask(onFetch, WASM);

    expect((await answer)!.status).toBe(503);
    expect(stored).toEqual([]);
    expect(waited).toEqual([]);
  });

  it("is not stored on a 404, and every open page is told the build is gone", async () => {
    const stored: string[] = [];
    const { onFetch, posted } = await startWorker(async (key) => { stored.push(key); });
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));

    const { answer, waited } = ask(onFetch, WASM);

    expect((await answer)!.status).toBe(404);
    expect(stored).toEqual([]);
    // One waitUntil: telling the pages. After it settles they have the build-gone message.
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(posted).toEqual([{ type: "build-gone" }]);

    // Try again asks for the same gone file: the pages were told, once per life of the worker.
    const again = ask(onFetch, WASM);
    expect((await again.answer)!.status).toBe(404);
    await Promise.all(again.waited);
    expect(posted).toEqual([{ type: "build-gone" }]);
  });
});

// covers: app.pwa.share-target
describe("a share into the installed web app", () => {
  /**
   * What another app shares into the installed web app, through the worker's own script (`apps/web/src/sw/sw.ts`) in a
   * stand-in scope: the share target's POST, then the opened page's "share-ready" and what the worker answers it.
   */
  const ORIGIN = "https://app.ghostly.tools";
  const MiB = 1024 * 1024;

  type Listener = (event: object) => void;

  async function startWorker() {
    const listeners = new Map<string, Listener>();
    vi.stubGlobal("__SW_BUILD__", "test");
    vi.stubGlobal("__SW_PRECACHE__", ["/"]);
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: `${ORIGIN}/` },
      clients: { matchAll: async () => [] },
      addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
    });
    // A worker resolves the redirect against its own address; Node has none.
    const redirect = Response.redirect.bind(Response);
    vi.spyOn(Response, "redirect").mockImplementation((url, status) => redirect(new URL(url, ORIGIN).href, status));
    vi.resetModules();
    await import("../../../../web/src/sw/sw");
    return { onFetch: listeners.get("fetch")!, onMessage: listeners.get("message")! };
  }

  /** A share POST through the worker, then what the page that opened for it is told. */
  async function shareThenAsk(request: { method: string; url: string; mode: string; headers: Headers; body: ReadableStream<Uint8Array> | null }): Promise<FromWorker> {
    const { onFetch, onMessage } = await startWorker();
    let answer: Promise<Response> | Response | undefined;
    onFetch({ request, respondWith: (response: Promise<Response> | Response) => { answer = response; }, waitUntil: () => {} });
    expect((await answer)!.status).toBe(303);
    const told: FromWorker[] = [];
    onMessage({ data: { type: "share-ready" }, source: { id: "page", url: `${ORIGIN}/#/shared`, postMessage: (message: FromWorker) => told.push(message) }, waitUntil: () => {} });
    return told[0]!;
  }

  /** A body of `mib` MiB, pulled a MiB at a time (a phone's video, as the system's share sheet posts it). */
  function body(mib: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({ pull(controller) { if (sent++ >= mib) controller.close(); else controller.enqueue(new Uint8Array(MiB)); } });
  }

  const post = (headers: Record<string, string>, stream: ReadableStream<Uint8Array>) =>
    ({ method: "POST", url: `${ORIGIN}/share-target`, mode: "navigate", headers: new Headers(headers), body: stream });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a small file is handed to the page", async () => {
    const form = new FormData();
    form.append("files", new File(["boo"], "small.txt", { type: "text/plain" }));
    const sent = new Request(`${ORIGIN}/share-target`, { method: "POST", body: form });
    const told = await shareThenAsk({ method: "POST", url: sent.url, mode: "navigate", headers: sent.headers, body: sent.body });
    expect(told).toMatchObject({ type: "share", item: { files: [expect.objectContaining({ name: "small.txt" })] } });
    expect(told.type === "share" && told.item.leftOut).toBeFalsy();
  });

  it("over 64 MiB with no length said: the page is told a file was too large, not that nothing was shared", async () => {
    const told = await shareThenAsk(post({ "content-type": "multipart/form-data; boundary=x" }, body(65)));
    // Never read, so its name is not known.
    expect(told).toEqual({ type: "share", item: { title: "", text: "", url: "", files: [], leftOut: [""] } });
  });

  it("a length over 64 MiB said up front: the same, without reading it", async () => {
    const told = await shareThenAsk(post({ "content-type": "multipart/form-data; boundary=x", "content-length": String(300 * 1024 * 1024) }, body(1)));
    expect(told).toEqual({ type: "share", item: { title: "", text: "", url: "", files: [], leftOut: [""] } });
  });

  it("a second share never replaces one still waiting: it waits behind it, and past three the newest is dropped", async () => {
    const { onFetch, onMessage } = await startWorker();
    for (const text of ["mine", "a page's", "two", "three"]) {
      const form = new FormData();
      form.append("text", text);
      const sent = new Request(`${ORIGIN}/share-target`, { method: "POST", body: form });
      let answer: Promise<Response> | Response | undefined;
      onFetch({ request: { method: "POST", url: sent.url, mode: "navigate", headers: sent.headers, body: sent.body }, respondWith: (response: Promise<Response> | Response) => { answer = response; }, waitUntil: () => {} });
      expect((await answer)!.status).toBe(303);
    }
    const told: FromWorker[] = [];
    onMessage({ data: { type: "share-ready" }, source: { id: "page", url: `${ORIGIN}/#/shared`, postMessage: (message: FromWorker) => told.push(message) }, waitUntil: () => {} });
    expect(told.map((message) => message.type === "share" && message.item.text)).toEqual(["mine", "a page's", "two"]);
  });
});

// covers: push.wake.online
describe("a profile's push worker after a deploy", () => {
  /*
   * A profile's push worker (`/push/<profile>/`) is registered once, and no page ever runs in its scope: without the page
   * asking, it keeps the script of the build that registered it until the browser looks again on its own (Chromium: a day
   * after its last look, on a push). The page asks for that build's script at start, so the worker reads what the page
   * shares (an online wake-up, `o`, read as "New message" by a worker from before it).
   */

  class FakeRegistration {
    constructor(public scope: string) {}
    update = vi.fn(async () => {});
    pushManager = { getSubscription: vi.fn(async () => null) };
    unregister = vi.fn(async () => true);
  }

  let registrations: Map<string, FakeRegistration>;

  beforeEach(() => {
    vi.resetModules();
    registrations = new Map();
    const container = {
      getRegistration: vi.fn(async (scope: string) => registrations.get(scope)),
      register: vi.fn(),
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    Reflect.deleteProperty(window, "isSecureContext");
  });

  function pushWorkerOf(profile: string): FakeRegistration {
    const scope = new URL(pushScope(profile), location.origin).href;
    const made = new FakeRegistration(scope);
    registrations.set(scope, made);
    return made;
  }

  it("the page's start asks the browser for the push worker's script of this build", async () => {
    const ana = pushWorkerOf("ana");
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await currentPush("ana");
    expect(ana.update).toHaveBeenCalledTimes(1);
  });

  it("once per page: a standby's page looking every minute does not fetch the script every minute", async () => {
    const ana = pushWorkerOf("ana");
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await currentPush("ana");
    await currentPush("ana");
    await currentPush("ana");
    expect(ana.update).toHaveBeenCalledTimes(1);
  });

  it("each profile's own worker, and only that one", async () => {
    const ana = pushWorkerOf("ana");
    const cat = pushWorkerOf("");
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await currentPush("");
    expect(cat.update).toHaveBeenCalledTimes(1);
    expect(ana.update).not.toHaveBeenCalled();
  });

  it("a script the browser cannot fetch now (offline) changes nothing of what the page reads", async () => {
    const ana = pushWorkerOf("ana");
    ana.update.mockRejectedValue(new TypeError("Failed to fetch"));
    ana.pushManager.getSubscription.mockResolvedValue({ endpoint: "https://push.example/ana", getKey: () => null } as never);
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await expect(currentPush("ana")).resolves.toEqual({ endpoint: "https://push.example/ana", p256dh: "", auth: "" });
  });
});

// covers: devices.push, devices.screens
describe("the quiet notices before any page wrote its words", () => {
  /*
   * The push worker's words on a device that was never active (WISP 06 § Push and the phone): no page of the profile wrote
   * its own yet, so they come from the app's translations in the browser's language, and a page's words win once written.
   */

  const standby: NoticeDevice = { state: "standby", active: "MacBook", tokens: {} };
  const options = { now: 1_800_000_000_000, appVisible: false, profile: "" };
  const wake = { token: "t".repeat(22), kind: "message" as const };

  it("are in the browser's language, with the worker's {device} in place of the app's {{device}}", () => {
    const pt = deviceNoticeWords(["pt-BR", "en-US"]);
    expect(pt.standby).toBe("Nova mensagem. Ativo em {device}.");
    expect(pushNotice(wake, undefined, standby, { ...options, text: pt })?.body).toBe("Nova mensagem. Ativo em MacBook.");
    expect(deviceNoticeWords(["ja"]).takeover).toContain("{device}");
    for (const words of [["ar"], ["es"], ["fr"], ["it"], ["ja"], ["zh-CN"]].map(deviceNoticeWords)) {
      expect(Object.keys(words).sort()).toEqual(Object.keys(DEVICE_NOTICE_DEFAULTS).sort());
      for (const text of Object.values(words)) expect(text).not.toContain("{{");
    }
  });

  it("are English for a language the app does not speak, the same as the worker's own defaults", () => {
    expect(deviceNoticeWords(["de-DE", "nl"])).toEqual(DEVICE_NOTICE_DEFAULTS);
    expect(deviceNoticeWords([])).toEqual(DEVICE_NOTICE_DEFAULTS);
  });

  it("give way to the words a page wrote in the app's language", () => {
    const text = { ...deviceNoticeWords(["pt-BR"]), standby: "Mensaje nuevo. Activo en {device}." };
    expect(pushNotice(wake, undefined, standby, { ...options, text })?.body).toBe("Mensaje nuevo. Activo en MacBook.");
  });
});
