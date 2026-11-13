import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLE_URL, FakeNet, REPO, STORE_URL, apps, bundle, bundleIds, emptyProfile, listing, revocation, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A store's index that revokes a version while that version is being fetched or written (the update check, Install):
 * the version is not installed, or its record carries the revocation, so the store's next index without it does not let
 * it run (WISP 1200 § Publisher keys: a client keeps every revocation it verified).
 */

const V2_URL = `${REPO}/v2.ghostlyapp`;

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** v1 installed by URL; a store the person added lists v2. */
async function installed() {
  const v1 = await bundle();
  net.put(BUNDLE_URL, v1.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  const v2 = await bundle({ sequence: 2 });
  net.put(V2_URL, v2.bytes);
  await net.putStore(await storeFiles({ apps: [listing(v2, [V2_URL])] }));
  await store.addStore({ url: STORE_URL });
  return { v1, v2, store };
}

/** The next whole read of `url` (not a peek) waits until `release` is called; `asked` resolves once it was made. */
function holdRead(url: string): { asked: Promise<void>; release: () => void } {
  const real = net.fetch.getMockImplementation()!;
  let release!: () => void;
  let asked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { asked = resolve; });
  let held = false;
  net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!held && String(input) === url && !((init?.headers ?? {}) as Record<string, string>).range) {
      held = true;
      asked();
      await gate;
    }
    return real(input, init);
  });
  return { asked: seen, release };
}

/** The store's next index revokes `digest`, read before the next bundle write goes on. */
function revokeAtWrite(store: ReturnType<typeof apps>, ref: string, digest: string): void {
  const target = store as unknown as { writeBundle: (digest: string, bytes: Uint8Array) => Promise<unknown> };
  const real = target.writeBundle.bind(store);
  let done = false;
  vi.spyOn(target, "writeBundle").mockImplementation(async (d, bytes) => {
    if (!done && d === digest) {
      done = true;
      await net.putStore(await storeFiles({ sequence: 2, apps: [], revoked: [await revocation(ref, [digest])] }));
      await store.refreshStores();
    }
    return real(d, bytes);
  });
}

async function storeDropsIt(): Promise<void> {
  await net.putStore(await storeFiles({ sequence: 3, apps: [] }));
}

describe("a version a store revokes while it is fetched or written", () => {
  it("the update check: revoked while its bundle downloads, it is not installed", async () => {
    const { v1, v2, store } = await installed();
    const hold = holdRead(V2_URL);
    const check = store.checkUpdates();
    await hold.asked;
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2, [V2_URL])], revoked: [await revocation(v1.ref, [v2.digest])] }));
    await store.refreshStores();
    hold.release();
    expect(await check).toEqual([{ ref: v1.ref, outcome: "none", run: { status: "ok" } }]);
    expect((await store.list())[0]).toMatchObject({ digest: v1.digest });
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
  });

  it("the update check: revoked while its bundle is written, the record carries it after the store drops it", async () => {
    const { v1, v2, store } = await installed();
    revokeAtWrite(store, v1.ref, v2.digest);
    await store.checkUpdates();
    await storeDropsIt();
    await store.refreshStores();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^revoked/);
  });

  it("Install: revoked while its bundle is written, it is refused and the installed version stays", async () => {
    const { v1, v2, store } = await installed();
    await store.preview({ url: V2_URL });
    revokeAtWrite(store, v1.ref, v2.digest);
    await expect(store.install({ digest: v2.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
    expect((await store.list())[0]).toMatchObject({ digest: v1.digest });
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
  });
});
