import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { fileBytes } from "../src/shared/fileBytes";
import {
  BUNDLE_URL, FakeNet, NOW_MS, PINNED_URL, PUBLISHER, REPO, STORE_KEY, STORE_URL, appRows, apps, bundle, bundleIds, emptyProfile, keyOf,
  listing, revocation, signer, storeFiles,
} from "./appsSupport";
// covers: apps.engine.installed

/*
 * The engine's app store (WISP 1200 § Updates and rollback, § Takedowns, § Apps sent in a chat): install only after the
 * person saw the checked bundle, the update rule from core (rollback refused, equivocation marked, new permissions asked
 * again), revocations and removals checked before a run, and a restored profile's missing files fetched again by digest.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * A browser that keeps no Blob in IndexedDB, as Safari's Private Browsing and WebKit's in-memory contexts: a piece of a
 * file is refused with WebKit's own words, and every other record is stored.
 */
function privateBrowsing(): void {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (!((value as { data?: unknown })?.data instanceof Blob)) return put.call(this, value, key);
    const request = { error: new DOMException("Error preparing Blob/File data to be stored in object store", "UnknownError") } as IDBRequest & { onerror: (() => void) | null };
    setTimeout(() => request.onerror?.(), 0);
    return request;
  });
}

describe("install", () => {
  it("a pasted GitHub URL is read from raw.githubusercontent.com; nothing is kept before Install", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    const preview = await store.preview({ url: "https://github.com/ana/chess" });
    expect(net.requests).toEqual([BUNDLE_URL]);
    expect(preview).toMatchObject({ digest: v1.digest, ref: v1.ref, install: "new", asks: ["chat"], run: { status: "ok" }, unknownPublisher: true, listedBy: [] });
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);

    const view = await store.install({ digest: v1.digest, grant: ["chat"] });
    // No view in its manifest: it runs in a chat.
    expect(view).toMatchObject({ ref: v1.ref, sequence: 1, digest: v1.digest, permissions: ["chat"], view: "chat", run: { status: "ok" } });
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
    const entry = await store.entry({ ref: v1.ref });
    expect(entry).toMatchObject({ digest: v1.digest, version: "1.0.1", permissions: ["chat"], view: "chat" });
    expect(entry.entry).toContain("<p>v1");
    expect(new TextDecoder().decode(await store.file({ ref: v1.ref, path: "data/openings.json" }))).toBe("[]");
    await expect(store.file({ ref: v1.ref, path: "../secret" })).rejects.toThrow(/^no-file/);
  });

  it("a full-screen app says so in its view and its run entry", async () => {
    const full = await bundle({ view: "full", permissions: [] });
    net.put(BUNDLE_URL, full.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    expect(await store.install({ digest: full.digest, grant: [] })).toMatchObject({ view: "full" });
    expect(await store.entry({ ref: full.ref })).toMatchObject({ view: "full" });
    expect(await store.list()).toMatchObject([{ ref: full.ref, view: "full" }]);
  });

  it("refuses an install without every permission granted, and one never previewed", async () => {
    const v1 = await bundle({ permissions: ["chat", "name"] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^permissions/);
    await expect(store.install({ digest: "x".repeat(43), grant: [] })).rejects.toThrow(/^expired/);
    expect(await appRows()).toEqual([]);
  });

  it("refuses a bundle that does not verify, with the reader's refusal, and keeps nothing", async () => {
    const v1 = await bundle();
    const broken = v1.bytes.slice();
    broken[broken.length - 1] ^= 1;
    net.put(BUNDLE_URL, broken);
    await expect(apps(net).preview({ url: BUNDLE_URL })).rejects.toThrow(/^file-hash/);
    net.put(BUNDLE_URL, new Uint8Array([...v1.bytes, 0]));
    await expect(apps(net).preview({ url: BUNDLE_URL })).rejects.toThrow(/^trailing-bytes/);
    expect(await bundleIds()).toEqual([]);
  });

  it("a card's pointer is fetched only from the allowed hosts, and must hold its app at its number or newer", async () => {
    const v2 = await bundle({ sequence: 2 });
    net.put(PINNED_URL, v2.bytes);
    const store = apps(net);
    await expect(store.preview({ card: { ref: v2.ref, url: "https://evil.example/app.ghostlyapp" } })).rejects.toThrow(/^host/);
    await expect(store.preview({ card: { ref: v2.ref, url: "https://cdn.jsdelivr.net/gh/ana/chess@main/app.ghostlyapp" } })).rejects.toThrow(/^host/);
    expect(net.requests).toEqual([]);
    await expect(store.preview({ card: { ref: v2.ref, url: PINNED_URL, sequence: 3 } })).rejects.toThrow(/^rollback/);
    await expect(store.preview({ card: { ref: v2.ref, url: PINNED_URL, sequence: 2, digest: "A".repeat(43) } })).rejects.toThrow(/^equivocation/);
    await expect(store.preview({ card: { ref: `${keyOf(signer("other"))}/chess`, url: PINNED_URL } })).rejects.toThrow(/^other-app/);
    // An older card is fine: the bundle there is newer.
    expect(await store.preview({ card: { ref: v2.ref, url: PINNED_URL, sequence: 1 } })).toMatchObject({ digest: v2.digest, install: "new" });
  });

  it("from a store's listing: its URLs in order, its digest held, and a curated store clears Unknown publisher", async () => {
    const v1 = await bundle();
    net.put(PINNED_URL, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1, ["https://raw.githubusercontent.com/ana/chess/HEAD/gone.ghostlyapp", PINNED_URL])] }));
    const store = apps(net);
    await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
    const preview = await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
    expect(preview).toMatchObject({ digest: v1.digest, from: PINNED_URL, unknownPublisher: false, listedBy: [{ key: keyOf(STORE_KEY), name: "Test store", kind: "curated" }] });
    expect((await store.install({ digest: v1.digest, grant: ["chat"] })).unknownPublisher).toBe(false);
    // An indexed store's listing leaves the warning in place.
    await emptyProfile();
    await net.putStore(await storeFiles({ kind: "indexed", apps: [listing(v1, [PINNED_URL])] }));
    const again = apps(net);
    await again.addStore({ url: STORE_URL });
    expect(await again.preview({ store: keyOf(STORE_KEY), ref: v1.ref })).toMatchObject({ unknownPublisher: true });
  });
});

describe("updates", () => {
  async function installed(options: Parameters<typeof bundle>[0] = {}) {
    const v1 = await bundle(options);
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: v1 && (options.permissions ?? ["chat"]) });
    return { store, v1 };
  }

  it("a newer version a store lists installs by itself when it adds no permission; the old files go", async () => {
    const { store, v1 } = await installed();
    const v2 = await bundle({ sequence: 2, permissions: [] });
    net.put(PINNED_URL, v2.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v2, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.checkUpdates()).toEqual([{ ref: v1.ref, outcome: "updated", run: { status: "ok" } }]);
    // The URL it came from is what an app card sent in a chat names (WISP 405 § An app).
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest, permissions: [], from: PINNED_URL, icon: false });
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
  });

  it("an update that adds a permission waits for the person, who sees only what is new", async () => {
    const { store, v1 } = await installed();
    const v2 = await bundle({ sequence: 2, permissions: ["chat", "name"] });
    net.put(PINNED_URL, v2.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v2, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect((await store.checkUpdates())[0]!.outcome).toBe("ask");
    const waiting = (await store.list())[0]!;
    expect(waiting).toMatchObject({ sequence: 1, digest: v1.digest, permissions: ["chat"], pending: { sequence: 2, added: ["name"] } });
    expect((await store.entry({ ref: v1.ref })).digest, "the installed one still runs").toBe(v1.digest);
    const accepted = await store.acceptUpdate({ ref: v1.ref });
    expect(accepted).toMatchObject({ sequence: 2, digest: v2.digest, permissions: ["chat", "name"] });
    expect(accepted.pending).toBeUndefined();
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
  });

  it("a newer version found at the app's own source, peeked first", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.requests.length = 0;
    net.fetch.mockClear();
    expect((await store.checkUpdates())[0]!.outcome, "nothing newer: only the peek and the revocations are read").toBe("none");
    expect(net.requests).toEqual([BUNDLE_URL, `${REPO}/ghostly-revoke.json`]);
    expect(net.fetch.mock.calls[0]![1]).toMatchObject({ headers: { range: expect.stringMatching(/^bytes=0-\d+$/) } });
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
  });

  it("a lower sequence is never installed over a higher one", async () => {
    const { store } = await installed({ sequence: 3 });
    const old = await bundle({ sequence: 2 });
    net.put(PINNED_URL, old.bytes);
    expect(await store.preview({ url: PINNED_URL })).toMatchObject({ install: "rollback" });
    await expect(store.install({ digest: old.digest, grant: ["chat"] })).rejects.toThrow(/^rollback/);
    expect((await store.list())[0]!.sequence).toBe(3);
  });

  it("the same sequence with another digest is refused and the app marked; the one held is kept", async () => {
    const { store, v1 } = await installed();
    const twin = await bundle({ sequence: 1, entry: "<p>another version 1" });
    net.put(PINNED_URL, twin.bytes);
    expect(await store.preview({ url: PINNED_URL })).toMatchObject({ install: "equivocation" });
    await expect(store.install({ digest: twin.digest, grant: ["chat"] })).rejects.toThrow(/^equivocation: Two different versions 1 exist/);
    expect((await store.list())[0]).toMatchObject({ digest: v1.digest, equivocation: { sequence: 1 } });
    // Found by the update check (a store lists the twin): marked the same way.
    await emptyProfile();
    const again = await installed();
    await net.putStore(await storeFiles({ apps: [listing(twin, [PINNED_URL])] }));
    await again.store.addStore({ url: STORE_URL });
    expect((await again.store.checkUpdates())[0]!.outcome).toBe("equivocation");
    expect((await again.store.list())[0]).toMatchObject({ digest: again.v1.digest, equivocation: { sequence: 1 } });
    // A later version past that number ends the mark.
    const v2 = await bundle({ sequence: 2 });
    net.put(BUNDLE_URL, v2.bytes);
    await again.store.preview({ url: BUNDLE_URL });
    expect((await again.store.install({ digest: v2.digest, grant: ["chat"] })).equivocation).toBeUndefined();
  });

  it("with no app installed the check asks nothing", async () => {
    await net.putStore(await storeFiles());
    expect(await apps(net).checkUpdates()).toEqual([]);
    expect(net.requests).toEqual([]);
  });
});

describe("an app installed from a store updates only to the version that store lists", () => {
  const OTHER_STORE = signer("other store");
  const OTHER_STORE_URL = "https://raw.githubusercontent.com/other/store/HEAD/ghostly-store.json";
  const HEAD = BUNDLE_URL;

  /** v1 installed from the store's listing (read at its pinned URL), with the publisher's HEAD as its `sources`. */
  async function fromStore(options: Parameters<typeof bundle>[0] = {}) {
    const v1 = await bundle({ sources: [HEAD], ...options });
    net.put(PINNED_URL, v1.bytes);
    net.put(HEAD, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1, [PINNED_URL])] }));
    const store = apps(net);
    await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
    await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
    await store.install({ digest: v1.digest, grant: options.permissions ?? ["chat"] });
    return { store, v1 };
  }
  const pinnedTo = async () => ((await appRows()) as { store?: string }[])[0]!.store;

  it("a newer version at the publisher's sources waits until the store lists it, and is not even asked for", async () => {
    const { store, v1 } = await fromStore();
    expect(await pinnedTo()).toBe(keyOf(STORE_KEY));
    const v2 = await bundle({ sequence: 2, sources: [HEAD] });
    net.put(HEAD, v2.bytes);
    net.requests.length = 0;
    expect(await store.checkUpdates()).toEqual([{ ref: v1.ref, outcome: "none", run: { status: "ok" } }]);
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });
    expect(net.requests, "no peek at the sources: only the store and the revocations").not.toContain(HEAD);
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);

    // The store lists it now: it installs by itself, and the next updates still come from that store.
    const pinned2 = `https://cdn.jsdelivr.net/gh/ana/chess@${"b".repeat(40)}/app.ghostlyapp`;
    net.put(pinned2, v2.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [pinned2])] }));
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest, from: pinned2 });
    expect(await pinnedTo()).toBe(keyOf(STORE_KEY));
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
  });

  it("a listing URL that moved on (the repository's HEAD) is skipped for the one holding the listed digest", async () => {
    const { store, v1 } = await fromStore();
    const v2 = await bundle({ sequence: 2, sources: [HEAD] });
    const v3 = await bundle({ sequence: 3, sources: [HEAD] });
    net.put(HEAD, v3.bytes);
    const pinned2 = `https://cdn.jsdelivr.net/gh/ana/chess@${"b".repeat(40)}/app.ghostlyapp`;
    // HEAD alone: it holds 3, the store lists 2, so nothing installs.
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [HEAD])] }));
    expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });
    // HEAD listed first, then the commit the store reviewed: the commit is read first, 2 installs, never 3, and HEAD's
    // bundle is not even downloaded.
    net.put(pinned2, v2.bytes);
    await net.putStore(await storeFiles({ sequence: 3, apps: [listing(v2, [HEAD, pinned2])] }));
    net.requests.length = 0;
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect(net.requests).not.toContain(HEAD);
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest, from: pinned2 });
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
  });

  it("another store's listing of a newer version is not taken; once the person removes the store, the sources count again", async () => {
    const { store, v1 } = await fromStore();
    const v2 = await bundle({ sequence: 2, sources: [HEAD] });
    net.put(PINNED_URL, v1.bytes);
    const pinned2 = `https://cdn.jsdelivr.net/gh/ana/chess@${"b".repeat(40)}/app.ghostlyapp`;
    net.put(pinned2, v2.bytes);
    await net.putStore(await storeFiles({ by: OTHER_STORE, name: "Other store", apps: [listing(v2, [pinned2])] }), OTHER_STORE_URL);
    await store.addStore({ url: OTHER_STORE_URL });
    expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });
    // Its own store removed: the person no longer takes its curation, so the app is not pinned to it any more and takes
    // a valid newer version from its sources and the other stores, as an app added by URL (its security fixes arrive).
    const v3 = await bundle({ sequence: 3, sources: [HEAD] });
    net.put(HEAD, v3.bytes);
    await store.removeStore({ key: keyOf(STORE_KEY) });
    expect(await pinnedTo()).toBeUndefined();
    // Stores first (the other store's 2), then the sources (HEAD's 3) at the next check.
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest, from: pinned2 });
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect((await store.list())[0]).toMatchObject({ sequence: 3, digest: v3.digest, from: HEAD });
    expect(await pinnedTo()).toBeUndefined();
  });

  it("a waiting update the store no longer lists is not installed; the version it lists now is taken instead", async () => {
    const { store, v1 } = await fromStore();
    const v3 = await bundle({ sequence: 3, permissions: ["chat", "name"], sources: [HEAD] });
    const pinned3 = `https://cdn.jsdelivr.net/gh/ana/chess@${"c".repeat(40)}/app.ghostlyapp`;
    net.put(pinned3, v3.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v3, [pinned3])] }));
    expect((await store.checkUpdates())[0]!.outcome).toBe("ask");
    expect((await store.list())[0]!.pending).toMatchObject({ sequence: 3 });

    // The store lists 2 instead (no removal entry for 3): 3 is no longer what it reviewed.
    const v2 = await bundle({ sequence: 2, sources: [HEAD] });
    const pinned2 = `https://cdn.jsdelivr.net/gh/ana/chess@${"b".repeat(40)}/app.ghostlyapp`;
    net.put(pinned2, v2.bytes);
    await net.putStore(await storeFiles({ sequence: 3, apps: [listing(v2, [pinned2])] }));
    await store.refreshStores();
    await expect(store.acceptUpdate({ ref: v1.ref })).rejects.toThrow(/^unlisted/);
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });

    // The next check drops 3 and installs 2, which adds no permission.
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    const view = (await store.list())[0]!;
    expect(view).toMatchObject({ sequence: 2, digest: v2.digest, from: pinned2 });
    expect(view.pending).toBeUndefined();
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
    expect(await pinnedTo()).toBe(keyOf(STORE_KEY));
  });

  it("a restored app installed from a store fetches its files only from that store's listing, never its sources", async () => {
    const { v1 } = await fromStore();
    await (await fileBytes()).remove(`app-${v1.digest}`);
    // The URL it came from is gone; its sources and another store's listing hold that very digest.
    net.files.delete(PINNED_URL);
    net.put(HEAD, v1.bytes);
    const elsewhere = `https://cdn.jsdelivr.net/gh/other/chess@${"d".repeat(40)}/app.ghostlyapp`;
    net.put(elsewhere, v1.bytes);
    await net.putStore(await storeFiles({ by: OTHER_STORE, name: "Other store", apps: [listing(v1, [elsewhere])] }), OTHER_STORE_URL);
    const store = apps(net);
    await store.addStore({ url: OTHER_STORE_URL });
    net.requests.length = 0;
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "needs-files" });
    expect(net.requests).toEqual([PINNED_URL]);
    // Its own store lists that digest at another URL now: the files come from there.
    const moved = `https://cdn.jsdelivr.net/gh/ana/chess@${"e".repeat(40)}/app.ghostlyapp`;
    net.put(moved, v1.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v1, [HEAD, moved])] }));
    await store.refreshStores();
    net.requests.length = 0;
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "ok" });
    expect(net.requests, "the commit-pinned copy first, so HEAD is not read").toEqual([PINNED_URL, moved]);
  });

  it("an update the store lists that adds a permission waits for the person, and stays pinned once accepted", async () => {
    const { store, v1 } = await fromStore();
    const v2 = await bundle({ sequence: 2, permissions: ["chat", "name"], sources: [HEAD] });
    const pinned2 = `https://cdn.jsdelivr.net/gh/ana/chess@${"b".repeat(40)}/app.ghostlyapp`;
    net.put(pinned2, v2.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [pinned2])] }));
    expect((await store.checkUpdates())[0]!.outcome).toBe("ask");
    expect(await store.acceptUpdate({ ref: v1.ref })).toMatchObject({ sequence: 2, permissions: ["chat", "name"] });
    expect(await pinnedTo()).toBe(keyOf(STORE_KEY));
  });

  it("a store's listing that holds the same number under another digest is marked, as from anywhere", async () => {
    const { store, v1 } = await fromStore();
    const twin = await bundle({ sequence: 1, entry: "<p>another version 1", sources: [HEAD] });
    const pinned2 = `https://cdn.jsdelivr.net/gh/ana/chess@${"b".repeat(40)}/app.ghostlyapp`;
    net.put(pinned2, twin.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(twin, [pinned2])] }));
    expect((await store.checkUpdates())[0]!.outcome).toBe("equivocation");
    expect((await store.list())[0]).toMatchObject({ digest: v1.digest, equivocation: { sequence: 1 } });
  });

  it("installing from a store takes only the listed digest: a URL holding a newer one is skipped, none is `unlisted`", async () => {
    const v1 = await bundle({ sources: [HEAD] });
    const v2 = await bundle({ sequence: 2, sources: [HEAD] });
    net.put(HEAD, v2.bytes);
    net.put(PINNED_URL, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1, [HEAD, PINNED_URL])] }));
    const store = apps(net);
    await store.addStore({ url: STORE_URL });
    expect(await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref })).toMatchObject({ digest: v1.digest, from: PINNED_URL });
    net.files.delete(PINNED_URL);
    await expect(store.preview({ store: keyOf(STORE_KEY), ref: v1.ref })).rejects.toThrow(/^status|^unlisted/);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v1, [HEAD])] }));
    await store.refreshStores();
    await expect(store.preview({ store: keyOf(STORE_KEY), ref: v1.ref })).rejects.toThrow(/^unlisted/);
    expect(await appRows()).toEqual([]);
  });

  it("an app added by URL or card is not pinned and keeps taking a newer version from its sources", async () => {
    const v1 = await bundle({ sources: [HEAD] });
    net.put(HEAD, v1.bytes);
    const store = apps(net);
    await store.preview({ url: HEAD });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    expect(await pinnedTo()).toBeUndefined();
    net.put(HEAD, (await bundle({ sequence: 2, sources: [HEAD] })).bytes);
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect(await pinnedTo()).toBeUndefined();
  });

  it("installed again by URL, the pin goes; installed from a store, a version waiting from the sources goes", async () => {
    // From a store, then a newer version by URL: the person chose that source, so its sources count again.
    const { store, v1 } = await fromStore();
    const v2 = await bundle({ sequence: 2, sources: [HEAD] });
    net.put(HEAD, v2.bytes);
    await store.preview({ url: HEAD });
    await store.install({ digest: v2.digest, grant: ["chat"] });
    expect(await pinnedTo()).toBeUndefined();
    net.put(HEAD, (await bundle({ sequence: 3, sources: [HEAD] })).bytes);
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect((await store.list())[0]!.sequence).toBe(3);
    expect(v1.sequence).toBe(1);

    // By URL with a newer version waiting (it adds a permission), then installed from a store: the waiting one goes.
    await emptyProfile();
    const u1 = await bundle({ sources: [HEAD] });
    net.put(HEAD, u1.bytes);
    const again = apps(net);
    await again.preview({ url: HEAD });
    await again.install({ digest: u1.digest, grant: ["chat"] });
    const u3 = await bundle({ sequence: 3, permissions: ["chat", "name"], sources: [HEAD] });
    net.put(HEAD, u3.bytes);
    expect((await again.checkUpdates())[0]!.outcome).toBe("ask");
    const u2 = await bundle({ sequence: 2, sources: [HEAD] });
    net.put(PINNED_URL, u2.bytes);
    await net.putStore(await storeFiles({ apps: [listing(u2, [PINNED_URL])] }));
    await again.addStore({ url: STORE_URL });
    await again.preview({ store: keyOf(STORE_KEY), ref: u2.ref });
    const view = await again.install({ digest: u2.digest, grant: ["chat"] });
    expect(view).toMatchObject({ sequence: 2, digest: u2.digest });
    expect(view.pending).toBeUndefined();
    expect(await pinnedTo()).toBe(keyOf(STORE_KEY));
    expect(await bundleIds()).toEqual([`app-${u2.digest}`]);
    await expect(again.acceptUpdate({ ref: u2.ref })).rejects.toThrow(/^no-update/);
  });

  it("the version installed, taken again from a store's listing, pins it to that store", async () => {
    const u1 = await bundle({ sources: [HEAD] });
    net.put(HEAD, u1.bytes);
    const store = apps(net);
    await store.preview({ url: HEAD });
    await store.install({ digest: u1.digest, grant: ["chat"] });
    const u3 = await bundle({ sequence: 3, permissions: ["chat", "name"], sources: [HEAD] });
    net.put(HEAD, u3.bytes);
    expect((await store.checkUpdates())[0]!.outcome).toBe("ask");
    net.put(PINNED_URL, u1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(u1, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.preview({ store: keyOf(STORE_KEY), ref: u1.ref })).toMatchObject({ install: "same" });
    const view = await store.install({ digest: u1.digest, grant: ["chat"] });
    expect(view).toMatchObject({ sequence: 1, digest: u1.digest });
    expect(view.pending, "the version waiting from the sources goes").toBeUndefined();
    expect(await pinnedTo()).toBe(keyOf(STORE_KEY));
    expect(await bundleIds()).toEqual([`app-${u1.digest}`]);
    expect((await store.checkUpdates())[0]!.outcome, "HEAD's 3 is not listed").toBe("none");
    // The same version by URL again leaves the pin.
    net.put(HEAD, u1.bytes);
    await store.preview({ url: HEAD });
    await store.install({ digest: u1.digest, grant: ["chat"] });
    expect(await pinnedTo()).toBe(keyOf(STORE_KEY));
  });
});

describe("before a run", () => {
  it("a publisher's revocation stops the app with no Run anyway, from a store or beside its source", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest])]));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.entry({ ref: v1.ref, runAnyway: true })).rejects.toThrow(/^revoked/);
    await expect(store.file({ ref: v1.ref, path: "index.html" })).rejects.toThrow(/^stopped/);
  });

  it("a revocation by another key is not taken", async () => {
    const v1 = await bundle();
    const other = await bundle({ by: signer("other") });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // A store copies a revocation of another app verbatim: it names that app, so it does not touch this one.
    await net.putStore(await storeFiles({ revoked: [await (await import("@ghostly/core")).signAppRevocation({ ghostlyRevoke: 1, app: other.ref, upTo: 9 }, signer("other"))] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
  });

  it("a store's removal warns: the app runs only with Run anyway, and is not installable", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await net.putStore(await storeFiles({ removed: [{ ref: v1.ref, digest: v1.digest, reason: "Malware", at: NOW_MS / 1000 }] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.runCheck({ ref: v1.ref })).toMatchObject({ status: "removed", by: [{ name: "Test store", reason: "Malware" }] });
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^removed: Removed by Test store: Malware/);
    expect((await store.entry({ ref: v1.ref, runAnyway: true })).digest).toBe(v1.digest);
    await store.uninstall({ ref: v1.ref });
    await store.preview({ url: BUNDLE_URL });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^removed/);
  });

  it("stored files that no longer match are not run", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const files = await fileBytes();
    const id = `app-${v1.digest}`;
    const bytes = await files.read(id, 0, v1.bytes.length);
    bytes[bytes.length - 1] ^= 1;
    await files.remove(id);
    await files.append(id, 0, bytes);
    await files.flush(id);
    await expect(apps(net).entry({ ref: v1.ref })).rejects.toThrow(/^damaged/);
  });
});

describe("a browser that keeps no app files (Safari's Private Browsing)", () => {
  it("install fails as `storage`, with the browser's words kept after it, and keeps nothing", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    privateBrowsing();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^storage: .*UnknownError: Error preparing Blob\/File data/);
    expect(warn).toHaveBeenCalledWith("[apps] storage:", expect.stringContaining("Error preparing Blob/File data"));
    vi.restoreAllMocks();
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
  });

  it("fetching a restored app's files again fails as `storage` too, not as missing files", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await (await fileBytes()).remove(`app-${v1.digest}`);
    privateBrowsing();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(apps(net).fetchFiles({ ref: v1.ref })).rejects.toThrow(/^storage: /);
    await expect(apps(net).entry({ ref: v1.ref })).rejects.toThrow(/^storage: /);
    vi.restoreAllMocks();
    expect(await bundleIds()).toEqual([]);
    expect(await apps(net).runCheck({ ref: v1.ref })).toEqual({ status: "needs-files" });
  });
});

describe("a restored profile (installed list, no bundle)", () => {
  async function restored() {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await (await fileBytes()).remove(`app-${v1.digest}`);
    net.requests.length = 0;
    return { v1, store: apps(net) };
  }

  it("says the files are missing, and fetches them again by digest on the first open", async () => {
    const { v1, store } = await restored();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "needs-files" });
    expect((await store.list())[0]!.run).toEqual({ status: "needs-files" });
    expect(net.requests, "listing and checking ask nothing").toEqual([]);
    const entry = await store.entry({ ref: v1.ref });
    expect(entry.digest).toBe(v1.digest);
    expect(net.requests).toEqual([BUNDLE_URL]);
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
  });

  it("takes only the installed digest: another version at the URL leaves it needing its files, never run unchecked", async () => {
    const { v1, store } = await restored();
    net.put(BUNDLE_URL, (await bundle({ sequence: 2 })).bytes);
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "needs-files" });
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^needs-files/);
    net.files.delete(BUNDLE_URL);
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^needs-files/);
    expect(await bundleIds()).toEqual([]);
  });

  it("a store listing of that digest is a source too, and so is installing the same version again", async () => {
    const { v1, store } = await restored();
    net.files.delete(BUNDLE_URL);
    net.put(PINNED_URL, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "ok" });

    await (await fileBytes()).remove(`app-${v1.digest}`);
    await store.preview({ url: PINNED_URL });
    expect(await store.install({ digest: v1.digest, grant: ["chat"] })).toMatchObject({ run: { status: "ok" } });
  });
});

it("the publisher is shown by its fingerprint: 16 z-base32 characters in four groups", async () => {
  const v1 = await bundle();
  net.put(BUNDLE_URL, v1.bytes);
  const preview = await apps(net).preview({ url: BUNDLE_URL });
  expect(preview.fingerprint).toBe(keyOf(PUBLISHER).slice(0, 16).match(/.{4}/g)!.join(" "));
});

describe("while it runs (WISP 1200 § Takedowns: the app is stopped)", () => {
  // The update check found a version removed or revoked while the app was already running: the page may never stop
  // it (a frame left open, a check the page did not ask for), so the engine cuts it off. Before, a running app kept
  // reading and writing its storage, and its files, after "Stopped" showed on the Apps page.
  async function running() {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await store.entry({ ref: v1.ref });
    await store.storageSet({ ref: v1.ref, scope: "chat-1", key: "game", value: [1] });
    return { v1, store };
  }
  const cutOff = async (store: Awaited<ReturnType<typeof running>>["store"], ref: string) => {
    await expect(store.storageGet({ ref, scope: "chat-1", key: "game" })).rejects.toThrow(/^stopped: /);
    await expect(store.storageSet({ ref, scope: "chat-1", key: "game", value: [2] })).rejects.toThrow(/^stopped: /);
    await expect(store.storageDelete({ ref, scope: "chat-1", key: "game" })).rejects.toThrow(/^stopped: /);
    await expect(store.storageKeys({ ref, scope: "chat-1" })).rejects.toThrow(/^stopped: /);
    await expect(store.file({ ref, path: "index.html" })).rejects.toThrow(/^stopped: /);
    await expect(store.chatRunnable({ ref })).rejects.toThrow(/^stopped: /);
  };

  it("a store's removal cuts a running app off: storage, files and chat refuse with `stopped`; its data still exports", async () => {
    const { v1, store } = await running();
    await net.putStore(await storeFiles({ removed: [{ ref: v1.ref, digest: v1.digest, reason: "Malware", at: NOW_MS / 1000 }] }));
    await store.addStore({ url: STORE_URL });
    await cutOff(store, v1.ref);
    // Its icon is still read for the Apps page (this bundle has none: "no-file", not "stopped").
    await expect(store.file({ ref: v1.ref, path: "icon.png" })).rejects.toThrow(/^no-file/);
    expect(await store.exportData({ ref: v1.ref })).toEqual([{ ghostlyAppData: 1, app: v1.ref, scope: "chat-1", entries: { game: [1] } }]);
  });

  it("a run the person started with Run anyway keeps going after the removal", async () => {
    const { v1, store } = await running();
    await net.putStore(await storeFiles({ removed: [{ ref: v1.ref, digest: v1.digest, reason: "Malware", at: NOW_MS / 1000 }] }));
    await store.addStore({ url: STORE_URL });
    await store.entry({ ref: v1.ref, runAnyway: true });
    await store.storageSet({ ref: v1.ref, scope: "chat-1", key: "game", value: [2] });
    expect(await store.storageGet({ ref: v1.ref, scope: "chat-1", key: "game" })).toEqual({ value: [2] });
    await store.chatRunnable({ ref: v1.ref });
  });

  it("a publisher's revocation cuts it off, Run anyway or not", async () => {
    const { v1, store } = await running();
    await net.putStore(await storeFiles({ removed: [{ ref: v1.ref, digest: v1.digest, reason: "Malware", at: NOW_MS / 1000 }] }));
    await store.addStore({ url: STORE_URL });
    await store.entry({ ref: v1.ref, runAnyway: true });
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest])]));
    await store.checkUpdates();
    await cutOff(store, v1.ref);
  });

  it("an app that is not installed here (a bot's reference) is not refused for chat", async () => {
    const store = apps(net);
    await store.chatRunnable({ ref: `${keyOf(PUBLISHER)}/other` });
  });

  it("every update check is told to the host, so the pages read the apps again", async () => {
    const checked = vi.fn();
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { checked });
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await store.checkUpdates();
    expect(checked).toHaveBeenCalledTimes(1);
  });
});
