import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import type { Apps } from "../src/engine/apps";
import { STORES } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, PINNED_URL, REPO, STORE_URL, apps, bundle, emptyProfile, iconPng, listing, revocation, storeFiles, type Built } from "./appsSupport";
// covers: apps.engine.storage, apps.engine.installed

/*
 * A running app's calls (storage, files, the frames it sends) each ask for its installed record. It is read from
 * IndexedDB once and kept, and read again after a write here: an update, its publisher's revocations, an uninstall.
 */

let net: FakeNet;
let gets: ReturnType<typeof vi.spyOn>;
/** Reads of one record from the installed apps' store since the last `mockClear`. */
const reads = () => gets.mock.contexts.filter((store) => (store as IDBObjectStore).name === STORES.apps).length;

beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
  gets = vi.spyOn(IDBObjectStore.prototype, "get");
});
afterEach(() => gets.mockRestore());

async function installed(options: Parameters<typeof bundle>[0] = {}): Promise<{ store: Apps; app: Built }> {
  const app = await bundle(options);
  net.put(BUNDLE_URL, app.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: app.digest, grant: ["chat"] });
  return { store, app };
}

describe("an installed app's record", () => {
  it("is read once for a run of storage calls, file reads and frames", async () => {
    const { store, app } = await installed({ icon: iconPng() });
    const { ref } = app;
    gets.mockClear();
    for (let i = 0; i < 20; i++) await store.storageSet({ ref, scope: "chat-1", key: `k${i}`, value: i });
    for (let i = 0; i < 100; i++) expect(await store.storageGet({ ref, scope: "chat-1", key: `k${i % 20}` })).toEqual({ value: i % 20 });
    expect(await store.storageKeys({ ref, scope: "chat-1" })).toHaveLength(20);
    await store.storageDelete({ ref, scope: "chat-1", key: "k0" });
    for (let i = 0; i < 48; i++) await store.chatRunnable({ ref });
    await store.file({ ref, path: "icon.png" });
    await store.file({ ref, path: "data/openings.json" });
    expect(reads()).toBe(1);
  });

  it("is read once for calls made at the same time", async () => {
    const { store, app } = await installed();
    gets.mockClear();
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.storageGet({ ref: app.ref, scope: "chat-1", key: `k${i}` })));
    expect(reads()).toBe(1);
  });

  it("an update is seen by the next call", async () => {
    const { store, app } = await installed();
    await store.chatRunnable({ ref: app.ref });
    const v2 = await bundle({ sequence: 2, entry: "<!doctype html><title>Chess</title><p>second" });
    net.put(PINNED_URL, v2.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v2, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect((await store.entry({ ref: app.ref })).digest).toBe(v2.digest);
    expect(new TextDecoder().decode(await store.file({ ref: app.ref, path: "index.html" }))).toContain("second");
  });

  it("its publisher's new revocation stops the next call", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    await store.storageSet({ ref, scope: "chat-1", key: "k", value: 1 });
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(ref, [app.digest])]));
    await store.checkUpdates();
    await expect(store.storageGet({ ref, scope: "chat-1", key: "k" })).rejects.toThrow(/^stopped/);
    await expect(store.chatRunnable({ ref })).rejects.toThrow(/^stopped/);
  });

  it("an uninstall is seen by the next call, and so is installing it again", async () => {
    const { store, app } = await installed();
    const { ref } = app;
    await store.storageSet({ ref, scope: "chat-1", key: "k", value: 1 });
    await store.uninstall({ ref });
    await expect(store.storageGet({ ref, scope: "chat-1", key: "k" })).rejects.toThrow(/^not-installed/);
    await expect(store.chatRunnable({ ref }), "not this store's to refuse").resolves.toBeUndefined();
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: app.digest, grant: ["chat"] });
    expect(await store.storageGet({ ref, scope: "chat-1", key: "k" }), "the storage went with the uninstall").toBeNull();
  });

  it("a reference that is not installed is asked for each time, and nothing is kept for it", async () => {
    const { store } = await installed();
    const other = (await bundle({ name: "go" })).ref;
    gets.mockClear();
    for (let i = 0; i < 3; i++) await store.chatRunnable({ ref: other });
    expect(reads()).toBe(3);
    expect((store as unknown as { held: Map<string, unknown> }).held.has(other)).toBe(false);
  });
});
