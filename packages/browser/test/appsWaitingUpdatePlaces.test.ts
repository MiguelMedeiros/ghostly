import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, STORE_KEY, STORE_URL, apps, bundle, emptyProfile, keyOf, listing, revocation, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * An update that waits for the person's yes is judged with its publisher's revocations read beside where it was found
 * and the sources it names (WISP 1200 § Publisher keys), as its install screen is: by the update check, and by Accept
 * before it installs it.
 */

const NEXT = "https://raw.githubusercontent.com/ana/chess-next/HEAD";
const NEXT_URL = `${NEXT}/app.ghostlyapp`;

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** v1 installed from a store's listing; the store's next index lists v2 (adds `name`) at another URL; the check parks it. */
async function waiting() {
  const v1 = await bundle({ sources: [BUNDLE_URL] });
  net.put(BUNDLE_URL, v1.bytes);
  await net.putStore(await storeFiles({ apps: [listing(v1)] }));
  const store = apps(net);
  await store.addStore({ url: STORE_URL });
  await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
  await store.install({ digest: v1.digest, grant: ["chat"] });

  const v2 = await bundle({ sequence: 2, permissions: ["chat", "name"], sources: [NEXT_URL] });
  net.put(NEXT_URL, v2.bytes);
  await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [NEXT_URL])] }));
  expect((await store.checkUpdates())[0]!.outcome).toBe("ask");
  expect((await store.list())[0]!.pending).toMatchObject({ sequence: 2 });
  return { v1, v2, store };
}

const revokeAtNext = async (v2: { ref: string; digest: string }) =>
  net.put(`${NEXT}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v2.ref, [v2.digest], "Signed with a stolen key")]));

describe("a waiting update's own places", () => {
  it("the next check reads beside them and drops a waiting update revoked there; Accept installs nothing", async () => {
    const { v1, v2, store } = await waiting();
    await revokeAtNext(v2);

    net.requests.length = 0;
    await store.checkUpdates();
    expect(net.requests).toContain(`${NEXT}/ghostly-revoke.json`);
    expect((await store.list())[0]!.pending).toBeUndefined();
    await expect(store.acceptUpdate({ ref: v2.ref, sequence: 2, added: ["name"] })).rejects.toThrow();
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
  });

  it("Accept reads beside them before it installs: one revoked since the check is refused", async () => {
    const { v1, v2, store } = await waiting();
    await revokeAtNext(v2);

    await expect(store.acceptUpdate({ ref: v2.ref, sequence: 2, added: ["name"] })).rejects.toThrow(/^revoked/);
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });
  });

  it("one revoked there before the check that found it is refused by Accept with no other check", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1)] }));
    const store = apps(net);
    await store.addStore({ url: STORE_URL });
    await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const v2 = await bundle({ sequence: 2, permissions: ["chat", "name"], sources: [NEXT_URL] });
    net.put(NEXT_URL, v2.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [NEXT_URL])] }));
    await revokeAtNext(v2);
    await store.checkUpdates();
    // Offline at Accept: the check's read is on the record.
    net.files.delete(`${NEXT}/ghostly-revoke.json`);

    await expect(store.acceptUpdate({ ref: v2.ref, sequence: 2, added: ["name"] })).rejects.toThrow();
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });
  });

  it("one not revoked is installed by Accept, as before", async () => {
    const { v2, store } = await waiting();
    await store.acceptUpdate({ ref: v2.ref, sequence: 2, added: ["name"] });
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest });
    expect(await store.runCheck({ ref: v2.ref })).toEqual({ status: "ok" });
  });
});
