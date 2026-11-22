import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeNet, PINNED_URL, STORE_KEY, STORE_URL, appRows, apps, bundle, emptyProfile, keyOf, listing, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * Two install screens of one version open at once, from two sources (a store's listing, a contact's card naming a copy
 * elsewhere): Install on each installs from where that screen said, and pins updates to its store only when it is a
 * store's screen (WISP 1200 § Stores, § Updates and rollback).
 */

const COPY_URL = "https://raw.githubusercontent.com/mallory/copy/HEAD/app.ghostlyapp";

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

async function twoScreens() {
  const v1 = await bundle();
  net.put(PINNED_URL, v1.bytes);
  net.put(COPY_URL, v1.bytes);
  await net.putStore(await storeFiles({ apps: [listing(v1, [PINNED_URL])] }));
  const store = apps(net);
  await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
  const listed = await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
  const card = await store.preview({ card: { ref: v1.ref, url: COPY_URL, sequence: 1, digest: v1.digest } });
  return { store, v1, listed, card };
}

describe("two install screens of one version", () => {
  it("Install on the store's screen installs the store's source, pinned to it, after a card's screen opened", async () => {
    const { store, v1, listed, card } = await twoScreens();
    expect([listed.from, card.from]).toEqual([PINNED_URL, COPY_URL]);
    await store.install({ stage: listed.stage, digest: v1.digest, grant: ["chat"] });
    expect(await appRows()).toMatchObject([{ digest: v1.digest, from: PINNED_URL, store: keyOf(STORE_KEY) }]);
  });

  it("Install on the card's screen installs the card's source, not pinned, after the store's screen opened", async () => {
    const { store, v1, card } = await twoScreens();
    await store.install({ stage: card.stage, digest: v1.digest, grant: ["chat"] });
    const [record] = await appRows() as { from: string; store?: string }[];
    expect(record).toMatchObject({ from: COPY_URL });
    expect(record!.store).toBeUndefined();
  });

  it("an Install that names no screen is refused while two sources of it wait", async () => {
    const { store, v1 } = await twoScreens();
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^screens/);
    expect(await appRows()).toEqual([]);
  });
});
