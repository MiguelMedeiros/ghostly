import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { bootExtension, useProfile } from "./extension";

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
vi.mock("../../ui/src/lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/*
 * A page that keeps running as its profile after another tab switched (it finishes a restore or a clear first) reads,
 * adds and removes the local addresses of its own profile's list, never those of the profile the peer runs now.
 */

const WORK = "work000000";
const ORIGIN = "http://localhost:9000";
let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
  useProfile(world, "", [WORK]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A page of the first profile. Each test then has another tab make Work the profile in use; the page does not start again. */
const openPage = () =>
  world.load("page", async () => {
    (await import("../src/profile.ts")).openPageProfile();
    return (await import("../src/host.ts")).extensionHost;
  });

/** Work's peer database with an app at ORIGIN, as the engine keeps it: Chrome's pattern stays while it is there. */
async function workShares(): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`ghostly_${WORK}`);
    request.onupgradeneeded = () => request.result.createObjectStore("services", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("services", "readwrite");
    tx.objectStore("services").put({ id: "app", name: "app", target: ORIGIN, enabled: true, createdAt: 0 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const allowed = (ns: string) => world.within("page", async () => (await import("../src/localAllowList.ts")).localOriginAllowed(ns, ORIGIN));

describe("local addresses from a page of the profile before a switch", () => {
  it("an Allow goes on the page's own profile's list", async () => {
    const host = await openPage();
    useProfile(world, WORK, [WORK]);
    expect(await host.requestLocalAccess!("http://localhost/*", ORIGIN)).toBe(true);
    expect(await allowed(""), "the page's profile allowed it").toBe(true);
    expect(await allowed(WORK), "Work's person never allowed it").toBe(false);
  });

  it("reads the page's own profile's list", async () => {
    world.hostAccess.add("http://localhost/*");
    await world.within("page", async () => (await import("../src/localAllowList.ts")).allowLocalOrigin("", ORIGIN));
    const host = await openPage();
    useProfile(world, WORK, [WORK]);
    // Its own app shows as allowed, with no Allow that would land anywhere.
    expect(await host.localAccessAllowed!(ORIGIN)).toBe(true);
  });

  it("removes from the page's own profile's list", async () => {
    world.hostAccess.add("http://localhost/*");
    await world.within("page", async () => {
      const list = await import("../src/localAllowList.ts");
      await list.allowLocalOrigin("", ORIGIN);
      await list.allowLocalOrigin(WORK, ORIGIN);
    });
    await workShares();
    const host = await openPage();
    useProfile(world, WORK, [WORK]);
    await world.within("page", () => host.forgetLocalAccess!(ORIGIN));
    // The lists themselves: Chrome's pattern stays, Work's app being at that host.
    const listed = (ns: string) => world.within("page", async () => (await import("../src/localAllowList.ts")).allowedOrigins(ns));
    expect(await listed(""), "the page's profile's app went").toEqual([]);
    expect(await listed(WORK), "Work's list is Work's").toEqual([ORIGIN]);
    expect(world.hostAccess.has("http://localhost/*")).toBe(true);
    await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(`ghostly_${WORK}`); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  });
});
