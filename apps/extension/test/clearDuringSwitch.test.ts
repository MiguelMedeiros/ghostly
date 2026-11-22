import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { bootExtension, useProfile } from "./extension";
import { UI_PORT } from "../src/messages";

// covers: app.clear-data, profiles.switch

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
// One instance every document shares, so the fake peer reports the database its document chose (as in profiles.test.ts).
vi.mock("@ghostly/browser/shared/idb", async (actual) => await actual());
vi.mock("../../ui/src/lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/**
 * "Clear all data" takes a few seconds (the peer takes back what it can for up to `CLEAR_WITHDRAW_MS`, then stops and
 * empties its database; then the page clears the rest). A profile switch made meanwhile in another tab neither cuts the
 * peer's part short nor the page's: the clear runs to its end, then the peer and the page follow the switch.
 */

const WORK = "work000000";
/** node.ts `CLEAR_WITHDRAW_MS`: the peer's withdraw, which here never answers, is given up after it. */
const CLEAR_WITHDRAW_MS = 6_000;

let world: FakeWorld;

beforeEach(() => {
  resetEngine();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { location?: unknown }).location;
  delete (globalThis as { history?: unknown }).history;
});

const app = () => ({ id: world.chrome.runtime.id, url: world.chrome.runtime.getURL("app.html") });
const ensure = () => world.chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" });

describe("a switch in another tab while the peer clears the profile's data", () => {
  it.each([1, 2, 3])("the peer's document stays until its database is emptied, then the next profile's peer starts (run %i)", async () => {
    world = await bootExtension(undefined, (w) => useProfile(w, "", [WORK]));
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    const [peer] = engineControl().servers;
    const closes = () => world.callsTo("offscreen.closeDocument").length;
    let openWhenEmptied: boolean | null = null;
    // node.ts `clearProfileData`: the withdraw, given up after `CLEAR_WITHDRAW_MS`; then the peer stops and its stores go.
    peer.node.clearProfileData = async () => {
      await new Promise((resolve) => setTimeout(resolve, CLEAR_WITHDRAW_MS));
      await peer.node.shutdown();
      openWhenEmptied = closes() === 0;
    };
    const tab = world.connectFrom(app(), UI_PORT);

    vi.useFakeTimers();
    tab.postMessage({ kind: "request", id: 1, method: "clearProfileData", params: undefined });
    await vi.advanceTimersByTimeAsync(1_000);
    // A second into it, another tab makes Work the profile in use, and its page asks for the peer.
    useProfile(world, WORK);
    const switched = ensure();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await switched).toEqual({ ok: true });

    expect(openWhenEmptied).toBe(true);
    expect(closes()).toBe(1);
    expect(engineControl().log).toEqual(["start ghostly", "stop ghostly", `start ghostly_${WORK}`]);
  });

  it("a peer that never ends its clear does not hold up the switch for ever", async () => {
    world = await bootExtension(undefined, (w) => useProfile(w, "", [WORK]));
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    const [peer] = engineControl().servers;
    peer.node.clearProfileData = () => new Promise<void>(() => {});
    const tab = world.connectFrom(app(), UI_PORT);

    vi.useFakeTimers();
    tab.postMessage({ kind: "request", id: 1, method: "clearProfileData", params: undefined });
    await vi.advanceTimersByTimeAsync(1_000);
    useProfile(world, WORK);
    const switched = ensure();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await switched).toEqual({ ok: true });
    expect(engineControl().servers.at(-1)!.database).toBe(`ghostly_${WORK}`);
  });
});

describe("the page that runs Clear all data while another tab switches", () => {
  const exists = async (name: string) => (await indexedDB.databases()).some((db) => db.name === name);
  const create = (name: string) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const drop = (name: string) => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });

  it.each([1, 2, 3])("clears its own profile to the end, then starts again as the profile in use (run %i)", async () => {
    for (const name of ["ghostly-files", `ghostly_${WORK}-files`]) await drop(name);
    world = await bootExtension(undefined, (w) => useProfile(w, "", [WORK]));
    await create("ghostly-files");
    await create(`ghostly_${WORK}-files`);
    world.storage.set("ghostly_app_settings", "{}");
    world.storage.set(`ghostly_${WORK}_app_settings`, "{}");
    const order: string[] = [];
    Object.assign(globalThis, {
      window: new EventTarget(),
      location: { reload: () => order.push("reload") },
      history: { replaceState: () => {} },
    });

    // The page as ui/main.tsx starts it, on the first profile, with the extension's host.
    const { clearAllData, profile, extensionHost } = await world.load("page", async () => {
      const profile = await import("../src/profile.ts");
      const { extensionHost } = await import("../src/host.ts");
      const { setBrowserHost } = await import("@ghostly/browser/host");
      const { setStorageProfile } = await import("../../ui/src/lib/storage");
      const clear = await import("../../ui/src/lib/clearData");
      setStorageProfile(profile.openPageProfile());
      profile.followProfileSwitch("", profile.startAsProfileInUse);
      profile.finishBeforeSwitching(clear.clearInProgress);
      setBrowserHost(extensionHost);
      return { clearAllData: clear.clearAllData, profile, extensionHost };
    });
    const restart = vi.spyOn(extensionHost, "restartEngine");
    // The peer's part takes its seconds.
    let peerDone!: () => void;
    const { engine } = await world.load("page", () => import("@ghostly/browser/platform/engine"));
    vi.spyOn(engine, "call").mockImplementation((async (method: string) => {
      if (method === "clearProfileData") await new Promise<void>((resolve) => (peerDone = resolve));
    }) as never);

    const cleared = clearAllData().then(() => order.push("cleared"));
    await vi.waitFor(() => expect(peerDone).toBeTypeOf("function"));
    // Another tab makes Work the profile in use.
    useProfile(world, WORK);
    world.page.dispatchEvent(Object.assign(new Event("storage"), { key: "ghostly_profiles" }));
    expect(order).toEqual([]);

    peerDone();
    await cleared;
    await vi.waitFor(() => expect(order).toEqual(["cleared", "reload"]));
    expect(profile.pageProfileIsCurrent()).toBe(false);
    // Its own profile's settings and linked files are gone; Work's are untouched.
    expect(world.storage.has("ghostly_app_settings")).toBe(false);
    expect(world.storage.has(`ghostly_${WORK}_app_settings`)).toBe(true);
    expect(await exists("ghostly-files")).toBe(false);
    expect(await exists(`ghostly_${WORK}-files`)).toBe(true);
    // Work's peer, which the switch started, is not started again for a profile this page no longer runs as.
    expect(restart).toHaveBeenCalledTimes(1);
    expect(world.callsTo("runtime.sendMessage").filter(([m]) => (m as { type?: string })?.type === "restart-engine")).toEqual([]);
  });
});
