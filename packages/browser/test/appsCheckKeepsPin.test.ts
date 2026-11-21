import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_URL, FakeNet, PINNED_URL, STORE_KEY, STORE_URL, apps, appRows, bundle, emptyProfile, keyOf, listing, storeFiles } from "./appsSupport";
import type { InstalledApp } from "../src/engine/apps";
// covers: apps.engine.installed

/*
 * The same version installed from a store's listing while an update check runs pins the app to that store (WISP 1200
 * § Updates and rollback): the check, once it ends, does not write the record back without the pin, nor install a
 * version from the publisher's sources the store does not list.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** The next request for `url` (a whole read when `whole`) waits until `release` is called; `asked` resolves once made. */
function hold(url: string, whole = false): { asked: Promise<void>; release: () => void } {
  const real = net.fetch.getMockImplementation()!;
  let release!: () => void;
  let asked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { asked = resolve; });
  let held = false;
  net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!held && String(input) === url && !(whole && ((init?.headers ?? {}) as Record<string, string>).range)) {
      held = true;
      asked();
      await gate;
    }
    return real(input, init);
  });
  return { asked: seen, release };
}

/** v1 installed by URL (its sources: that URL); a store the person added lists v1 at another URL. */
async function installed() {
  const v1 = await bundle({ sources: [BUNDLE_URL] });
  net.put(BUNDLE_URL, v1.bytes);
  net.put(PINNED_URL, v1.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  await net.putStore(await storeFiles({ apps: [listing(v1, [PINNED_URL])] }));
  await store.addStore({ url: STORE_URL });
  return { v1, store };
}

/** The same version installed from the store's listing: the pin. */
async function pin(store: ReturnType<typeof apps>, v1: { ref: string; digest: string }) {
  await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
  await store.install({ digest: v1.digest, grant: ["chat"] });
}

const record = async () => (await appRows())[0] as InstalledApp;

describe("a store pin made while the update check runs", () => {
  it("is kept by the check's write, and the next check takes nothing from the sources", async () => {
    const { v1, store } = await installed();
    const held = hold(BUNDLE_URL);
    const check = store.checkUpdates();
    await held.asked;
    await pin(store, v1);
    expect((await record()).store).toBe(keyOf(STORE_KEY));
    held.release();
    await check;
    expect((await record()).store).toBe(keyOf(STORE_KEY));

    net.put(BUNDLE_URL, (await bundle({ sequence: 2, sources: [BUNDLE_URL] })).bytes);
    expect((await store.checkUpdates())[0]?.outcome).toBe("none");
    expect((await record()).sequence).toBe(1);
  });

  it("stops the check from installing a version from the sources the store does not list", async () => {
    const { v1, store } = await installed();
    net.put(BUNDLE_URL, (await bundle({ sequence: 2, sources: [BUNDLE_URL] })).bytes);
    const held = hold(BUNDLE_URL, true);
    const check = store.checkUpdates();
    await held.asked;
    await pin(store, v1);
    held.release();
    await check;
    const now = await record();
    expect(now.store).toBe(keyOf(STORE_KEY));
    expect(now.sequence).toBe(1);
  });
});
