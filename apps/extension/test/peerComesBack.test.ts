import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { bootExtension, restartServiceWorker } from "./extension";
import { UI_PORT } from "../src/messages";

// covers: extension.engine

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * The peer runs with no page open (it fetches mailbox texts that live minutes, answers contacts, keeps groups in
 * step), so it must come back by itself when its document went away with no Ghostly tab open, and when the extension
 * is turned on again: Chrome fires neither `onStartup` nor `onInstalled` for that, and turning it off closed every tab.
 */

let world: FakeWorld;
const documents = () => world.callsTo("offscreen.createDocument").length;
const PEER_CHECK = "peer-check";

beforeEach(() => {
  resetEngine();
});

describe("the peer starts again by itself", () => {
  it("when the extension is turned on again: the worker starts with no event and no tab", async () => {
    world = await bootExtension();
    await vi.waitFor(() => expect(world.offscreenDocument).toBe(true));
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    expect(world.tabs.size).toBe(0);
  });

  it("when its document went away with no tab open, at the worker's next start", async () => {
    world = await bootExtension();
    fire(world.chrome.runtime.onStartup);
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));

    world.endOffscreen();
    await restartServiceWorker(world);
    await vi.waitFor(() => expect(world.offscreenDocument).toBe(true));
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(2));
    expect(documents()).toBe(2);
  });

  it("when its document went away while the worker sat idle: the next check brings it back", async () => {
    world = await bootExtension();
    fire(world.chrome.runtime.onStartup);
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    await settle();

    world.endOffscreen();
    await settle();
    expect(world.offscreenDocument).toBe(false);
    const [check] = [...world.alarms.keys()];
    expect(check).toBeDefined();
    expect(world.alarms.get(check)?.periodInMinutes).toBeGreaterThan(0);
    world.fireAlarm(check);
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(2));
    expect(documents()).toBe(2);
  });
});
describe("a document that never answers is not kept", () => {
  /**
   * A page connected through the extension's host; the peer's document goes away, and the next one is created but its
   * script never listens (it threw as it loaded, a chunk did not load). The page tries again for 3 minutes, the worker
   * starts again, the minute check runs 3 times, and then a new document's script would load: the page must get a peer.
   */
  it.each([1, 2, 3])("is closed, and a new one runs once one can (run %i)", async () => {
    world = await bootExtension();
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
    const { engine: client } = await world.load("page", async () => {
      (await import("@ghostly/browser/host")).setBrowserHost(extensionHost);
      return import("@ghostly/browser/platform/engine");
    });
    await client.connect();
    expect(engineControl().servers[0].attached).toHaveLength(1);

    const loads = world.onCreateDocument;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      world.onCreateDocument = async () => {};
      world.endOffscreen();
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(client.reconnecting).toBe(true);

      const restarted = restartServiceWorker(world);
      await vi.advanceTimersByTimeAsync(15_000);
      await restarted;
      for (let i = 0; i < 3; i++) {
        world.fireAlarm(PEER_CHECK);
        await vi.advanceTimersByTimeAsync(60_000);
      }

      world.onCreateDocument = loads;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(client.reconnecting).toBe(false);
      expect(engineControl().servers).toHaveLength(2);
      expect(engineControl().servers[1].attached).toHaveLength(1);
      expect(world.callsTo("offscreen.closeDocument").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});


describe("a peer that stopped for good is not taken for a running one", () => {
  const app = () => ({ id: world.chrome.runtime.id, url: world.chrome.runtime.getURL("app.html") });

  /**
   * "Clear all data" from a page: the engine takes back what it can and stops (`clearProfileData`), and the page goes
   * away before it asks for a new peer (`restart-engine`, the clear's last step): closed or reloaded right then.
   */
  async function clearedAndTabClosed(): Promise<void> {
    world = await bootExtension();
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    const tab = world.connectFrom(app(), UI_PORT);
    tab.postMessage({ kind: "request", id: 1, method: "clearProfileData", params: undefined });
    await vi.waitFor(() => expect(engineControl().servers[0].shutdowns).toBe(1));
    await settle();
    tab.disconnect();
    await settle();
  }

  /** A new peer runs, in a new document, and a page that connects now is handed it, not the stopped one. */
  async function newPeerRuns(): Promise<void> {
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(2));
    expect(engineControl().servers.map((s) => s.shutdowns)).toEqual([1, 0]);
    expect(documents()).toBe(2);
    const [stopped, fresh] = engineControl().servers;
    const before = stopped.attached.length;
    world.connectFrom(app(), UI_PORT);
    await settle();
    expect(stopped.attached).toHaveLength(before);
    expect(fresh.attached).toHaveLength(1);
  }

  it("a tab opened later starts a new peer", async () => {
    await clearedAndTabClosed();
    expect(await world.chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" })).toEqual({ ok: true });
    await newPeerRuns();
  });

  it("the worker's next start brings a new peer", async () => {
    await clearedAndTabClosed();
    await restartServiceWorker(world);
    await newPeerRuns();
  });

  it("the minute check brings a new peer", async () => {
    await clearedAndTabClosed();
    world.fireAlarm([...world.alarms.keys()][0]);
    await newPeerRuns();
  });

  it("a worker gone mid-restart, after the peer stopped and before its document closed: the next start replaces it", async () => {
    world = await bootExtension();
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    // What `replaceEngine` did before the worker went away: the peer stopped, its document still there.
    expect(await world.chrome.runtime.sendMessage({ target: "engine", type: "stop" })).toBe(true);
    await restartServiceWorker(world);
    await newPeerRuns();
  });
});

describe("a peer that runs is left alone", () => {
  it("each start of the worker, and each check, finds it instead of making another", async () => {
    world = await bootExtension();
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
    await restartServiceWorker(world);
    world.fireAlarm([...world.alarms.keys()][0]);
    await settle();
    expect(await world.chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" })).toEqual({ ok: true });
    expect(documents()).toBe(1);
    expect(engineControl().servers).toHaveLength(1);
    expect(world.callsTo("offscreen.closeDocument")).toEqual([]);
  });

  it("sets the check once: a worker that starts again does not put it off", async () => {
    world = await bootExtension();
    await settle();
    await restartServiceWorker(world);
    await restartServiceWorker(world);
    await settle();
    expect(world.callsTo("alarms.create")).toHaveLength(1);
  });
});
