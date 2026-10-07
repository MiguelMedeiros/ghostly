import { describe, expect, it } from "vitest";
import { MAX_SHARED_FILES, MAX_SHARE_BYTES, SHARE_TARGET_PATH, classify, precacheList, pushScope, pushScopeProfile, readShare, readShareBody, wakeNotice } from "../../../../web/src/sw/policy";

// covers: app.pwa.offline, app.pwa.share-target, push.wake.notify, push.wake.mute, push.wake.group

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
    expect(item.text).toHaveLength(64 * 1024);
    expect(item.url).toBe("https://example.com");
    expect(item.files).toHaveLength(MAX_SHARED_FILES);
    expect(item.files[0]!.name).toBe("f0.txt");
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

  it("nothing for a token it no longer knows, while the app is on screen, or for a route that is not a chat", () => {
    expect(show(undefined)).toBeNull();
    expect(show({ path: "/chat/abc" }, true)).toBeNull();
    expect(show({ path: "https://evil.example/" })).toBeNull();
    expect(show({ path: "/settings" })).toBeNull();
  });
});
