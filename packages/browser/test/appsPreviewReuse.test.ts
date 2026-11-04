import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_URL, FakeNet, NOW_MS, PINNED_URL, REPO, STORE_URL, apps, bundle, emptyProfile, keyOf, listing, STORE_KEY, storeFiles } from "./appsSupport";
// covers: apps.engine.network

/*
 * An install screen opened again on the version it showed a moment ago (a store's listing, a contact's card that names
 * its digest) takes the bundle already read and checked, kept by digest for 10 minutes, instead of downloading it whole
 * again. Only the publisher's revocations are read again. A pasted link names no digest, so it is read again.
 */

beforeEach(async () => { await emptyProfile(); });

const reads = (net: FakeNet, url: string) => net.requests.filter((u) => u === url).length;

describe("an install screen opened again", () => {
  it("on a store's listing reads the bundle once, and the revocations each time", async () => {
    const app = await bundle();
    const net = new FakeNet();
    net.put(BUNDLE_URL, app.bytes);
    await net.putStore(await storeFiles({ apps: [listing(app)] }));
    const a = apps(net);
    await a.addStore({ url: STORE_URL });
    for (let i = 0; i < 3; i++) expect((await a.preview({ store: keyOf(STORE_KEY), ref: app.ref })).digest).toBe(app.digest);
    expect(reads(net, BUNDLE_URL)).toBe(1);
    expect(reads(net, `${REPO}/ghostly-revoke.json`)).toBe(3);
    // The bundle taken again installs as the one read.
    expect(await a.install({ digest: app.digest, grant: ["chat"] })).toMatchObject({ ref: app.ref, digest: app.digest });
  });

  it("on a contact's card with its digest reads the bundle once", async () => {
    const app = await bundle();
    const net = new FakeNet();
    net.put(BUNDLE_URL, app.bytes);
    const a = apps(net);
    const card = { ref: app.ref, url: BUNDLE_URL, sequence: app.sequence, digest: app.digest };
    for (let i = 0; i < 3; i++) expect((await a.preview({ card })).digest).toBe(app.digest);
    expect(reads(net, BUNDLE_URL)).toBe(1);
  });

  it("reads the bundle again for a pasted link, a card from another URL or of another digest, and after 10 minutes", async () => {
    const app = await bundle();
    const net = new FakeNet();
    net.put(BUNDLE_URL, app.bytes);
    net.put(PINNED_URL, app.bytes);
    let now = NOW_MS;
    const a = apps(net, { now: () => now });
    const card = { ref: app.ref, url: BUNDLE_URL, sequence: app.sequence, digest: app.digest };
    await a.preview({ url: BUNDLE_URL });
    await a.preview({ url: BUNDLE_URL });
    expect(reads(net, BUNDLE_URL)).toBe(2);

    // A card of the same digest at another URL: its own URL is read.
    await a.preview({ card: { ...card, url: PINNED_URL } });
    expect(reads(net, PINNED_URL)).toBe(1);

    // A card naming no digest is read from its URL.
    await a.preview({ card: { ref: app.ref, url: BUNDLE_URL, sequence: app.sequence } });
    expect(reads(net, BUNDLE_URL)).toBe(3);

    // Past the 10 minutes a checked bundle is kept, the card reads it again.
    now += 10 * 60 * 1000 + 1;
    await a.preview({ card });
    expect(reads(net, BUNDLE_URL)).toBe(4);
  });
});
