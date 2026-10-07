import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CHECK_TIMINGS } from "../src/engine/apps";
import { APP_FETCH_HOSTS, APP_FETCH_LIMITS, AppFetchError, appPasteUrl, besideUrl, boundedAppFetch, isAppFetchUrl } from "../src/engine/appFetch";
import { DEFAULT_APP_STORES, DEFAULT_STORE_KEY, DEFAULT_STORE_URL } from "../src/engine/appDefaults";
import { isAppKey } from "@ghostly/core";
import {
  BUNDLE_URL, FakeNet, NOW_S, PINNED_URL, SIG_URL, STORE_KEY, STORE_URL, apps, bundle, emptyProfile, keyOf, listing, signer, storeFiles,
} from "./appsSupport";
// covers: apps.engine.stores, apps.engine.network

/*
 * Stores (WISP 1200 § Stores) and the network rules of the engine's app store: reads only from raw.githubusercontent.com
 * and from cdn.jsdelivr.net at a commit, HTTPS, no redirect, capped while streaming, and no request at all with no app
 * installed.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});
afterEach(() => { vi.useRealTimers(); });

/** Fake timeouts and clock only: IndexedDB (fake-indexeddb) runs on the real `setImmediate`. */
const clock = () => vi.useFakeTimers({ now: Date.now(), toFake: ["setTimeout", "clearTimeout", "Date"] });
/** Lets `ms` pass, then waits until the store's tick is over (it schedules the next one last). */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.waitFor(() => { expect(vi.getTimerCount()).toBe(1); }, { timeout: 5000, interval: 5 });
}

describe("the hosts", () => {
  it("only raw.githubusercontent.com, and cdn.jsdelivr.net at a full commit, over HTTPS", () => {
    expect(APP_FETCH_HOSTS).toEqual(["raw.githubusercontent.com", "cdn.jsdelivr.net"]);
    for (const ok of [BUNDLE_URL, PINNED_URL, STORE_URL]) expect(isAppFetchUrl(ok), ok).toBe(true);
    for (const bad of [
      "http://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp",
      "https://raw.githubusercontent.com:8443/ana/chess/HEAD/app.ghostlyapp",
      "https://user:pw@raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp",
      "https://github.com/ana/chess/raw/HEAD/app.ghostlyapp",
      "https://api.github.com/repos/ana/chess",
      "https://codeload.github.com/ana/chess/zip/HEAD",
      "https://cdn.jsdelivr.net/gh/ana/chess@main/app.ghostlyapp",
      "https://cdn.jsdelivr.net/gh/ana/chess@latest/app.ghostlyapp",
      "https://cdn.jsdelivr.net/gh/ana/chess@1.2/app.ghostlyapp",
      `https://cdn.jsdelivr.net/gh/ana/chess@${"a".repeat(39)}/app.ghostlyapp`,
      `https://fastly.jsdelivr.net/gh/ana/chess@${"a".repeat(40)}/app.ghostlyapp`,
      "https://raw.githubusercontent.com.evil.example/ana/chess/HEAD/app.ghostlyapp",
      "https://example.com/ghostly-store.json",
    ]) expect(isAppFetchUrl(bad), bad).toBe(false);
  });

  it("a pasted address becomes a raw URL, with no request to github.com", () => {
    expect(appPasteUrl("https://github.com/ana/chess", "app.ghostlyapp")).toBe(BUNDLE_URL);
    expect(appPasteUrl(" https://github.com/ana/chess.git/ ", "app.ghostlyapp")).toBe(BUNDLE_URL);
    expect(appPasteUrl("https://github.com/ana/chess/tree/v2", "app.ghostlyapp")).toBe("https://raw.githubusercontent.com/ana/chess/v2/app.ghostlyapp");
    expect(appPasteUrl("https://github.com/ghostly/store", "ghostly-store.json")).toBe(STORE_URL);
    expect(appPasteUrl("https://raw.githubusercontent.com/ana/chess/HEAD", "app.ghostlyapp")).toBe(BUNDLE_URL);
    expect(appPasteUrl(PINNED_URL, "app.ghostlyapp")).toBe(PINNED_URL);
    // A file as GitHub shows it (or its raw link there): the same file at that ref on raw.githubusercontent.com.
    expect(appPasteUrl("https://github.com/ana/chess/blob/HEAD/app.ghostlyapp", "app.ghostlyapp")).toBe(BUNDLE_URL);
    expect(appPasteUrl("https://github.com/ana/chess/blob/v2/dist/app.ghostlyapp", "app.ghostlyapp")).toBe("https://raw.githubusercontent.com/ana/chess/v2/dist/app.ghostlyapp");
    expect(appPasteUrl("https://github.com/ana/chess/raw/main/app.ghostlyapp?download=1", "app.ghostlyapp")).toBe("https://raw.githubusercontent.com/ana/chess/main/app.ghostlyapp");
    expect(appPasteUrl("https://github.com/ghostly/store/blob/HEAD/ghostly-store.json", "ghostly-store.json")).toBe(STORE_URL);
    for (const bad of ["https://github.com/ana", "https://github.com/ana/chess/blob/HEAD/x", "https://github.com/ana/chess/blob/HEAD", "https://github.com/ana/chess/blob/HEAD/../app.ghostlyapp", "https://github.com/ana/chess/issues", "https://example.com/app.ghostlyapp", "not a url", "http://github.com/ana/chess"]) {
      expect(appPasteUrl(bad, "app.ghostlyapp"), bad).toBeNull();
    }
    expect(besideUrl(STORE_URL, "ghostly-store.sig")).toBe(SIG_URL);
    expect(besideUrl(`${BUNDLE_URL}?x=1`, "ghostly-revoke.json")).toBe("https://raw.githubusercontent.com/ana/chess/HEAD/ghostly-revoke.json");
  });

  it("a URL off the list is refused before any request; no cookies, no referrer, no redirect", async () => {
    const fetcher = vi.fn(async () => new Response("x"));
    const read = boundedAppFetch({ fetcher });
    await expect(read("https://example.com/app.ghostlyapp", { maxBytes: 10 })).rejects.toMatchObject({ code: "host" });
    expect(fetcher).not.toHaveBeenCalled();
    await read(BUNDLE_URL, { maxBytes: 10 });
    expect(fetcher).toHaveBeenCalledWith(BUNDLE_URL, expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" }));
  });

  it("a response that lands on another host is refused", async () => {
    const fetcher = vi.fn(async () => { const r = new Response("x"); Object.defineProperty(r, "url", { value: "https://evil.example/x" }); return r; });
    await expect(boundedAppFetch({ fetcher })(BUNDLE_URL, { maxBytes: 10 })).rejects.toMatchObject({ code: "host" });
  });

  it("the size cap holds while the body streams, whatever Content-Length says; a peek reads only the first bytes", async () => {
    let pulled = 0, cancelled = false;
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1000)); },
      cancel() { cancelled = true; },
    }));
    const read = boundedAppFetch({ fetcher: vi.fn(async () => endless()) });
    await expect(read(BUNDLE_URL, { maxBytes: 4500 })).rejects.toMatchObject({ code: "too-large" });
    expect(cancelled, "the rest is never read").toBe(true);
    expect(pulled).toBeLessThan(10);
    expect((await read(BUNDLE_URL, { maxBytes: 4500, peek: true })).length).toBe(4500);
    const declared = boundedAppFetch({ fetcher: vi.fn(async () => new Response("x", { headers: { "content-length": "999999" } })) });
    await expect(declared(BUNDLE_URL, { maxBytes: 10 })).rejects.toMatchObject({ code: "too-large" });
    const missing = boundedAppFetch({ fetcher: vi.fn(async () => new Response("no", { status: 404 })) });
    await expect(missing(BUNDLE_URL, { maxBytes: 10 })).rejects.toMatchObject({ code: "status", status: 404 });
  });

  it("offline: nothing goes out", async () => {
    const fetcher = vi.fn(async () => new Response("x"));
    await expect(boundedAppFetch({ fetcher, online: () => false })(BUNDLE_URL, { maxBytes: 10 })).rejects.toBeInstanceOf(AppFetchError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("no request with nothing installed", () => {
  it("start, then days of update checks, with no app and no store: not one request", async () => {
    clock();
    const store = apps(net);
    await store.start();
    await pass(APP_CHECK_TIMINGS.afterStartMs);
    for (let day = 0; day < 3; day++) await pass(APP_CHECK_TIMINGS.everyMs);
    expect(await store.list()).toEqual([]);
    expect(await store.listStores()).toEqual([]);
    expect(net.fetch).not.toHaveBeenCalled();
    store.stop();
  });

  it("a store added but no app installed: the scheduled checks still ask nothing", async () => {
    await net.putStore(await storeFiles());
    const store = apps(net);
    await store.addStore({ url: STORE_URL });
    net.fetch.mockClear();
    clock();
    await store.start();
    await pass(APP_CHECK_TIMINGS.afterStartMs);
    for (let day = 0; day < 3; day++) await pass(APP_CHECK_TIMINGS.everyMs);
    expect(net.fetch).not.toHaveBeenCalled();
    store.stop();
  });

  it("the official store is read from its repository at HEAD, and stays off while its key is empty", async () => {
    expect(DEFAULT_STORE_URL).toBe("https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/ghostly-store.json");
    expect(isAppFetchUrl(DEFAULT_STORE_URL)).toBe(true);
    if (DEFAULT_STORE_KEY) {
      expect(isAppKey(DEFAULT_STORE_KEY), "the store's public key, 52 z-base32 characters").toBe(true);
      expect(DEFAULT_APP_STORES).toEqual([{ url: DEFAULT_STORE_URL, key: DEFAULT_STORE_KEY }]);
      return;
    }
    // No key yet (the owner makes it offline): no default store, and a profile starts with none.
    expect(DEFAULT_APP_STORES).toEqual([]);
    const store = apps(net);
    await store.start();
    store.stop();
    expect(await store.listStores()).toEqual([]);
    // A default whose key is empty is skipped, never added unpinned.
    const unpinned = apps(net, { defaults: [{ url: DEFAULT_STORE_URL, key: "" }] });
    await unpinned.start();
    unpinned.stop();
    expect(await unpinned.listStores()).toEqual([]);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it("a preloaded default store is kept without a request, and once removed it stays removed", async () => {
    const defaults = [{ url: STORE_URL, key: keyOf(STORE_KEY) }];
    const store = apps(net, { defaults });
    await store.start();
    store.stop();
    expect(await store.listStores()).toMatchObject([{ key: keyOf(STORE_KEY), url: STORE_URL, preloaded: true, apps: [] }]);
    expect(net.fetch).not.toHaveBeenCalled();
    await store.removeStore({ key: keyOf(STORE_KEY) });
    const later = apps(net, { defaults });
    await later.start();
    later.stop();
    expect(await later.listStores()).toEqual([]);
  });

  it("with an app installed, the check runs after start and every 24 hours", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const first = apps(net);
    await first.preview({ url: BUNDLE_URL });
    await first.install({ digest: v1.digest, grant: ["chat"] });
    net.fetch.mockClear();
    clock();
    const store = apps(net, { now: () => Date.now() });
    await store.start();
    await pass(APP_CHECK_TIMINGS.afterStartMs);
    const afterStart = net.fetch.mock.calls.length;
    expect(afterStart).toBeGreaterThan(0);
    await pass(APP_CHECK_TIMINGS.everyMs - 1000);
    expect(net.fetch.mock.calls.length, "not before the day is over").toBe(afterStart);
    await pass(1000);
    expect(net.fetch.mock.calls.length).toBeGreaterThan(afterStart);
    store.stop();
  });

  it("the scheduled check waits while the network is off", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const first = apps(net);
    await first.preview({ url: BUNDLE_URL });
    await first.install({ digest: v1.digest, grant: ["chat"] });
    net.fetch.mockClear();
    clock();
    const store = apps(net, { online: () => false });
    await store.start();
    await pass(APP_CHECK_TIMINGS.afterStartMs);
    await pass(APP_CHECK_TIMINGS.everyMs);
    expect(net.fetch).not.toHaveBeenCalled();
    store.stop();
  });
});

describe("stores", () => {
  it("a store is read with its signature and pinned to its key; another key is refused", async () => {
    await net.putStore(await storeFiles());
    const store = apps(net);
    const preview = await store.previewStore({ url: "https://github.com/ghostly/store" });
    expect(preview).toMatchObject({ url: STORE_URL, key: keyOf(STORE_KEY), name: "Test store", kind: "curated", sequence: 1, apps: 0, expired: false });
    expect(await store.listStores(), "a preview keeps nothing").toEqual([]);
    await expect(store.addStore({ url: STORE_URL, key: keyOf(signer("someone else")) })).rejects.toThrow(/^store-key/);
    const added = await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
    expect(added).toMatchObject({ key: keyOf(STORE_KEY), name: "Test store", sequence: 1, preloaded: false });
    expect(net.requests.slice(-2).sort()).toEqual([SIG_URL, STORE_URL].sort());

    // The URL now serves another key's index: that is another store, refused here.
    await net.putStore(await storeFiles({ by: signer("someone else"), sequence: 9 }));
    expect(await store.refreshStores()).toMatchObject([{ key: keyOf(STORE_KEY), sequence: 1, problem: "store-key" }]);
  });

  it("an index with a lower sequence is refused, the same sequence with other bytes is marked; the held one is kept", async () => {
    const v1 = await bundle();
    await net.putStore(await storeFiles({ sequence: 5 }));
    const store = apps(net);
    await store.addStore({ url: STORE_URL });
    await net.putStore(await storeFiles({ sequence: 4, apps: [listing(v1)] }));
    expect(await store.refreshStores({ key: keyOf(STORE_KEY) })).toMatchObject([{ sequence: 5, apps: [], problem: "rollback" }]);
    await net.putStore(await storeFiles({ sequence: 5, apps: [listing(v1)] }));
    expect(await store.refreshStores()).toMatchObject([{ sequence: 5, apps: [], problem: "equivocation", equivocation: { sequence: 5 } }]);
    await net.putStore(await storeFiles({ sequence: 6, apps: [listing(v1)] }));
    const [fresh] = await store.refreshStores();
    expect(fresh).toMatchObject({ sequence: 6, apps: [{ ref: v1.ref }] });
    expect(fresh!.problem).toBeUndefined();
    expect(fresh!.equivocation).toBeUndefined();
  });

  it("refuses expires more than 90 days ahead, and says when one is past", async () => {
    await net.putStore(await storeFiles({ expires: NOW_S + 91 * 24 * 3600 }));
    await expect(apps(net).addStore({ url: STORE_URL })).rejects.toThrow(/^expires-too-far/);
    await net.putStore(await storeFiles({ expires: NOW_S - 1 }));
    expect(await apps(net).addStore({ url: STORE_URL })).toMatchObject({ expired: true });
  });

  it("reads at most 4 MiB of an index and stops there (WISP 1200 § Stores, Privacy), though the format allows 16 MiB", async () => {
    expect(APP_FETCH_LIMITS.storeIndexBytes).toBe(4 * 1024 * 1024);
    let read = 0, cancelled = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === SIG_URL) return new Response("{}");
      // An index that never ends, sent without a length: the cap holds on the bytes as they arrive.
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { read += 256 * 1024; controller.enqueue(new Uint8Array(256 * 1024).fill(0x20)); },
        cancel() { cancelled = true; },
      }));
    });
    const store = apps(net, { fetch: boundedAppFetch({ fetcher: fetcher as unknown as typeof fetch }) });
    await expect(store.addStore({ url: STORE_URL })).rejects.toThrow(/^too-large/);
    expect(cancelled).toBe(true);
    expect(read).toBeLessThanOrEqual(APP_FETCH_LIMITS.storeIndexBytes + 2 * 256 * 1024);
    expect(await store.listStores()).toEqual([]);
  });

  it("a signature that does not verify is refused", async () => {
    const good = await storeFiles();
    const other = await storeFiles({ name: "Another" });
    await net.putStore({ indexBytes: good.indexBytes, sigBytes: other.sigBytes });
    await expect(apps(net).addStore({ url: STORE_URL })).rejects.toThrow(/^bad-signature/);
  });

  it("stores off the list are refused with no request", async () => {
    await expect(apps(net).addStore({ url: "https://stores.example/ghostly-store.json" })).rejects.toThrow(/^host/);
    await expect(apps(net).preview({ url: "https://apps.example/app.ghostlyapp" })).rejects.toThrow(/^host/);
    // A github.com page that is not a repository or a file of one: the person is told to paste one, never that GitHub
    // is not a host Ghostly reads (it is, through raw.githubusercontent.com). Nothing is asked.
    for (const page of ["https://github.com/ana/chess/issues/3", "https://github.com/ana", "https://github.com/ana/chess/blob/HEAD/README.md", "http://github.com/ana/chess"]) {
      await expect(apps(net).preview({ url: page }), page).rejects.toThrow(/^github-link: /);
      await expect(apps(net).previewStore({ url: page }), page).rejects.toThrow(/^github-link: /);
    }
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it("a store's listing URLs off the list are never asked", async () => {
    const v1 = await bundle();
    await net.putStore(await storeFiles({ apps: [{ ...listing(v1), urls: ["https://mirror.example/app.ghostlyapp"] }] }));
    const store = apps(net);
    await store.addStore({ url: STORE_URL });
    net.fetch.mockClear();
    await expect(store.preview({ store: keyOf(STORE_KEY), ref: v1.ref })).rejects.toThrow(/^host/);
    expect(net.fetch).not.toHaveBeenCalled();
  });
});
