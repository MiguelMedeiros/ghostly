import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, STORE_KEY, STORE_URL, apps, bundle, emptyProfile, keyOf, listing, revocation, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * An update the check installs by itself (it adds no permission) is judged with its publisher's revocations read beside
 * where it was found and the sources it names (WISP 1200 § Publisher keys) before it replaces the installed version.
 */

const NEXT = "https://raw.githubusercontent.com/ana/chess-next/HEAD";
const NEXT_URL = `${NEXT}/app.ghostlyapp`;
const NEXT_REVOKE = `${NEXT}/ghostly-revoke.json`;

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** v1 installed from a store's listing; the store's next index lists v2 (the same permissions) at another URL. */
async function listed() {
  const v1 = await bundle({ sources: [BUNDLE_URL] });
  net.put(BUNDLE_URL, v1.bytes);
  await net.putStore(await storeFiles({ apps: [listing(v1)] }));
  const store = apps(net);
  await store.addStore({ url: STORE_URL });
  await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
  await store.install({ digest: v1.digest, grant: ["chat"] });

  const v2 = await bundle({ sequence: 2, sources: [NEXT_URL] });
  net.put(NEXT_URL, v2.bytes);
  await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [NEXT_URL])] }));
  return { v1, v2, store };
}

describe("an update installed by the check, its own places", () => {
  it("one revoked beside where it was found is not installed: the installed version stays", async () => {
    const { v1, v2, store } = await listed();
    net.put(NEXT_REVOKE, canonicalJsonBytes([await revocation(v2.ref, [v2.digest], "Signed with a stolen key")]));

    expect((await store.checkUpdates())[0]!.outcome).not.toBe("updated");
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
    // Read before the version was taken, and once.
    expect(net.requests.filter((u) => u === NEXT_REVOKE)).toHaveLength(1);
  });

  it("one not revoked is installed, as before", async () => {
    const { v2, store } = await listed();
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest });
    expect(await store.runCheck({ ref: v2.ref })).toEqual({ status: "ok" });
  });
});
