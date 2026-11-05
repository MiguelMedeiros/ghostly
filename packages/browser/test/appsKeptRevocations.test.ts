import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { APP_REVOCATIONS_KEY } from "../src/engine/apps";
import { PROFILE_SETTINGS_KEYS } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, REPO, STORE_URL, apps, appRows, bundle, emptyProfile, listing, revocation, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A client keeps every revocation it verified (WISP 1200 § Revocation): kept by app reference beside the installed list,
 * not only on the app's record, so Uninstall does not drop them. A copy of the same bytes at another URL, with no
 * `ghostly-revoke.json` beside it (a contact's card), is still refused.
 */

const MIRROR = "https://raw.githubusercontent.com/someone/copy/HEAD";
const MIRROR_URL = `${MIRROR}/app.ghostlyapp`;

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

describe("revocations an app's uninstall leaves", () => {
  it("one read beside its URL: the same version from a copy elsewhere is shown revoked and not installed", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest], "Leaked key")]));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    await store.uninstall({ ref: v1.ref });

    net.put(MIRROR_URL, v1.bytes);
    const preview = await store.preview({ card: { ref: v1.ref, url: MIRROR_URL, sequence: v1.sequence, digest: v1.digest } });
    expect(preview.run).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
    expect(await appRows()).toEqual([]);
    // A new engine (the page reloaded) reads them back.
    const again = apps(net);
    expect((await again.preview({ url: MIRROR_URL })).run).toEqual({ status: "revoked", reason: "Leaked key" });
  });

  it("one a store's index carried, dropped by the store since: the same version from a copy is refused", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const revoked = await revocation(v1.ref, [v1.digest], "Leaked key");
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await net.putStore(await storeFiles({ apps: [listing(v1)], revoked: [revoked] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    await net.putStore(await storeFiles({ sequence: 2, apps: [] }));
    await store.refreshStores();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    await store.uninstall({ ref: v1.ref });

    net.put(MIRROR_URL, v1.bytes);
    expect((await store.preview({ url: MIRROR_URL })).run).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
    expect(await appRows()).toEqual([]);
  });

  it("a copy previewed while the app was installed, then Install after its uninstall: refused", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest], "Leaked key")]));
    await store.checkUpdates();
    net.files.delete(`${REPO}/ghostly-revoke.json`);

    net.put(MIRROR_URL, v1.bytes);
    expect((await store.preview({ url: MIRROR_URL })).run).toEqual({ status: "revoked", reason: "Leaked key" });
    await store.uninstall({ ref: v1.ref });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
    expect(await appRows()).toEqual([]);
  });

  it("one read at a preview that refused it: the same version from a copy is refused too", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest], "Leaked key")]));
    const store = apps(net);
    expect((await store.preview({ url: BUNDLE_URL })).run).toEqual({ status: "revoked", reason: "Leaked key" });

    net.put(MIRROR_URL, v1.bytes);
    expect((await store.preview({ url: MIRROR_URL })).run).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
  });

  it("a newer version, not revoked, installs from a copy and keeps them; Clear all data drops them", async () => {
    const v1 = await bundle();
    const v2 = await bundle({ sequence: 2 });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const revoked = await revocation(v1.ref, [v1.digest]);
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([revoked]));
    await store.checkUpdates();
    await store.uninstall({ ref: v1.ref });

    net.put(MIRROR_URL, v2.bytes);
    expect((await store.preview({ url: MIRROR_URL })).run).toEqual({ status: "ok" });
    await store.install({ digest: v2.digest, grant: ["chat"] });
    expect(await store.runCheck({ ref: v2.ref })).toEqual({ status: "ok" });
    expect(await appRows()).toEqual([expect.objectContaining({ digest: v2.digest, revocations: [revoked] })]);
    expect(PROFILE_SETTINGS_KEYS).toContain(APP_REVOCATIONS_KEY);
  });
});
