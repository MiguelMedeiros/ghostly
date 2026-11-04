import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_URL, FakeNet, REPO, SIG_URL, STORE_URL, apps, bundle, emptyProfile, keyOf, listing, STORE_KEY, storeFiles } from "./appsSupport";
// covers: apps.engine.network

/*
 * The files every update check reads again (each Apps page visit, at start, every 24 hours): a store's index and its
 * `.sig`, and an app's `ghostly-revoke.json`. They are asked with the host's ETag (`no-cache`), so one that has not
 * changed comes back as an empty 304 instead of its whole bytes. A bundle is read once and kept in file storage, and a
 * peek is a range: those are not kept by the browser (`no-store`).
 */

beforeEach(async () => { await emptyProfile(); });

/** The cache mode of each request, by URL. */
function modes(net: FakeNet): Map<string, (RequestCache | undefined)[]> {
  const out = new Map<string, (RequestCache | undefined)[]>();
  for (const [url, init] of net.fetch.mock.calls as [string, RequestInit | undefined][]) out.set(String(url), [...out.get(String(url)) ?? [], init?.cache]);
  return out;
}

describe("reads an update check makes again", () => {
  it("ask the host whether the store's index, its sig and the app's revocations changed, and keep bundles out of the browser's cache", async () => {
    const app = await bundle();
    const net = new FakeNet();
    net.put(BUNDLE_URL, app.bytes);
    await net.putStore(await storeFiles({ apps: [listing(app)] }));
    const a = apps(net);
    await a.addStore({ url: STORE_URL });
    const preview = await a.preview({ store: keyOf(STORE_KEY), ref: app.ref });
    await a.install({ digest: preview.digest, grant: ["chat"] });
    expect(modes(net).get(BUNDLE_URL)).toEqual(["no-store"]);

    net.fetch.mockClear();
    await a.checkUpdates();
    const asked = modes(net);
    expect(asked.get(STORE_URL)).toEqual(["no-cache"]);
    expect(asked.get(SIG_URL)).toEqual(["no-cache"]);
    expect(asked.get(`${REPO}/ghostly-revoke.json`)).toEqual(["no-cache"]);
  });

  it("a source's peek and a newer bundle read whole stay out of the browser's cache", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    const net = new FakeNet();
    net.put(BUNDLE_URL, v1.bytes);
    const a = apps(net);
    const preview = await a.preview({ url: BUNDLE_URL });
    await a.install({ digest: preview.digest, grant: ["chat"] });
    net.put(BUNDLE_URL, (await bundle({ sequence: 2, sources: [BUNDLE_URL] })).bytes);

    net.fetch.mockClear();
    expect(await a.checkUpdates()).toMatchObject([{ outcome: "updated" }]);
    // The peek, then the whole bundle.
    expect(modes(net).get(BUNDLE_URL)).toEqual(["no-store", "no-store"]);
    expect(modes(net).get(`${REPO}/ghostly-revoke.json`)).toEqual(["no-cache"]);
  });
});
