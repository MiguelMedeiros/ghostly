import { describe, expect, it } from "vitest";
import { MAX_SHARED_FILES, SHARE_TARGET_PATH, classify, precacheList, readShare } from "../../../web/src/sw/policy";

// covers: app.pwa.offline, app.pwa.share-target

/**
 * What the web app's service worker answers, and what it keeps: the build's own files only. These are the rules
 * `web/src/sw/sw.ts` follows; e2e/web/pwa.spec.ts checks the worker itself.
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
});
