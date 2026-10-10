import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_SCOPE_ALONE } from "../src/engine/apps";
import { STORES } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, NOW_MS, STORE_URL, apps, bundle, emptyProfile, listing, rows, storeFiles, type Built } from "./appsSupport";
// covers: apps.engine.stores

/*
 * How often the engine reads and writes the stores' records (`STORES.appStores`): a record holds its store's whole
 * index, up to 4 MiB, and IndexedDB hands it over as a whole. Opening the Apps page read each one eight times and wrote
 * it back for a new `fetchedAt` alone, and a running app's next call read them all again.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});
afterEach(() => { vi.restoreAllMocks(); });

/** One store that lists one app, installed from it. */
async function installed(): Promise<Built> {
  const v1 = await bundle();
  net.put(BUNDLE_URL, v1.bytes);
  await net.putStore(await storeFiles({ apps: [listing(v1)] }));
  const store = apps(net);
  await store.addStore({ url: STORE_URL });
  await store.preview({ store: (await store.listStores())[0]!.key, ref: v1.ref });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  return v1;
}

/** Counts the calls on the stores' object store from here on. */
function counted(): { get: number; getAll: number; put: number } {
  const calls = { get: 0, getAll: 0, put: 0 };
  for (const method of ["get", "getAll", "put"] as const) {
    const real = IDBObjectStore.prototype[method] as (this: IDBObjectStore, ...args: unknown[]) => IDBRequest;
    vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === STORES.appStores) calls[method]++;
      return real.apply(this, args);
    } as never);
  }
  return calls;
}

describe("the stores' records read and written", () => {
  it("the Apps page opened with an unchanged index reads the stores once and writes none, and a running app reads none", async () => {
    const v1 = await installed();
    const [before] = await rows(STORES.appStores) as { fetchedAt: number }[];
    let now = NOW_MS + 3600_000;
    const store = apps(net, { now: () => now });
    const calls = counted();
    // What the Apps page asks as it opens: the stores, the update check, then the apps and the stores again, and the
    // apps once more as every screen that lists them hears of the check.
    await store.listStores();
    expect(await store.checkUpdates()).toMatchObject([{ ref: v1.ref, outcome: "none" }]);
    await store.list();
    const [listed] = await store.listStores();
    await store.list();
    expect(calls).toEqual({ get: 0, getAll: 1, put: 0 });
    expect(listed, "when it was last read is still told").toMatchObject({ fetchedAt: now, apps: [{ ref: v1.ref }] });
    expect(await rows(STORES.appStores)).toMatchObject([{ fetchedAt: before!.fetchedAt }]);

    calls.getAll = 0;
    await store.storageGet({ ref: v1.ref, scope: APP_SCOPE_ALONE, key: "game" });
    now += 3600_000;
    await store.refreshStores();
    await store.storageGet({ ref: v1.ref, scope: APP_SCOPE_ALONE, key: "game" });
    expect(calls, "the views a running app is checked against are kept").toEqual({ get: 0, getAll: 0, put: 0 });
  });

  it("an index that changed is written once, and a store that stops answering once", async () => {
    await installed();
    const store = apps(net);
    await store.listStores();
    const calls = counted();
    await net.putStore(await storeFiles({ sequence: 2, apps: [] }));
    expect(await store.refreshStores()).toMatchObject([{ sequence: 2, apps: [] }]);
    expect(calls).toEqual({ get: 0, getAll: 0, put: 1 });
    expect(await rows(STORES.appStores)).toMatchObject([{ index: { sequence: 2 } }]);
    calls.getAll = 0;
    expect((await store.list())[0]!.listedBy, "the engine lists from what it wrote").toEqual([]);

    net.files.delete(STORE_URL);
    const [failed] = await store.refreshStores();
    expect(failed!.problem).toBeTruthy();
    await store.refreshStores();
    expect(calls, "the same problem again is not written again").toEqual({ get: 0, getAll: 0, put: 2 });
    expect(await rows(STORES.appStores)).toMatchObject([{ problem: failed!.problem }]);
    calls.getAll = 0;

    await net.putStore(await storeFiles({ sequence: 2, apps: [] }));
    const [back] = await store.refreshStores();
    expect(back!.problem).toBeUndefined();
    expect(calls, "the problem is cleared in the record").toEqual({ get: 0, getAll: 0, put: 3 });
    expect((await rows(STORES.appStores) as { problem?: string }[])[0]!.problem).toBeUndefined();
  });

  it("a write that fails leaves what was held, and the next one is written", async () => {
    await installed();
    const store = apps(net);
    await net.putStore(await storeFiles({ sequence: 2, apps: [] }));
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new DOMException("full", "QuotaExceededError"); });
    await expect(store.refreshStores()).rejects.toThrow();
    expect(await store.listStores(), "as the record still says").toMatchObject([{ sequence: 1 }]);
    put.mockRestore();
    expect(await store.refreshStores()).toMatchObject([{ sequence: 2 }]);
    expect(await store.listStores()).toMatchObject([{ sequence: 2 }]);
    expect(await rows(STORES.appStores)).toMatchObject([{ index: { sequence: 2 } }]);
  });

  it("a fresh engine reads what another one wrote", async () => {
    await installed();
    await net.putStore(await storeFiles({ sequence: 3, apps: [] }));
    await apps(net).refreshStores();
    expect(await apps(net).listStores()).toMatchObject([{ sequence: 3, apps: [] }]);
  });
});
