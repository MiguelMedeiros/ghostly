import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { PEER, SERVICE, TAG, bootExtension, endBootPeer, openViewer, restartServiceWorker, useProfile } from "./extension";

// covers: extension.engine, profiles.switch, app.clear-data, services.open

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
// Mocked modules outlive `vi.resetModules()`: as the real one, but one instance the fake peer and every
// offscreen document share, so the peer reports the database its document chose.
vi.mock("@ghostly/browser/shared/idb", async (actual) => await actual());

/**
 * Local profiles in the extension (WISP 04): one peer, in the offscreen document, runs the profile the
 * registry in localStorage names. A switch closes that document and opens another on the new profile.
 */

const WORK = "work000000";
const HOME = "home000000";

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

/** The worker loads with profile `id` already the one in use, and starts its peer. */
const bootOn = async (id: string) => (world = await bootExtension(undefined, (w) => useProfile(w, id)));
const ensure = () => world.chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" });
const log = () => engineControl().log;

describe("an install from before profiles", () => {
  it("runs the first profile on the original database and lock, with no registry written", async () => {
    expect(await ensure()).toEqual({ ok: true });
    expect(log()).toEqual(["start ghostly"]);
    expect(world.locks).toEqual(new Map([["ghostly-peer", "offscreen"]]));
    expect(world.storage.has("ghostly_profiles")).toBe(false);
  });

  it("stays on it when the registry names the first profile", async () => {
    useProfile(world, "", [WORK]);
    await ensure();
    await ensure();
    expect(log()).toEqual(["start ghostly"]);
    expect(world.callsTo("offscreen.closeDocument")).toEqual([]);
  });
});

describe("the peer runs the profile in use", () => {
  it("opens that profile's database and holds that profile's lock", async () => {
    resetEngine();
    await bootOn(WORK);
    await ensure();
    expect(log()).toEqual([`start ghostly_${WORK}`]);
    expect(world.locks).toEqual(new Map([[`ghostly-peer-${WORK}`, "offscreen"]]));
  });

  it("falls back to the first profile when the registry names one it does not list", async () => {
    world.storage.set("ghostly_profiles", JSON.stringify({ version: 1, active: WORK, profiles: [] }));
    await ensure();
    expect(log()).toEqual(["start ghostly"]);
  });
});

describe("clearing the profile's data", () => {
  it("starts a new peer on the same profile: the stopped one's document closes first", async () => {
    resetEngine();
    await bootOn(WORK);
    await ensure();
    expect(await world.chrome.runtime.sendMessage({ target: "background", type: "restart-engine" })).toEqual({ ok: true });
    expect(log()).toEqual([`start ghostly_${WORK}`, `stop ghostly_${WORK}`, `start ghostly_${WORK}`]);
    expect(world.calls.map((c) => c.api).filter((api) => api.startsWith("offscreen."))).toEqual(["offscreen.createDocument", "offscreen.closeDocument", "offscreen.createDocument"]);
    expect(world.locks).toEqual(new Map([[`ghostly-peer-${WORK}`, "offscreen"]]));
    // The next page finds it running, as it is.
    expect(await ensure()).toEqual({ ok: true });
    expect(log()).toHaveLength(3);
  });

  it("asked while a peer was still starting: a page that opens during it waits for the new peer, not the stopping one", async () => {
    endBootPeer(world);
    // The first document's script runs only when let go, so the restart is asked while that start goes on.
    let loadFirst!: () => void;
    const loaded = new Promise<void>((resolve) => (loadFirst = resolve));
    const createDocument = world.onCreateDocument;
    world.onCreateDocument = async () => {
      world.onCreateDocument = createDocument;
      void loaded.then(createDocument);
    };
    const first = ensure();
    await settle();
    const restart = world.chrome.runtime.sendMessage({ target: "background", type: "restart-engine" });
    await settle();
    // Not ready until its stop is held below: on a slow host the restart would stop it first.
    let ready!: () => void;
    engineControl().ready = new Promise<void>((resolve) => (ready = resolve));
    loadFirst();
    while (!engineControl().servers.length) await settle(1);
    // The stopped peer takes a moment to say goodbye.
    let stopped!: () => void;
    engineControl().servers[0].node.shutdown = () => new Promise<void>((resolve) => (stopped = () => { log().push("stop ghostly"); resolve(); }));
    ready();
    expect(await first).toEqual({ ok: true });

    let answered = false;
    const page = ensure().then((reply) => { answered = true; return reply; });
    await settle(20);
    expect(answered).toBe(false);
    stopped();
    expect(await restart).toEqual({ ok: true });
    expect(await page).toEqual({ ok: true });
    expect(log()).toEqual(["start ghostly", "stop ghostly", "start ghostly"]);
  });

  it("that fails leaves nothing unhandled in the worker: the page hears why", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await ensure();
      // The new document never answers.
      world.onCreateDocument = async () => {};
      expect(await world.chrome.runtime.sendMessage({ target: "background", type: "restart-engine" })).toEqual({
        ok: false,
        error: "Error: The Ghostly peer did not start. Reopen the extension to retry.",
      });
      await settle(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 10_000);
});

describe("switching", () => {
  it("stops the running peer and closes its document before the next profile's peer starts", async () => {
    await ensure();
    const page = world.chrome.runtime.connect({ name: "ui" });
    let dropped = 0;
    page.onDisconnect.addListener(() => dropped++);

    useProfile(world, WORK);
    expect(await ensure()).toEqual({ ok: true });

    expect(log()).toEqual(["start ghostly", "stop ghostly", `start ghostly_${WORK}`]);
    expect(world.calls.map((c) => c.api).filter((api) => api.startsWith("offscreen."))).toEqual(["offscreen.createDocument", "offscreen.closeDocument", "offscreen.createDocument"]);
    await settle();
    // The page was talking to the old peer: it hears that it went, and connects again (to the new one).
    expect(dropped).toBe(1);
    expect(world.locks).toEqual(new Map([[`ghostly-peer-${WORK}`, "offscreen"]]));
  });

  it("goes back to the first profile the same way", async () => {
    resetEngine();
    await bootOn(WORK);
    await ensure();
    useProfile(world, "", [WORK]);
    await ensure();
    expect(log()).toEqual([`start ghostly_${WORK}`, `stop ghostly_${WORK}`, "start ghostly"]);
    expect(world.locks).toEqual(new Map([["ghostly-peer", "offscreen"]]));
  });

  it("restarts once when several pages connect after a switch", async () => {
    await ensure();
    useProfile(world, HOME);
    expect(await Promise.all([ensure(), ensure(), ensure()])).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(log()).toEqual(["start ghostly", "stop ghostly", `start ghostly_${HOME}`]);
    expect(world.callsTo("offscreen.closeDocument")).toHaveLength(1);
  });

  it("follows the registry, not the worker's memory: a worker stopped since the switch still restarts the peer", async () => {
    await ensure();
    useProfile(world, WORK);
    await restartServiceWorker(world);
    await ensure();
    expect(log()).toEqual(["start ghostly", "stop ghostly", `start ghostly_${WORK}`]);
  });

  it("keeps a peer that was already on the new profile when the worker started again", async () => {
    resetEngine();
    await bootOn(WORK);
    await ensure();
    await restartServiceWorker(world);
    await ensure();
    expect(log()).toEqual([`start ghostly_${WORK}`]);
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
  });

  it("a second switch made while the first one's peer starts: the page of that profile gets that profile's peer", async () => {
    await ensure();
    // The first switch's peer takes a moment to open its database.
    let ready!: () => void;
    engineControl().ready = new Promise<void>((resolve) => (ready = resolve));
    useProfile(world, WORK);
    const first = ensure();
    while (engineControl().servers.length < 2) await settle(1);
    // Meanwhile another tab switches again, and its page asks for the peer.
    useProfile(world, HOME, [WORK]);
    const second = ensure();
    await settle();
    ready();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(engineControl().servers.at(-1)!.database).toBe(`ghostly_${HOME}`);
    expect(log()).toEqual(["start ghostly", "stop ghostly", `start ghostly_${WORK}`, `stop ghostly_${WORK}`, `start ghostly_${HOME}`]);
  });

  it("does not wait for ever on a peer that hangs while stopping", async () => {
    await ensure();
    const [old] = engineControl().servers;
    old.node.shutdown = () => new Promise<void>(() => {});
    useProfile(world, WORK);
    const started = Date.now();
    await ensure();
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(engineControl().servers.at(-1)!.database).toBe(`ghostly_${WORK}`);
  }, 10_000);

  it("never starts a second peer on a profile whose lock is still held", async () => {
    // What is left of a peer on WORK (a document still closing) holds its lock.
    let letGo!: () => void;
    void world.load("page", async () => navigator.locks.request(`ghostly-peer-${WORK}`, () => new Promise<void>((resolve) => (letGo = resolve))));
    await settle();
    useProfile(world, WORK);
    const reply = ensure();
    await settle();
    // The first profile's peer, which the worker started as it loaded, stopped; WORK's waits.
    expect(log()).toEqual(["start ghostly", "stop ghostly"]);
    letGo();
    expect(await reply).toEqual({ ok: true });
    expect(log()).toEqual(["start ghostly", "stop ghostly", `start ghostly_${WORK}`]);
  });

  it("says goodbye as the page goes away, and only once when a switch already stopped it", async () => {
    await ensure();
    const [first] = engineControl().servers;
    useProfile(world, WORK);
    await ensure();
    expect(first.shutdowns).toBe(1);
  });
});

describe("pages follow a switch made in another tab", () => {
  async function follow(running: string) {
    const { followProfileSwitch } = await world.load("page", () => import("../src/profile.ts"));
    const onSwitch = vi.fn();
    const stop = followProfileSwitch(running, onSwitch);
    const changed = (key: string | null) => world.page.dispatchEvent(Object.assign(new Event("storage"), { key }));
    return { onSwitch, stop, changed };
  }

  it("starts again when the registry names another profile", async () => {
    const { onSwitch, changed } = await follow("");
    useProfile(world, WORK);
    changed("ghostly_profiles");
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("stays when the registry changes without a switch (a profile added or renamed), or another key changes", async () => {
    useProfile(world, WORK);
    const { onSwitch, changed } = await follow(WORK);
    useProfile(world, WORK, [HOME]);
    changed("ghostly_profiles");
    changed("ghostly_app_settings");
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("notices storage cleared from another page", async () => {
    useProfile(world, WORK);
    const { onSwitch, changed } = await follow(WORK);
    world.storage.clear();
    changed(null);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("stops listening when asked", async () => {
    const { onSwitch, stop, changed } = await follow("");
    stop();
    useProfile(world, WORK);
    changed("ghostly_profiles");
    expect(onSwitch).not.toHaveBeenCalled();
  });
});

describe("a page that follows a switch starts again where the profile in use was left", () => {
  // This page showed a group of the profile before the switch: that id means nothing to the profile after it.
  async function startAgain(): Promise<{ hash: string; reloads: number }> {
    const page = { hash: "#/group/AAAAAAAAAAAAAAAAAAAAAA", reloads: 0 };
    Object.assign(globalThis, {
      location: { get hash() { return page.hash; }, reload: () => page.reloads++ },
      history: { replaceState: (_state: unknown, _title: string, url: string) => (page.hash = url) },
    });
    const { startAsProfileInUse } = await world.load("page", () => import("../src/profile.ts"));
    startAsProfileInUse();
    return page;
  }

  afterEach(() => {
    delete (globalThis as { location?: unknown }).location;
    delete (globalThis as { history?: unknown }).history;
  });

  it("on the chat list, for a profile never left on a page", async () => {
    useProfile(world, WORK);
    expect(await startAgain()).toEqual({ hash: "#/", reloads: 1 });
  });

  it("on the page that profile was left on", async () => {
    useProfile(world, WORK);
    world.storage.set(`ghostly_${WORK}_last_route`, "/chat/BBBBBBBBBBBBBBBBBBBBBB");
    expect(await startAgain()).toEqual({ hash: "#/chat/BBBBBBBBBBBBBBBBBBBBBB", reloads: 1 });
  });
});

describe("pages follow a peer started again in another tab", () => {
  const stored = (key: string, newValue: string | null) => world.page.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));

  it("the page that starts the peer again leaves the mark once the new peer runs", async () => {
    resetEngine();
    await bootOn(WORK);
    await ensure();
    const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
    expect(world.storage.has("ghostly_engine_restarted")).toBe(false);
    await extensionHost.restartEngine!();
    expect(log()).toEqual([`start ghostly_${WORK}`, `stop ghostly_${WORK}`, `start ghostly_${WORK}`]);
    expect(world.storage.has("ghostly_engine_restarted")).toBe(true);
  });

  it("another page starts again on the mark, and only on it", async () => {
    const { followEngineRestart } = await world.load("page", () => import("../src/profile.ts"));
    const onRestart = vi.fn();
    const stop = followEngineRestart(onRestart);
    stored("ghostly_app_settings", "{}");
    stored("ghostly_engine_restarted", null);
    expect(onRestart).not.toHaveBeenCalled();
    stored("ghostly_engine_restarted", "1");
    expect(onRestart).toHaveBeenCalledTimes(1);
    stop();
    stored("ghostly_engine_restarted", "2");
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

describe("a contact's app open as the profile before", () => {
  const url = `https://${SERVICE}.${PEER}.${TAG}.invalid/`;
  const paused = (tabId: number, requestId: string) =>
    fire(world.chrome.debugger.onEvent, { tabId }, "Fetch.requestPaused", { requestId, request: { url, method: "GET", headers: {} } });
  const servers = () => engineControl().servers;

  /** Its tab is gone, with its binding and the debugger, and nothing it asks for afterwards reaches any peer. */
  async function expectClosed(tabId: number): Promise<void> {
    expect(world.callsTo("tabs.remove")).toEqual([[tabId]]);
    expect(world.tabs.has(tabId)).toBe(false);
    expect(world.session.has(`viewer:${tabId}`)).toBe(false);
    expect(world.callsTo("debugger.detach")).toContainEqual([{ tabId }]);
    const before = world.callsTo("debugger.sendCommand").length;
    paused(tabId, "after");
    await settle(5);
    expect(world.callsTo("debugger.sendCommand").slice(before)).toEqual([]);
    expect(servers().flatMap((s) => s.requests)).toEqual([]);
  }

  it("closes when another profile becomes the one in use, before that profile's peer answers", async () => {
    const tabId = await openViewer(world);
    const other = await world.chrome.tabs.create({ url: "https://example.org/" });
    useProfile(world, WORK);
    expect(await ensure()).toEqual({ ok: true });
    expect(servers().at(-1)!.database).toBe(`ghostly_${WORK}`);
    await expectClosed(tabId);
    // Only the viewer: no other tab is touched.
    expect(world.tabs.has(other.id!)).toBe(true);
  });

  it("closes when the peer starts again (Clear all data)", async () => {
    const tabId = await openViewer(world);
    expect(await world.chrome.runtime.sendMessage({ target: "background", type: "restart-engine" })).toEqual({ ok: true });
    await expectClosed(tabId);
  });

  it("a request it made as the switch began is not sent to the next profile's peer", async () => {
    const tabId = await openViewer(world);
    useProfile(world, WORK);
    // The request waits on the switch it finds in progress.
    const switched = ensure();
    paused(tabId, "during");
    expect(await switched).toEqual({ ok: true });
    await settle(5);
    expect(servers().flatMap((s) => s.requests)).toEqual([]);
    expect(world.callsTo("debugger.sendCommand").filter(([, method]) => method === "Fetch.fulfillRequest")).toEqual([]);
  });

  it("closes when the profile locks (the lock screen's closeServiceWindows), as Desktop's windows do", async () => {
    const tabId = await openViewer(world);
    await world.load("page", () => import("../src/host.ts"));
    const { closeServiceWindows } = await world.load("page", () => import("../../ui/src/lib/serviceWindows.ts"));
    closeServiceWindows();
    await settle(5);
    await expectClosed(tabId);
  });

  it("does not open from a page of the profile before a switch: that page starts again instead", async () => {
    const reload = vi.fn();
    Object.assign(globalThis, { location: { reload }, history: { replaceState: vi.fn() } });
    try {
      await ensure();
      const { openPageProfile } = await world.load("page", () => import("../src/profile.ts"));
      const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
      openPageProfile();
      useProfile(world, WORK);
      await expect(extensionHost.openService!(PEER, SERVICE, TAG)).rejects.toThrow("Switching profiles");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(world.callsTo("tabs.create")).toEqual([]);
    } finally {
      delete (globalThis as { location?: unknown }).location;
      delete (globalThis as { history?: unknown }).history;
    }
  });
});

describe("a page of the profile before a switch", () => {
  it("does not reach the peer of the profile after it, and starts again instead", async () => {
    const reload = vi.fn();
    const replaceState = vi.fn();
    Object.assign(globalThis, { location: { reload }, history: { replaceState } });
    try {
      const { openPageProfile } = await world.load("page", () => import("../src/profile.ts"));
      const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
      expect(openPageProfile()).toBe("");
      await extensionHost.connect(() => {}, () => {});
      expect(world.callsTo("runtime.connect")).toEqual([["ui"]]);

      useProfile(world, WORK);
      await expect(extensionHost.connect(() => {}, () => {})).rejects.toThrow("Switching profiles");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(null, "", "#/");
      expect(world.callsTo("runtime.connect")).toHaveLength(1);
      expect(log()).toEqual(["start ghostly"]);
    } finally {
      delete (globalThis as { location?: unknown }).location;
      delete (globalThis as { history?: unknown }).history;
    }
  });
});
