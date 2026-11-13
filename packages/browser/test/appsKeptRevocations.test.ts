import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes, readAppRevocationShape, signAppRevocation } from "@ghostly/core";
import type * as core from "@ghostly/core";
import { APP_REVOCATIONS_KEY } from "../src/engine/apps";
import { PROFILE_SETTINGS_KEYS, STORES, store as dbStore, wrap } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, PUBLISHER, REPO, STORE_URL, apps, appRows, bundle, emptyProfile, keyOf, listing, revocation, signer, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return { ...actual, readAppRevocationShape: vi.fn(actual.readAppRevocationShape) };
});
const shapeChecks = vi.mocked(readAppRevocationShape);

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
    const copy = await store.preview({ url: MIRROR_URL });
    expect(copy.run).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.install({ stage: copy.stage, digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
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

describe("how many are kept", () => {
  it("another publisher's install screens, revoking their own apps up to the cap, push out none of this publisher's", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest], "Leaked key")]));
    const store = apps(net);
    expect((await store.preview({ url: BUNDLE_URL })).run).toEqual({ status: "revoked", reason: "Leaked key" });

    // 16 apps of another key, each shown with 64 revocations of itself beside it: 1024 kept of that publisher alone.
    const other = signer("another publisher");
    for (let i = 0; i < 16; i++) {
      const app = await bundle({ by: other, name: `app${i}` });
      const dir = `https://raw.githubusercontent.com/other/app${i}/HEAD`;
      net.put(`${dir}/app.ghostlyapp`, app.bytes);
      net.put(`${dir}/ghostly-revoke.json`, canonicalJsonBytes(await Promise.all(Array.from({ length: 64 }, (_, n) =>
        signAppRevocation({ ghostlyRevoke: 1, app: app.ref, digests: [app.digest], reason: `Reason ${n}` }, other)))));
      expect((await store.preview({ url: `${dir}/app.ghostlyapp` })).run).toEqual({ status: "revoked", reason: expect.any(String) });
    }

    net.put(MIRROR_URL, v1.bytes);
    expect((await store.preview({ url: MIRROR_URL })).run).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
    expect(await appRows()).toEqual([]);
    // Still bounded: the other publisher made room from its own.
    const kept = await wrap((await dbStore(STORES.settings, "readonly")).get(APP_REVOCATIONS_KEY)) as [string, unknown[]][];
    expect(kept.reduce((n, [, list]) => n + list.length, 0)).toBeLessThanOrEqual(1024);
  });
});

describe("what reading them costs", () => {
  it("an install screen and Install check only the kept revocations of the app shown, not every app's", async () => {
    // Four other apps of the publisher, each revoked twice, then uninstalled: their revocations are kept.
    const others = await Promise.all([0, 1, 2, 3].map((i) => bundle({ name: `other${i}` })));
    const store = apps(net);
    for (const [i, other] of others.entries()) {
      net.put(`${REPO}/other${i}.ghostlyapp`, other.bytes);
      await store.preview({ url: `${REPO}/other${i}.ghostlyapp` });
      await store.install({ digest: other.digest, grant: ["chat"] });
    }
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes(await Promise.all(others.flatMap((o) => [revocation(o.ref, [o.digest], "Leaked key"), revocation(o.ref, [o.digest], "Lost key")]))));
    await store.checkUpdates();
    for (const other of others) await store.uninstall({ ref: other.ref });
    net.files.delete(`${REPO}/ghostly-revoke.json`);
    expect(others.every((o) => o.ref.startsWith(`${keyOf(PUBLISHER)}/`))).toBe(true);

    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    shapeChecks.mockClear();
    expect((await store.preview({ url: BUNDLE_URL })).run).toEqual({ status: "ok" });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    expect(shapeChecks).not.toHaveBeenCalled();
    // The others' are still kept, and still refuse a copy of a version they name.
    net.put(`${REPO}/copy.ghostlyapp`, others[0]!.bytes);
    expect((await store.preview({ url: `${REPO}/copy.ghostlyapp` })).run).toEqual({ status: "revoked", reason: expect.stringMatching(/key$/) });
    expect(shapeChecks).toHaveBeenCalledTimes(2);
  });
});
