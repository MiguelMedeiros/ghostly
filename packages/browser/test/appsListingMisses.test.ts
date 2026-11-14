import "fake-indexeddb/auto";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, utf8Encode } from "@ghostly/core";
import { beforeEach, describe, expect, it } from "vitest";
import { LISTING_MISSES_KEPT } from "../src/engine/apps";
import { BUNDLE_URL, FakeNet, STORE_KEY, STORE_URL, apps, bundle, emptyProfile, keyOf, listing, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * The update check keeps the listing URLs whose peek showed nothing to take, so the same index is not peeked again at
 * every check. A store that lists new URLs at each index (a query a host ignores is enough) would grow that for as
 * long as the engine runs: it is kept to `LISTING_MISSES_KEPT`, and a removed store's go.
 */

const MIRROR = "https://raw.githubusercontent.com/mirror/chess/HEAD/app.ghostlyapp";

beforeEach(emptyProfile);

describe("listing URLs peeked with nothing to take", () => {
  it("stay at most LISTING_MISSES_KEPT while a store lists new URLs at each index, and go with the store", async () => {
    const net = new FakeNet();
    const store = apps(net);
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await net.putStore(await storeFiles({ kind: "indexed" }));
    await store.addStore({ url: STORE_URL });
    const misses = (store as unknown as { listingMisses: Map<string, string> }).listingMisses;
    // A listing of a newer version than any of its URLs holds: each URL peeks as the version installed.
    const lie = (urls: string[]) => ({ ...listing(v1, urls), sequence: 99, digest: toBase64Url(sha256(utf8Encode("no bundle has this"))) });
    const checks = Math.ceil(LISTING_MISSES_KEPT / 4) + 8;
    for (let index = 0; index < checks; index++) {
      const urls = [0, 1, 2, 3].map((n) => `${MIRROR}?i=${index}-${n}`);
      for (const url of urls) net.put(url, v1.bytes);
      await net.putStore(await storeFiles({ kind: "indexed", sequence: index + 2, apps: [lie(urls)] }));
      expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    }
    expect(misses.size).toBe(LISTING_MISSES_KEPT);
    // The newest are the ones kept: the last index's URLs are not peeked again.
    net.requests.length = 0;
    await store.checkUpdates();
    expect(net.requests.filter((url) => url.startsWith(MIRROR))).toEqual([]);

    await store.removeStore({ key: keyOf(STORE_KEY) });
    expect(misses.size).toBe(0);
  }, 60_000);
});
