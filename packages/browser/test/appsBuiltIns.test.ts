import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_APPS, type BuiltInApp } from "../src/engine/appDefaults";
import { BUILT_IN_APPS_KEY, builtInsDue } from "../src/engine/apps";
import { snapshotDatabase } from "../src/backup/database";
import { PROFILE_SETTINGS_KEYS, STORES, clearProfileStores, databaseName, store, wrap } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, NOW_MS, PUBLISHER, appRows, apps, bundle, bundleIds, emptyProfile, keyOf, signer, storageRows } from "./appsSupport";
// covers: apps.engine.built-in

/*
 * The apps that come with Ghostly (WISP 1200 § Built-in apps): offered while neither installed nor removed, with
 * nothing stored, nothing granted and no request; removing one sticks across restarts and updates of the list; an
 * install by the person makes it theirs again.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

const DIGEST = "A".repeat(43);
const chess = (digest = DIGEST): BuiltInApp => ({ publisher: keyOf(PUBLISHER), name: "chess", digest, url: BUNDLE_URL });
const REF = `${keyOf(PUBLISHER)}/chess`;
const marks = async () => wrap((await store(STORES.settings, "readonly")).get(BUILT_IN_APPS_KEY));

describe("the list", () => {
  it("holds no app until a build carries its bundle", () => {
    expect(BUILT_IN_APPS).toEqual([]);
  });

  it("offers each whole entry once, unless it is installed or the person removed it", () => {
    const other: BuiltInApp = { publisher: keyOf(signer("other publisher")), name: "notes", digest: DIGEST, url: BUNDLE_URL };
    const otherRef = `${other.publisher}/notes`;
    const none = { removed: {} };
    expect(builtInsDue([chess(), other, chess("B".repeat(43))], new Set(), none)).toEqual([chess(), other]);
    expect(builtInsDue([chess(), other], new Set([REF]), none)).toEqual([other]);
    expect(builtInsDue([chess(), other], new Set(), { removed: { [otherRef]: NOW_MS } })).toEqual([chess()]);
    expect(builtInsDue([chess(), other], new Set([REF]), { removed: { [otherRef]: NOW_MS } })).toEqual([]);
  });

  it("skips an entry that is not a whole one", () => {
    for (const bad of [
      { ...chess(), publisher: "not a key" },
      { ...chess(), name: "Not A Name" },
      { ...chess(), digest: "short" },
      { ...chess(), url: "https://example.com/app.ghostlyapp" },
      { ...chess(), url: "/apps/chess.ghostlyapp" },
    ]) expect(builtInsDue([bad], new Set(), { removed: {} }), JSON.stringify(bad)).toEqual([]);
  });
});

describe("offered, not installed", () => {
  it("a start stores nothing, grants nothing and asks the network for nothing", async () => {
    const store = apps(net, { builtIns: [chess()] });
    await store.start();
    expect(await store.builtIns()).toEqual([{ ref: REF, publisher: keyOf(PUBLISHER), name: "chess", fingerprint: expect.stringMatching(/^(\w{4} ){3}\w{4}$/), digest: DIGEST, url: BUNDLE_URL }]);
    expect(await store.list()).toEqual([]);
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
    expect(await marks()).toBeUndefined();
    expect(net.requests).toEqual([]);
    store.stop();
  });

  it("a build with no built-in apps offers none", async () => {
    expect(await apps(net).builtIns()).toEqual([]);
  });

  it("one the person installed is with the installed apps, not offered", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { builtIns: [chess(v1.digest)] });
    const preview = await store.preview({ url: BUNDLE_URL });
    // Built-in or not, what it asks is asked: nothing is granted for the person.
    expect(preview.asks).toEqual(["chat"]);
    await expect(store.install({ digest: preview.digest, grant: [] })).rejects.toThrow(/^permissions: /);
    await store.install({ digest: preview.digest, grant: ["chat"] });
    expect(await store.builtIns()).toEqual([]);
    expect((await store.list()).map((a) => a.ref)).toEqual([REF]);
  });
});

describe("removing sticks", () => {
  it("one never opened is only marked, and no start offers it again", async () => {
    const store = apps(net, { builtIns: [chess()] });
    await store.uninstall({ ref: REF });
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS } });
    expect(await store.builtIns()).toEqual([]);
    // Removed twice is removed once: the first time stays.
    await apps(net, { builtIns: [chess()], now: () => NOW_MS + 5000 }).uninstall({ ref: REF });
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS } });

    // The app started again, and a later build that carries a newer bundle of it.
    const again = apps(net, { builtIns: [chess("B".repeat(43))] });
    await again.start();
    expect(await again.builtIns()).toEqual([]);
    expect(await appRows()).toEqual([]);
    expect(net.requests).toEqual([]);
    again.stop();
  });

  it("an installed one goes with its files and its storage, and is marked in the same step", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { builtIns: [chess(v1.digest)] });
    await store.install({ digest: (await store.preview({ url: BUNDLE_URL })).digest, grant: ["chat"] });
    await store.storageSet({ ref: REF, scope: "chat-1", key: "game", value: { move: 1 } });
    expect(await marks()).toBeUndefined();

    await store.uninstall({ ref: REF });
    expect(await appRows()).toEqual([]);
    expect(await storageRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS } });
    expect(await store.builtIns()).toEqual([]);
    expect(await apps(net, { builtIns: [chess(v1.digest)] }).builtIns()).toEqual([]);
  });

  it("installing it again makes it the person's: the mark goes, and comes back with the next removal", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { builtIns: [chess(v1.digest)] });
    await store.uninstall({ ref: REF });
    await store.install({ digest: (await store.preview({ url: BUNDLE_URL })).digest, grant: ["chat"] });
    expect(await marks()).toEqual({ removed: {} });
    expect((await store.list()).map((a) => a.ref)).toEqual([REF]);

    const later = apps(net, { builtIns: [chess(v1.digest)], now: () => NOW_MS + 5000 });
    await later.uninstall({ ref: REF });
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS + 5000 } });
    expect(await later.builtIns()).toEqual([]);
  });

  it("an app that does not come with Ghostly is uninstalled as before: no mark, and not-installed when it is not there", async () => {
    const mine = await bundle({ name: "notes" });
    net.put(BUNDLE_URL, mine.bytes);
    const store = apps(net, { builtIns: [chess()] });
    await expect(store.uninstall({ ref: mine.ref })).rejects.toThrow(/^not-installed: /);
    await expect(store.uninstall({ ref: "not a reference" })).rejects.toThrow(/^bad-ref: /);
    await store.install({ digest: (await store.preview({ url: BUNDLE_URL })).digest, grant: ["chat"] });
    await store.uninstall({ ref: mine.ref });
    expect(await appRows()).toEqual([]);
    expect(await marks()).toBeUndefined();
    expect((await store.builtIns()).map((a) => a.ref)).toEqual([REF]);
  });

  it("a mark that is not one is no mark", async () => {
    await wrap((await store(STORES.settings, "readwrite")).put({ removed: { "not a reference": NOW_MS, [REF]: "yesterday" } }, BUILT_IN_APPS_KEY));
    expect((await apps(net, { builtIns: [chess()] }).builtIns()).map((a) => a.ref)).toEqual([REF]);
    await wrap((await store(STORES.settings, "readwrite")).put("removed", BUILT_IN_APPS_KEY));
    expect((await apps(net, { builtIns: [chess()] }).builtIns()).map((a) => a.ref)).toEqual([REF]);
  });

  it("a backup carries the marks: a restored profile is not offered what its person removed", async () => {
    await apps(net, { builtIns: [chess()] }).uninstall({ ref: REF });
    const snapshot = (await snapshotDatabase(databaseName(), ["fileChunks"]))!;
    const settings = snapshot.stores.find((s) => s.name === STORES.settings)!;
    expect(settings.values[settings.keys.indexOf(BUILT_IN_APPS_KEY)]).toEqual({ removed: { [REF]: NOW_MS } });
  });

  it("\"Clear all data\" takes the marks with the apps: the profile is offered them as a new one is", async () => {
    expect(PROFILE_SETTINGS_KEYS).toContain(BUILT_IN_APPS_KEY);
    const store = apps(net, { builtIns: [chess()] });
    await store.uninstall({ ref: REF });
    await clearProfileStores();
    expect(await marks()).toBeUndefined();
    expect((await store.builtIns()).map((a) => a.ref)).toEqual([REF]);
  });
});
