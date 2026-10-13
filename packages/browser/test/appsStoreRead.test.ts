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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    let inThisTurn = 0, most = 0, turns = 0;
    verifies.mockImplementation((...args) => { clock += 1; most = Math.max(most, ++inThisTurn); return real(...args); });
    // Each time the read lets the thread go, the page gets a turn: the engine's pause is `scheduler.yield()` where there
    // is one (`yieldThread`), stubbed here to count them. A timer would not do: the pause is not one, so that no clamp
    // of nested timers adds 4 ms to each.
    const turn = async () => { inThisTurn = 0; turns += 1; };
    vi.stubGlobal("scheduler", { yield: turn });
    const preview = await store.previewStore({ url: STORE_URL });
    vi.unstubAllGlobals();
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
      expect(verifies, "the index and the forged one, each time").toHaveBeenCalledTimes(2);
    }
  });

  it("an index whose own signature does not verify costs one signature check, whatever it carries", async () => {
    const good = await storeFiles({ revoked: await revocations(50) });
    const other = await storeFiles({ name: "Another" });
    await net.putStore({ indexBytes: good.indexBytes, sigBytes: other.sigBytes });
    const store = apps(net);
    verifies.mockClear();
    await expect(store.previewStore({ url: STORE_URL })).rejects.toThrow(/^bad-signature/);
    expect(verifies, "the index's own, and no revocation").toHaveBeenCalledTimes(1);
    // Another key than the one the person saw: no signature is checked at all.
    verifies.mockClear();
    await expect(store.addStore({ url: STORE_URL, key: keyOf(signer("someone else")) })).rejects.toThrow(/^store-key/);
    expect(verifies).not.toHaveBeenCalled();
    // Nothing of the refused index was taken as checked.
    await net.putStore(good);
    await store.previewStore({ url: STORE_URL });
    expect(verifies, "the index and its 50 revocations").toHaveBeenCalledTimes(51);
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
