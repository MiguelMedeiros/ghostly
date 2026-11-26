import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { boundedAppFetch } from "../src/engine/appFetch";
import { BUNDLE_URL, FakeNet, NOW_MS, REPO, STORE_KEY, STORE_URL, apps, appRows, bundle, emptyProfile, keyOf, listing, revocation, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * An app a store updates is read at a jsDelivr copy pinned to each version's commit: every version leaves one more
 * folder among its earlier places (`formerSources`), beside a `ghostly-revoke.json` that never changes. Once one
 * answered, the update check does not ask it again; where the publisher still can publish is asked at every check.
 */

const pinnedAt = (v: number) => `https://cdn.jsdelivr.net/gh/ana/chess@${v.toString(16).padStart(40, "0")}`;
const revokeFiles = (net: FakeNet) => net.requests.filter((u) => u.endsWith("/ghostly-revoke.json"));

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** v1 installed from the store's listing at its commit, then `to - 1` updates the store lists, each at its own commit. */
async function updatedByStore(to: number) {
  const v1 = await bundle({ sources: [BUNDLE_URL] });
  net.put(`${pinnedAt(1)}/app.ghostlyapp`, v1.bytes);
  await net.putStore(await storeFiles({ apps: [listing(v1, [`${pinnedAt(1)}/app.ghostlyapp`])] }));
  const store = apps(net);
  await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
  await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  let last = v1;
  for (let v = 2; v <= to; v++) {
    last = await bundle({ sequence: v, sources: [BUNDLE_URL] });
    net.put(`${pinnedAt(v)}/app.ghostlyapp`, last.bytes);
    await net.putStore(await storeFiles({ sequence: v, apps: [listing(last, [`${pinnedAt(v)}/app.ghostlyapp`])] }));
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
  }
  return { store, last };
}

describe("earlier versions' files at a commit", () => {
  it("an idle check asks only where the app comes from and its sources, not again each earlier commit's file", async () => {
    const { store, last } = await updatedByStore(8);
    const [row] = await appRows() as { formerSources?: string[] }[];
    expect(row!.formerSources).toHaveLength(8);

    net.requests.length = 0;
    await store.checkUpdates();
    expect(new Set(revokeFiles(net))).toEqual(new Set([`${pinnedAt(8)}/ghostly-revoke.json`, `${REPO}/ghostly-revoke.json`]));

    // Where the publisher still can publish is still asked: a revocation there stops it at the next check.
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(last.ref, [last.digest], "Signed with a stolen key")]));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: last.ref })).toEqual({ status: "revoked", reason: "Signed with a stolen key" });
  });

  it("what an earlier commit's file revokes still stops a version found checks later", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    const v3 = await bundle({ sequence: 3, sources: [BUNDLE_URL] });
    net.put(`${pinnedAt(1)}/app.ghostlyapp`, v1.bytes);
    net.put(`${pinnedAt(1)}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v3.digest], "Signed with a stolen key")]));
    // Its publisher's own place answers too, with another version's: what the record keeps is what the files read say now.
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, ["A".repeat(43)], "Broken build")]));
    await net.putStore(await storeFiles({ apps: [listing(v1, [`${pinnedAt(1)}/app.ghostlyapp`])] }));
    let now = NOW_MS;
    const store = apps(net, { now: () => now });
    await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
    await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.put(`${pinnedAt(2)}/app.ghostlyapp`, v2.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [`${pinnedAt(2)}/app.ghostlyapp`])] }));
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    // Checks hours apart, each writing the record with what the files read say.
    for (let i = 0; i < 2; i++) {
      now += 60 * 60 * 1000;
      await store.checkUpdates();
    }

    net.put(`${pinnedAt(3)}/app.ghostlyapp`, v3.bytes);
    await net.putStore(await storeFiles({ sequence: 3, apps: [listing(v3, [`${pinnedAt(3)}/app.ghostlyapp`])] }));
    now += 60 * 60 * 1000;
    net.requests.length = 0;
    expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect(revokeFiles(net)).not.toContain(`${pinnedAt(1)}/ghostly-revoke.json`);
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest });
  });

  it("a restarted engine asks each of them once again", async () => {
    await updatedByStore(4);
    const again = apps(net);
    net.requests.length = 0;
    await again.checkUpdates();
    expect(new Set(revokeFiles(net))).toEqual(new Set([1, 2, 3, 4].map((v) => `${pinnedAt(v)}/ghostly-revoke.json`).concat(`${REPO}/ghostly-revoke.json`)));
    net.requests.length = 0;
    await again.checkUpdates();
    expect(new Set(revokeFiles(net))).toEqual(new Set([`${pinnedAt(4)}/ghostly-revoke.json`, `${REPO}/ghostly-revoke.json`]));
  });

  it("one whose read failed for a reason that may pass is asked again at the next check", async () => {
    await updatedByStore(2);
    let busy = true;
    const busyAt = `${pinnedAt(1)}/ghostly-revoke.json`;
    const again = apps(net, { fetch: boundedAppFetch({ fetcher: async (input, init) => (busy && String(input) === busyAt ? new Response("busy", { status: 503 }) : net.fetch(input, init)) }) });
    await again.checkUpdates();
    busy = false;
    net.requests.length = 0;
    await again.checkUpdates();
    expect(revokeFiles(net)).toContain(busyAt);
  });
});
