import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { APP_PREFIXES, APP_STORE_LIMITS, canonicalJsonBytes, signAppObject, signAppRevocation, type AppStoreIndex, type SignedAppRevocation } from "@ghostly/core";
import { FakeNet, NOW_S, STORE_KEY, STORE_URL, apps, emptyProfile, keyOf, signer, storeFiles } from "./appsSupport";
// covers: apps.engine.stores

/** The real signature check, counted: what reading a store's index costs is the number of these. */
vi.mock("@noble/curves/ed25519.js", async (importOriginal) => {
  const curves = await importOriginal<typeof import("@noble/curves/ed25519.js")>();
  return { ...curves, ed25519: { ...curves.ed25519, verify: vi.fn(curves.ed25519.verify) } };
});
const verifies = vi.mocked(ed25519.verify);

/*
 * What reading a store's index costs the page (WISP 1200 § Stores): its `revoked` holds up to 4096 signed revocations,
 * each a signature check, and the engine shares the page's thread. The read lets the thread go every few ms, and a
 * revocation it has checked is not checked again when the index changes around it, or when Add reads what the preview
 * just read.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
  verifies.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

/** Valid revocations of apps of a key of the store's owner's own: any key may sign for its own apps. */
const revocations = (count: number, from = 0): Promise<SignedAppRevocation[]> => {
  const owner = signer("a key of the store's owner");
  return Promise.all(Array.from({ length: count }, (_, i) => signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(owner)}/app-${from + i}`, upTo: 1 }, owner)));
};

/** An index signed as it is: `signAppStore` refuses to sign one whose revocations do not verify. */
async function signedAsIs(sequence: number, revoked: SignedAppRevocation[]) {
  const index: AppStoreIndex = { ghostlyStore: 1, key: keyOf(STORE_KEY), name: "Test store", kind: "curated", sequence, expires: NOW_S + 3600, apps: [], removed: [], revoked };
  const { bytes, signature } = await signAppObject(APP_PREFIXES.store, index, STORE_KEY);
  return { indexBytes: bytes, sigBytes: canonicalJsonBytes(signature) };
}

describe("reading a store's index", () => {
  it("lets the page's thread go every few ms, however many revocations it carries", async () => {
    await net.putStore(await storeFiles({ revoked: await revocations(300) }));
    const store = apps(net);
    verifies.mockClear();
    // A clock that only signature checks move, 1 ms each: the read's pace is then counted, not timed.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const real = verifies.getMockImplementation()!;
    let inThisTurn = 0, most = 0, turns = 0, reading = true;
    verifies.mockImplementation((...args) => { clock += 1; most = Math.max(most, ++inThisTurn); return real(...args); });
    // What else the page has to do: one timer after another, each a turn of its thread.
    const turn = () => { inThisTurn = 0; turns += 1; if (reading) setTimeout(turn, 0); };
    setTimeout(turn, 0);
    const preview = await store.previewStore({ url: STORE_URL });
    reading = false;
    expect(preview).toMatchObject({ key: keyOf(STORE_KEY), sequence: 1 });
    expect(verifies).toHaveBeenCalledTimes(301);
    expect(most, "signature checks in one turn of the thread").toBeLessThanOrEqual(11);
    expect(turns, "turns the page got while the index was read").toBeGreaterThanOrEqual(25);
  });

  it("a revocation checked once is not checked again: Add after the preview, and an index that changes around it", async () => {
    const held = await revocations(20);
    await net.putStore(await storeFiles({ revoked: held }));
    const store = apps(net);
    // Signing an index checks it too: only the engine's checks are counted.
    verifies.mockClear();
    await store.previewStore({ url: STORE_URL });
    expect(verifies, "20 revocations and the index").toHaveBeenCalledTimes(21);

    verifies.mockClear();
    await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
    expect(verifies, "Add: the index's signature, and no revocation again").toHaveBeenCalledTimes(1);

    // The store's next index: one revocation more, the rest copied again.
    await net.putStore(await storeFiles({ sequence: 2, revoked: [...held, ...await revocations(1, 20)] }));
    verifies.mockClear();
    expect(await store.refreshStores()).toMatchObject([{ sequence: 2 }]);
    expect(verifies, "the new revocation and the index").toHaveBeenCalledTimes(2);

    // A revocation that does not verify is never remembered as checked: it refuses the index at every read.
    const forged = { ...held[0]!, statement: { ...held[0]!.statement, upTo: 9 } };
    await net.putStore(await signedAsIs(3, [...held, forged]));
    for (let i = 0; i < 2; i++) {
      verifies.mockClear();
      expect(await store.refreshStores()).toMatchObject([{ sequence: 2, problem: "bad-revocation" }]);
      expect(verifies, "the forged one, each time").toHaveBeenCalledTimes(1);
    }
  });

  it("holds a bounded number of checked revocations, the one read longest ago dropped first", () => {
    const store = apps(net) as unknown as { checkedRevocations: { has(id: string): boolean; add(id: string): void }; storeRevocations: Set<string> };
    const max = 4 * APP_STORE_LIMITS.revoked;
    for (let i = 0; i < max; i++) store.checkedRevocations.add(`id-${i}`);
    expect(store.checkedRevocations.has("id-0"), "read again: now the newest").toBe(true);
    store.checkedRevocations.add("one more");
    expect(store.storeRevocations.size).toBe(max);
    expect(store.checkedRevocations.has("id-0")).toBe(true);
    expect(store.checkedRevocations.has("id-1")).toBe(false);
    expect(store.checkedRevocations.has("unknown")).toBe(false);
  });
});
