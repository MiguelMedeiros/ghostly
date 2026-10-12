import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, REPO, STORE_URL, apps, bundle, emptyProfile, listing, revocation, storeFiles, appRows, type Built } from "./appsSupport";
import type { Apps, InstalledApp } from "../src/engine/apps";
// covers: apps.takedown

/*
 * A frame runs the version it started with (WISP 1200 § Takedowns, "the version running"): an update installed while it
 * runs changes what is installed, not what runs. Its calls name its digest (what `entry` gave it), and that version is
 * the one judged: revoked or removed, it is refused with `stopped`, and the list names it so the page closes its frame.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

/** v1 installed and started, with a value kept in a chat. */
async function runningV1(): Promise<{ store: Apps; v1: Built }> {
  const v1 = await bundle({ sequence: 1, sources: [BUNDLE_URL] });
  net.put(BUNDLE_URL, v1.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  expect((await store.entry({ ref: v1.ref })).digest).toBe(v1.digest);
  await store.storageSet({ ref: v1.ref, digest: v1.digest, scope: "chat-1", key: "game", value: [1] });
  return { store, v1 };
}

/** Every call a running frame makes, as the version `digest`. */
function frameCalls(store: Apps, ref: string, digest: string): Promise<unknown>[] {
  return [
    store.storageGet({ ref, digest, scope: "chat-1", key: "game" }),
    store.storageSet({ ref, digest, scope: "chat-1", key: "game", value: [2] }),
    store.storageDelete({ ref, digest, scope: "chat-1", key: "game" }),
    store.storageKeys({ ref, digest, scope: "chat-1" }),
    store.file({ ref, digest, path: "index.html" }),
    store.chatRunnable({ ref, digest }),
  ];
}

describe("an app that runs while its update is installed", () => {
  it("is refused once the version it runs is revoked, at the check that installs the update", async () => {
    const { store, v1 } = await runningV1();
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest])]));
    expect(await store.checkUpdates()).toEqual([{ ref: v1.ref, outcome: "updated", run: { status: "ok" } }]);

    for (const call of frameCalls(store, v1.ref, v1.digest)) await expect(call).rejects.toThrow(/^stopped: /);
    expect(await store.storageGet({ ref: v1.ref, scope: "chat-1", key: "game" })).toEqual({ value: [1] });
    // The page learns which version to stop; the installed one is fine.
    const [view] = await store.list();
    expect(view).toMatchObject({ digest: v2.digest, run: { status: "ok" }, stopped: [{ digest: v1.digest, run: { status: "revoked", reason: "Leaked key" } }] });

    // The new version, started, runs.
    expect((await store.entry({ ref: v1.ref })).digest).toBe(v2.digest);
    await store.storageSet({ ref: v1.ref, digest: v2.digest, scope: "chat-1", key: "game", value: [3] });
    await store.chatRunnable({ ref: v1.ref, digest: v2.digest });
    expect(new TextDecoder().decode(await store.file({ ref: v1.ref, digest: v2.digest, path: "index.html" }))).toContain("v2");
    await expect(store.chatRunnable({ ref: v1.ref, digest: v1.digest })).rejects.toThrow(/^stopped: /);
  });

  it("is refused when the version it runs is revoked at a later check, and the revocation is kept while it may run", async () => {
    const { store, v1 } = await runningV1();
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    await store.checkUpdates();
    await store.chatRunnable({ ref: v1.ref, digest: v1.digest });

    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest])]));
    await store.checkUpdates();
    await expect(store.chatRunnable({ ref: v1.ref, digest: v1.digest })).rejects.toThrow(/^stopped: /);
    // The publisher's file no longer names it at the next check: what stops a version started here stays.
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([]));
    await store.checkUpdates();
    expect(((await appRows())[0] as InstalledApp).revocations).toHaveLength(1);
    await expect(store.storageKeys({ ref: v1.ref, digest: v1.digest, scope: "chat-1" })).rejects.toThrow(/^stopped: /);
    await store.chatRunnable({ ref: v1.ref });
  });

  it("is refused when a store of the person's removes the version it runs and lists the new one", async () => {
    const { store, v1 } = await runningV1();
    await net.putStore(await storeFiles({ apps: [listing(v1)] }));
    await store.addStore({ url: STORE_URL });
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    await net.putStore(await storeFiles({ sequence: 2, apps: [listing(v2)], removed: [{ ref: v1.ref, digest: v1.digest, reason: "Malware", at: 1 }] }));
    expect(await store.checkUpdates()).toMatchObject([{ outcome: "updated", run: { status: "ok" } }]);

    for (const call of frameCalls(store, v1.ref, v1.digest)) await expect(call).rejects.toThrow(/^stopped: Removed by Test store/);
    expect((await store.list())[0]).toMatchObject({ digest: v2.digest, run: { status: "ok" }, stopped: [{ digest: v1.digest, run: { status: "removed" } }] });
  });

  it("runs on while the version it runs is neither revoked nor removed, with its storage but not the new version's files", async () => {
    const { store, v1 } = await runningV1();
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    await store.checkUpdates();

    await store.storageSet({ ref: v1.ref, digest: v1.digest, scope: "chat-1", key: "game", value: [2] });
    expect(await store.storageGet({ ref: v1.ref, digest: v1.digest, scope: "chat-1", key: "game" })).toEqual({ value: [2] });
    await store.chatRunnable({ ref: v1.ref, digest: v1.digest });
    await expect(store.file({ ref: v1.ref, digest: v1.digest, path: "index.html" })).rejects.toThrow(/^no-file: /);
    expect((await store.list())[0]).not.toHaveProperty("stopped");
  });

  it("a version never started here does not run", async () => {
    const { store, v1 } = await runningV1();
    for (const call of frameCalls(store, v1.ref, "A".repeat(43))) await expect(call).rejects.toThrow(/^stopped: /);
    // Uninstalled and installed again: what ran before does not run on.
    await store.uninstall({ ref: v1.ref });
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v2.digest, grant: ["chat"] });
    await expect(store.chatRunnable({ ref: v1.ref, digest: v1.digest })).rejects.toThrow(/^stopped: /);
  });
});
