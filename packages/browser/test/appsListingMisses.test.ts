import "fake-indexeddb/auto";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, utf8Encode } from "@ghostly/core";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_URL, FakeNet, NOW_MS, PINNED_URL, STORE_KEY, STORE_URL, apps, bundle, emptyProfile, keyOf, listing, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * The update check keeps the listing URLs whose peek showed nothing to take, so the same index is not peeked again at
 * every check. A store that lists new URLs at each index (a query a host ignores is enough) would grow that for as
 * long as the engine runs: only the ones the last check read or wrote stay, and a removed store's go. A miss on a link
 * that can change (a raw HEAD a CDN still served at the old version) lasts an hour; one pinned to a commit lasts.
 */

const MIRROR = "https://raw.githubusercontent.com/mirror/chess/HEAD/app.ghostlyapp";

beforeEach(emptyProfile);

describe("listing URLs peeked with nothing to take", () => {
  it("are only the last index's while a store lists new URLs at each index, and go with the store", async () => {
    const net = new FakeNet();
    const store = apps(net);
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await net.putStore(await storeFiles({ kind: "indexed" }));
    await store.addStore({ url: STORE_URL });
    const misses = (store as unknown as { listingMisses: Map<string, unknown> }).listingMisses;
    // A listing of a newer version than any of its URLs holds: each URL peeks as the version installed.
    const lie = (urls: string[]) => ({ ...listing(v1, urls), sequence: 99, digest: toBase64Url(sha256(utf8Encode("no bundle has this"))) });
    for (let index = 0; index < 300; index++) {
      const urls = [0, 1, 2, 3].map((n) => `${MIRROR}?i=${index}-${n}`);
      for (const url of urls) net.put(url, v1.bytes);
      await net.putStore(await storeFiles({ kind: "indexed", sequence: index + 2, apps: [lie(urls)] }));
      expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    }
    expect([...misses.keys()].map((missed) => missed.split(" ")[2])).toEqual([0, 1, 2, 3].map((n) => `${MIRROR}?i=299-${n}`));
    // The last index's URLs are not peeked again.
    net.requests.length = 0;
    await store.checkUpdates();
    expect(net.requests.filter((url) => url.startsWith(MIRROR))).toEqual([]);

    await store.removeStore({ key: keyOf(STORE_KEY) });
    expect(misses.size).toBe(0);
  }, 60_000);

  it("are all kept while the same index lists them, however many installed apps it lists", async () => {
    const net = new FakeNet();
    const store = apps(net);
    // 300 apps installed by link, each listed at a newer version on 4 URLs that hold only the one installed: 1,200.
    const lies = [];
    for (let i = 0; i < 300; i++) {
      const b = await bundle({ name: `app${i}` });
      const url = `https://raw.githubusercontent.com/ana/app${i}/HEAD/app.ghostlyapp`;
      net.put(url, b.bytes);
      await store.preview({ url });
      await store.install({ digest: b.digest, grant: ["chat"] });
      const urls = [0, 1, 2, 3].map((n) => `https://raw.githubusercontent.com/mirror${n}/app${i}/HEAD/app.ghostlyapp`);
      for (const u of urls) net.put(u, b.bytes);
      lies.push({ ...listing(b, urls), sequence: 99, digest: toBase64Url(sha256(utf8Encode(`no bundle ${i}`))) });
    }
    await net.putStore(await storeFiles({ kind: "indexed", apps: lies }));
    await store.addStore({ url: STORE_URL });
    await store.checkUpdates();
    expect(net.requests.filter((url) => url.includes("/mirror"))).toHaveLength(1200);
    net.requests.length = 0;
    await store.checkUpdates();
    expect(net.requests.filter((url) => url.includes("/mirror")).length).toBe(0);
  }, 60_000);
});

describe("a listing URL peeked with nothing to take, then given the listed version", () => {
  const MIN = 60 * 1000;
  const clocked = (net: FakeNet) => {
    const clock = { now: NOW_MS };
    return { clock, store: apps(net, { now: () => clock.now }) };
  };
  /** One check at `at` minutes after the first: its outcome, and how often it asked `url`. */
  const checkAt = async (store: ReturnType<typeof apps>, clock: { now: number }, net: FakeNet, at: number, url: string) => {
    clock.now = NOW_MS + at * MIN;
    net.requests.length = 0;
    const outcome = (await store.checkUpdates())[0]!.outcome;
    return { outcome, asked: net.requests.filter((u) => u === url).length };
  };

  it("is peeked again after the hour when it can change: a raw HEAD that lagged behind the store's index catches up", async () => {
    const net = new FakeNet();
    const { clock, store } = clocked(net);
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1)] }));
    await store.addStore({ url: STORE_URL });
    await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // The store signs index 2 listing v2 at the same HEAD link, which still serves v1 for a few minutes (a CDN cache).
    const v2 = await bundle({ sequence: 2 });
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2)] }));
    expect((await checkAt(store, clock, net, 0, BUNDLE_URL)).outcome).toBe("none");
    net.put(BUNDLE_URL, v2.bytes);
    // Within the hour the miss holds: an Apps page opened again does not peek it.
    expect(await checkAt(store, clock, net, 5, BUNDLE_URL)).toEqual({ outcome: "none", asked: 0 });
    expect(await checkAt(store, clock, net, 59, BUNDLE_URL)).toEqual({ outcome: "none", asked: 0 });
    // Past it, one peek and one whole read take the listed version.
    expect(await checkAt(store, clock, net, 120, BUNDLE_URL)).toEqual({ outcome: "updated", asked: 2 });
    expect((await store.list()).find((a) => a.ref === v1.ref)?.sequence).toBe(2);
  }, 30_000);

  it("is peeked again after the hour for an app installed by link, at a mirror not among its sources", async () => {
    const net = new FakeNet();
    const { clock, store } = clocked(net);
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const v2 = await bundle({ sequence: 2 });
    net.put(MIRROR, v1.bytes);
    await net.putStore(await storeFiles({ kind: "indexed", apps: [listing(v2, [MIRROR])] }));
    await store.addStore({ url: STORE_URL });
    expect((await checkAt(store, clock, net, 0, MIRROR)).outcome).toBe("none");
    net.put(MIRROR, v2.bytes);
    expect(await checkAt(store, clock, net, 30, MIRROR)).toEqual({ outcome: "none", asked: 0 });
    expect(await checkAt(store, clock, net, 120, MIRROR)).toEqual({ outcome: "updated", asked: 2 });
  }, 30_000);

  it("is peeked again once an hour while it still shows nothing to take, not at every check", async () => {
    const net = new FakeNet();
    const { clock, store } = clocked(net);
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.put(MIRROR, v1.bytes);
    await net.putStore(await storeFiles({ kind: "indexed", apps: [listing(await bundle({ sequence: 2 }), [MIRROR])] }));
    await store.addStore({ url: STORE_URL });
    const asked = [];
    for (const at of [0, 10, 50, 70, 100, 140]) asked.push((await checkAt(store, clock, net, at, MIRROR)).asked);
    // Peeked at 0, missed until 60, peeked at 70 (a new hour from there), at 140 again.
    expect(asked).toEqual([1, 0, 0, 1, 0, 1]);
  }, 30_000);

  it("is not peeked again when it is pinned to a commit: those bytes never change", async () => {
    const net = new FakeNet();
    const { clock, store } = clocked(net);
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // A listing that names a version its pinned link does not hold.
    net.put(PINNED_URL, v1.bytes);
    const lie = { ...listing(v1, [PINNED_URL]), sequence: 99, digest: toBase64Url(sha256(utf8Encode("no bundle has this"))) };
    await net.putStore(await storeFiles({ kind: "indexed", apps: [lie] }));
    await store.addStore({ url: STORE_URL });
    expect(await checkAt(store, clock, net, 0, PINNED_URL)).toEqual({ outcome: "none", asked: 1 });
    expect(await checkAt(store, clock, net, 120, PINNED_URL)).toEqual({ outcome: "none", asked: 0 });
    expect(await checkAt(store, clock, net, 25 * 60, PINNED_URL)).toEqual({ outcome: "none", asked: 0 });
  }, 30_000);
});
