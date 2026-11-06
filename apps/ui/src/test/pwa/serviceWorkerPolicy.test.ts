import { describe, expect, it } from "vitest";
import { MAX_PAST_LIMIT_NAMES, MAX_SHARED_FILES, MAX_SHARE_BYTES, SHARE_TARGET_PATH, assetAnswer, classify, desktopOnlyFiles, installList, optionalFiles, precacheList, serviceWorkerFiles, pushScope, pushScopeProfile, readShare, readShareBody, wakeNotice } from "../../../../web/src/sw/policy";

// covers: app.pwa.offline, app.pwa.share-target, push.wake.notify, push.wake.mute, push.wake.group, push.wake.online

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

  // covers: apps.web-sandbox
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

  it("not the language detector's worker either: an asset, so not one of those chunks", () => {
    expect(precacheList(["assets/main-abc.js", "assets/translateDetector.worker-abc.js"])).toEqual(["/", "/assets/main-abc.js"]);
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

  // covers: app.pwa.offline
  it("not what only an online flow loads (Pubky, a Keet proof, a device handoff, the USDT and Ark wallets), nor the languages", () => {
    const { precache, languages } = serviceWorkerFiles(["manifest.json", "version.json"], BUNDLE);
    expect(precache).toEqual(["/", "/assets/cashu-ts-abc.js", "/assets/Chat-abc.js", "/assets/handoff-abc.js", "/assets/index-abc.css", "/assets/index-abc.js",
      "/assets/sodium-abc.js", "/assets/vendor-abc.js", "/assets/Wallet-abc.js", "/manifest.json"]);
    expect(languages).toEqual({ fr: ["/assets/fr-abc.js"], ja: ["/assets/ja-abc.js"] });
  });

  it("an online-only module another screen imports as it loads stays: the path to it is not the online flow's", () => {
    const bundle = BUNDLE.map((file) => file.fileName === "assets/Chat-abc.js" ? { ...file, imports: ["assets/vendor-abc.js", "assets/pubky-abc.js"] } : file);
    expect(optionalFiles(bundle).onlineOnly).not.toContain("assets/pubky-abc.js");
    expect(serviceWorkerFiles([], bundle).precache).toContain("/assets/pubky-abc.js");
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
