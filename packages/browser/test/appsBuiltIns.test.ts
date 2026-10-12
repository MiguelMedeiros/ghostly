import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { BuiltInApp } from "../src/engine/appDefaults";
import { BUILT_IN_APPS_KEY, builtInsDue } from "../src/engine/apps";
import { snapshotDatabase } from "../src/backup/database";
import { PROFILE_SETTINGS_KEYS, STORES, clearProfileStores, databaseName, store, wrap } from "../src/shared/idb";
import { fileBytes } from "../src/shared/fileBytes";
import { BUNDLE_URL, FakeNet, NOW_MS, PINNED_URL, PUBLISHER, appRows, apps, bundle, bundleIds, emptyProfile, keyOf, signer, storageRows } from "./appsSupport";
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
  carried = new Uint8Array();
  reads = 0;
});

const DIGEST = "A".repeat(43);
const chess = (digest = DIGEST): BuiltInApp => ({ publisher: keyOf(PUBLISHER), name: "chess", digest, url: BUNDLE_URL, title: "Chess", tagline: "Play chess with a contact" });
const REF = `${keyOf(PUBLISHER)}/chess`;
const marks = async () => wrap((await store(STORES.settings, "readonly")).get(BUILT_IN_APPS_KEY));
/** The file the build carries, as the client's host reads it: these bytes, and a count of the reads. */
let carried: Uint8Array | Error = new Uint8Array();
let reads = 0;
const readBuiltIn = async () => { reads++; if (carried instanceof Error) throw carried; return carried.slice(); };

describe("the list", () => {
  it("offers each whole entry once, unless it is installed or the person removed it", () => {
    const other: BuiltInApp = { publisher: keyOf(signer("other publisher")), name: "notes", digest: DIGEST, url: BUNDLE_URL, title: "Notes", tagline: "Notes for two" };
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
      { ...chess(), title: "" },
      { ...chess(), tagline: "" },
    ]) expect(builtInsDue([bad], new Set(), { removed: {} }), JSON.stringify(bad)).toEqual([]);
  });
});

describe("offered, not installed", () => {
  it("a start stores nothing, grants nothing and asks the network for nothing", async () => {
    const store = apps(net, { readBuiltIn, builtIns: [chess()] });
    await store.start();
    expect(await store.builtIns()).toEqual([{ ref: REF, publisher: keyOf(PUBLISHER), name: "chess", fingerprint: expect.stringMatching(/^(\w{4} ){3}\w{4}$/), digest: DIGEST, url: BUNDLE_URL, title: "Chess", tagline: "Play chess with a contact" }]);
    expect(await store.list()).toEqual([]);
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
    expect(await marks()).toBeUndefined();
    expect(net.requests).toEqual([]);
    // Listing reads nothing: the file is read when the person opens the app.
    expect(reads).toBe(0);
    store.stop();
  });

  it("a build with no built-in apps offers none, and neither does one that carries no file", async () => {
    expect(await apps(net).builtIns()).toEqual([]);
    expect(await apps(net, { builtIns: [chess()] }).builtIns()).toEqual([]);
    await expect(apps(net, { builtIns: [chess()] }).preview({ builtIn: REF })).rejects.toThrow(/^not-offered: /);
  });

  it("one the person installed is with the installed apps, not offered", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
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
    const store = apps(net, { readBuiltIn, builtIns: [chess()] });
    await store.uninstall({ ref: REF });
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS } });
    expect(await store.builtIns()).toEqual([]);
    // Removed twice is removed once: the first time stays.
    await apps(net, { readBuiltIn, builtIns: [chess()], now: () => NOW_MS + 5000 }).uninstall({ ref: REF });
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS } });

    // The app started again, and a later build that carries a newer bundle of it.
    const again = apps(net, { readBuiltIn, builtIns: [chess("B".repeat(43))] });
    await again.start();
    expect(await again.builtIns()).toEqual([]);
    expect(await appRows()).toEqual([]);
    expect(net.requests).toEqual([]);
    again.stop();
  });

  it("an installed one goes with its files and its storage, and is marked in the same step", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    await store.install({ digest: (await store.preview({ url: BUNDLE_URL })).digest, grant: ["chat"] });
    await store.storageSet({ ref: REF, scope: "chat-1", key: "game", value: { move: 1 } });
    expect(await marks()).toBeUndefined();

    await store.uninstall({ ref: REF });
    expect(await appRows()).toEqual([]);
    expect(await storageRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS } });
    expect(await store.builtIns()).toEqual([]);
    expect(await apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] }).builtIns()).toEqual([]);
  });

  it("installing it again makes it the person's: the mark goes, and comes back with the next removal", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    await store.uninstall({ ref: REF });
    await store.install({ digest: (await store.preview({ url: BUNDLE_URL })).digest, grant: ["chat"] });
    expect(await marks()).toEqual({ removed: {} });
    expect((await store.list()).map((a) => a.ref)).toEqual([REF]);

    const later = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)], now: () => NOW_MS + 5000 });
    await later.uninstall({ ref: REF });
    expect(await marks()).toEqual({ removed: { [REF]: NOW_MS + 5000 } });
    expect(await later.builtIns()).toEqual([]);
  });

  it("an app that does not come with Ghostly is uninstalled as before: no mark, and not-installed when it is not there", async () => {
    const mine = await bundle({ name: "notes" });
    net.put(BUNDLE_URL, mine.bytes);
    const store = apps(net, { readBuiltIn, builtIns: [chess()] });
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
    expect((await apps(net, { readBuiltIn, builtIns: [chess()] }).builtIns()).map((a) => a.ref)).toEqual([REF]);
    await wrap((await store(STORES.settings, "readwrite")).put("removed", BUILT_IN_APPS_KEY));
    expect((await apps(net, { readBuiltIn, builtIns: [chess()] }).builtIns()).map((a) => a.ref)).toEqual([REF]);
  });

  it("a backup carries the marks: a restored profile is not offered what its person removed", async () => {
    await apps(net, { readBuiltIn, builtIns: [chess()] }).uninstall({ ref: REF });
    const snapshot = (await snapshotDatabase(databaseName(), ["fileChunks"]))!;
    const settings = snapshot.stores.find((s) => s.name === STORES.settings)!;
    expect(settings.values[settings.keys.indexOf(BUILT_IN_APPS_KEY)]).toEqual({ removed: { [REF]: NOW_MS } });
  });

  it("\"Clear all data\" takes the marks with the apps: the profile is offered them as a new one is", async () => {
    expect(PROFILE_SETTINGS_KEYS).toContain(BUILT_IN_APPS_KEY);
    const store = apps(net, { readBuiltIn, builtIns: [chess()] });
    await store.uninstall({ ref: REF });
    await clearProfileStores();
    expect(await marks()).toBeUndefined();
    expect((await store.builtIns()).map((a) => a.ref)).toEqual([REF]);
  });
});

describe("opened from the build", () => {
  it("the first open is the install screen, from the carried file: every permission asked, nothing stored, no request", async () => {
    const v1 = await bundle({ permissions: ["chat", "name"] });
    carried = v1.bytes;
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    const preview = await store.preview({ builtIn: REF });
    expect(preview).toMatchObject({ ref: REF, digest: v1.digest, install: "new", asks: ["chat", "name"], from: BUNDLE_URL, carried: true });
    expect(reads).toBe(1);
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
    expect(net.requests).toEqual([]);

    // Nothing is granted for the person: the sheet's Allow is the install.
    await expect(store.install({ digest: preview.digest, grant: ["chat"] })).rejects.toThrow(/^permissions: /);
    const installed = await store.install({ digest: preview.digest, grant: ["chat", "name"] });
    // As one added by its URL: its public URL as its source (what a card names), and no store pinned.
    expect(installed).toMatchObject({ ref: REF, from: BUNDLE_URL, permissions: ["chat", "name"], run: { status: "ok" } });
    expect((await appRows() as { store?: string }[])[0]!.store).toBeUndefined();
    expect(await store.builtIns()).toEqual([]);
    expect((await store.entry({ ref: REF })).entry).toContain("<title>Chess</title>");
    expect(net.requests.filter((u) => u === BUNDLE_URL)).toEqual([]);
  });

  it("a carried file that is not the pinned bundle is not an app", async () => {
    const v1 = await bundle();
    const other = await bundle({ sequence: 2 });
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    // Another version of the same app, signed by its publisher: still not the digest the list pins.
    carried = other.bytes;
    await expect(store.preview({ builtIn: REF })).rejects.toThrow(/^unlisted: /);
    // The pinned digest's bytes with one changed: the bundle reader refuses it.
    carried = v1.bytes.slice(); carried[carried.length - 1] ^= 1;
    await expect(store.preview({ builtIn: REF })).rejects.toThrow();
    // Another publisher's app under the pinned digest of its own bundle, named as ours.
    const theirs = await bundle({ by: signer("other publisher") });
    carried = theirs.bytes;
    await expect(apps(net, { readBuiltIn, builtIns: [chess(theirs.digest)] }).preview({ builtIn: REF })).rejects.toThrow(/^unlisted: /);
    // No file at all in this build.
    carried = new Error("404");
    await expect(store.preview({ builtIn: REF })).rejects.toThrow(/^not-carried: /);
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);
    expect(net.requests).toEqual([]);
  });

  it("one the person removed, or has installed, is not opened from the build", async () => {
    const v1 = await bundle();
    carried = v1.bytes;
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    await store.install({ digest: (await store.preview({ builtIn: REF })).digest, grant: ["chat"] });
    await expect(store.preview({ builtIn: REF })).rejects.toThrow(/^not-offered: /);
    await store.uninstall({ ref: REF });
    await expect(store.preview({ builtIn: REF })).rejects.toThrow(/^not-offered: /);
    await expect(store.preview({ builtIn: "not a reference" })).rejects.toThrow(/^bad-ref: /);
    // Removed, it is still installable the usual ways.
    expect((await store.preview({ url: BUNDLE_URL })).install).toBe("new");
  });

  it("a contact's card of the carried version opens from the build; another version is fetched as any card's", async () => {
    const v1 = await bundle();
    const v2 = await bundle({ sequence: 2 });
    carried = v1.bytes;
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    const preview = await store.preview({ card: { ref: REF, url: PINNED_URL, sequence: 1, digest: v1.digest } });
    expect(preview).toMatchObject({ ref: REF, digest: v1.digest, install: "new", from: BUNDLE_URL, carried: true });
    expect(net.requests).toEqual([]);

    net.put(PINNED_URL, v2.bytes);
    const newer = await store.preview({ card: { ref: REF, url: PINNED_URL, sequence: 2, digest: v2.digest } });
    expect(newer).toMatchObject({ digest: v2.digest, from: PINNED_URL });
    expect(newer.carried).toBeUndefined();
    expect(net.requests).toEqual([PINNED_URL]);
  });

  it("a restored profile's built-in app takes its files from the build, with no request", async () => {
    const v1 = await bundle();
    carried = v1.bytes;
    const store = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    await store.install({ digest: (await store.preview({ builtIn: REF })).digest, grant: ["chat"] });
    // As after a restore: the record is there, the bundle's bytes are not.
    await (await fileBytes()).remove(`app-${v1.digest}`);
    const fresh = apps(net, { readBuiltIn, builtIns: [chess(v1.digest)] });
    expect((await fresh.runCheck({ ref: REF })).status).toBe("needs-files");
    expect((await fresh.fetchFiles({ ref: REF })).status).toBe("ok");
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
    expect(net.requests).toEqual([]);
  });
});
