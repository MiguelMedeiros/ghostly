import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLE_URL, FakeNet, PINNED_URL, STORE_URL, apps, appRows, bundle, bundleIds, emptyProfile, listing, storeFiles } from "./appsSupport";
import { APP_BUNDLES_KEY, type Apps } from "../src/engine/apps";
import { PROFILE_SETTINGS_KEYS } from "../src/shared/idb";
// covers: apps.engine.installed

/*
 * A bundle is written or removed in a step of its own beside the app's record: a page or daemon gone between the two
 * (a reload, a closed tab) leaves a bundle no record names. The next start removes it, and never a bundle an install or
 * check under way still needs.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});
afterEach(() => { vi.restoreAllMocks(); });

/** The page goes away at this step of the engine: it never ends, and nothing after it runs. */
const goneAt = (store: Apps, step: "putAppIfUnchanged" | "removeBundle") =>
  vi.spyOn(store as unknown as Record<string, () => Promise<unknown>>, step).mockImplementation(() => new Promise(() => {}));

async function installed(permissions = ["chat"]) {
  const v1 = await bundle({ permissions });
  net.put(BUNDLE_URL, v1.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: v1.digest, grant: permissions });
  return { store, v1 };
}

/** The page opened again: a new engine on the same profile, started. */
async function reopened(): Promise<Apps> {
  const store = apps(net);
  await store.start();
  store.stop();
  return store;
}

describe("a bundle no record names is removed at the next start", () => {
  it("an install cut short between its bundle and its record", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    goneAt(store, "putAppIfUnchanged");
    void store.install({ digest: v1.digest, grant: ["chat"] });
    await vi.waitFor(async () => expect(await bundleIds()).toEqual([`app-${v1.digest}`]));
    await reopened();
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
  });

  it("an uninstall cut short after its record went, before its bundle did", async () => {
    const { store, v1 } = await installed();
    goneAt(store, "removeBundle");
    void store.uninstall({ ref: v1.ref });
    await vi.waitFor(async () => expect(await appRows()).toEqual([]));
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
    await reopened();
    expect(await bundleIds()).toEqual([]);
  });

  it("an update the check wrote before its record, and an accepted update's old version", async () => {
    const { store, v1 } = await installed();
    const v2 = await bundle({ sequence: 2, permissions: [] });
    net.put(PINNED_URL, v2.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v2, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    goneAt(store, "putAppIfUnchanged");
    void store.checkUpdates();
    await vi.waitFor(async () => expect(await bundleIds()).toEqual([`app-${v1.digest}`, `app-${v2.digest}`].sort()));
    await reopened();
    expect(await bundleIds(), "the installed version stays").toEqual([`app-${v1.digest}`]);

    const v3 = await bundle({ sequence: 3, permissions: ["chat", "name"] });
    net.put(PINNED_URL, v3.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v3, [PINNED_URL])] }));
    const again = apps(net);
    expect((await again.checkUpdates())[0]!.outcome).toBe("ask");
    goneAt(again, "removeBundle");
    void again.acceptUpdate({ ref: v1.ref });
    await vi.waitFor(async () => expect(await appRows()).toMatchObject([{ digest: v3.digest }]));
    expect(await bundleIds()).toEqual([`app-${v1.digest}`, `app-${v3.digest}`].sort());
    await reopened();
    expect(await bundleIds(), "the accepted version stays").toEqual([`app-${v3.digest}`]);
    expect(await (await reopened()).entry({ ref: v1.ref })).toMatchObject({ digest: v3.digest });
  });

  it("an install under way when the engine starts keeps its bundle", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    const engine = store as unknown as { putAppIfUnchanged: (...args: unknown[]) => Promise<boolean> };
    const put = engine.putAppIfUnchanged.bind(store);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(engine, "putAppIfUnchanged").mockImplementation(async (...args: unknown[]) => { await held; return put(...args); });
    const install = store.install({ digest: v1.digest, grant: ["chat"] });
    await vi.waitFor(async () => expect(await bundleIds()).toEqual([`app-${v1.digest}`]));
    await store.start();
    store.stop();
    release();
    await install;
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
    expect(await store.entry({ ref: v1.ref })).toMatchObject({ digest: v1.digest });
  });

  it("the digests noted are the profile's: Clear all data drops them", () => {
    expect(PROFILE_SETTINGS_KEYS).toContain(APP_BUNDLES_KEY);
  });
});
