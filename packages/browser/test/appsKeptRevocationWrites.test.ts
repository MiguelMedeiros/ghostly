import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_URL, FakeNet, REPO, STORE_URL, apps, appRows, bundle, emptyProfile, listing, revocation, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A revocation a store's index carried is kept on the app's record (WISP 1200 § Publisher keys): a write of the record
 * built from a read made before it was kept (the update check, waiting on the publisher's file) does not drop it.
 */

const REVOKE_URL = `${REPO}/ghostly-revoke.json`;

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** The next request for the publisher's revocations waits until `release` is called; `asked` resolves once it was made. */
function holdRevocations(): { asked: Promise<void>; release: () => void } {
  const real = net.fetch.getMockImplementation()!;
  let release!: () => void;
  let asked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { asked = resolve; });
  let held = false;
  net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!held && String(input) === REVOKE_URL) {
      held = true;
      asked();
      await gate;
    }
    return real(input, init);
  });
  return { asked: seen, release };
}

async function installed() {
  const v1 = await bundle();
  net.put(BUNDLE_URL, v1.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  return { v1, store };
}

describe("a revocation kept while the update check runs", () => {
  it("a store added meanwhile: kept after the check writes, and after the store drops it", async () => {
    const { v1, store } = await installed();
    const revoked = await revocation(v1.ref, [v1.digest], "Leaked key");
    const hold = holdRevocations();
    const check = store.checkUpdates();
    await hold.asked;
    await net.putStore(await storeFiles({ apps: [listing(v1)], revoked: [revoked] }));
    await store.addStore({ url: STORE_URL });
    hold.release();
    await check;
    expect(await appRows()).toEqual([expect.objectContaining({ digest: v1.digest, revocations: [revoked] })]);

    await net.putStore(await storeFiles({ sequence: 2, apps: [] }));
    await store.refreshStores();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    await store.removeStore({ key: (await store.listStores())[0]!.key });
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
  });

  it("a store's refresh meanwhile that revokes it: kept after the check writes, and after the store drops it", async () => {
    const { v1, store } = await installed();
    await net.putStore(await storeFiles({ apps: [listing(v1)] }));
    await store.addStore({ url: STORE_URL });
    const revoked = await revocation(v1.ref, [v1.digest], "Leaked key");
    const hold = holdRevocations();
    const check = store.checkUpdates();
    await hold.asked;
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v1)], revoked: [revoked] }));
    await store.refreshStores();
    hold.release();
    await check;

    await net.putStore(await storeFiles({ sequence: 3, apps: [listing(v1)] }));
    await store.refreshStores();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
  });
});
