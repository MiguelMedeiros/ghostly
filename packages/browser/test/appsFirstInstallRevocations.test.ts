import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, PINNED_URL, REPO, apps, appRows, bundle, emptyProfile, revocation } from "./appsSupport";
// covers: apps.engine.installed

/*
 * An app installed for the first time, from a pasted URL or a contact's card, is checked against its publisher's
 * `ghostly-revoke.json` (WISP 1200 § Publisher keys) before Install: the file beside the URL it was fetched from and
 * beside each source its manifest names, as the update check reads it.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

describe("a first install and its publisher's revocations", () => {
  it("a version its publisher revoked, from a pasted URL, is shown revoked and not installed", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest], "Leaks chats")]));
    const store = apps(net);

    const preview = await store.preview({ url: BUNDLE_URL });
    expect(preview.run).toEqual({ status: "revoked", reason: "Leaks chats" });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
    expect(await appRows()).toEqual([]);
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^not-installed/);
  });

  it("a card at a pinned commit is checked against the file beside the sources its manifest names too", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(PINNED_URL, v1.bytes);
    // The old commit's file, beside the pinned URL, has nothing; the publisher's current one is at the raw HEAD source.
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest], "Leaks chats")]));
    const store = apps(net);

    const preview = await store.preview({ card: { ref: v1.ref, url: PINNED_URL, sequence: v1.sequence, digest: v1.digest } });
    expect(preview.run).toEqual({ status: "revoked", reason: "Leaks chats" });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
    expect(await appRows()).toEqual([]);
  });

  it("a version not revoked installs, keeping its publisher's revocations of the others", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    const revoked = await revocation(v1.ref, [v1.digest]);
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([revoked]));
    const store = apps(net);

    expect((await store.preview({ url: BUNDLE_URL })).run).toEqual({ status: "ok" });
    await store.install({ digest: v2.digest, grant: ["chat"] });
    expect(await store.runCheck({ ref: v2.ref })).toEqual({ status: "ok" });
    expect(await appRows()).toEqual([expect.objectContaining({ digest: v2.digest, revocations: [revoked] })]);
  });

  it("no file beside it is not an error", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);

    expect((await store.preview({ url: BUNDLE_URL })).run).toEqual({ status: "ok" });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
  });
});
