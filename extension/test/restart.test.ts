import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { engineControl, okResponse, resetEngine } from "./fakeEngine";
import { OTHER_PEER, PEER, SERVICE, bodyText, bootExtension, engine, openViewer, pauseRequest, restartServiceWorker } from "./extension";

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * Chrome stops the service worker whenever it is idle (30 s without an event)
 * and starts it again for the next one. Whatever it kept in memory is gone;
 * `storage.session`, the tabs and the offscreen document are not.
 */

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

const send = (message: unknown) => world.chrome.runtime.sendMessage(message);

describe("after the service worker restarts", () => {
  it("still serves a viewer tab it opened before, from the binding in session storage", async () => {
    const tabId = await openViewer(world);
    await restartServiceWorker(world);

    engineControl().respond = async () => okResponse("still here");
    const answer = await pauseRequest(world, tabId, { url: `https://${SERVICE}.${PEER}.invalid/after-restart` });
    expect(answer.method).toBe("Fetch.fulfillRequest");
    expect(bodyText(answer.params)).toBe("still here");
    expect(engine().requests.map((r) => r.init.path)).toEqual(["/after-restart"]);
    // The peer that was running is the one that answered: no second document.
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
  });

  it("still refuses another origin in that tab: the binding, not memory, decides", async () => {
    const tabId = await openViewer(world);
    await restartServiceWorker(world);
    const answer = await pauseRequest(world, tabId, { url: `https://${SERVICE}.${OTHER_PEER}.invalid/` });
    expect(answer.method).toBe("Fetch.failRequest");
    expect(engine().requests).toEqual([]);
  });

  it("finds the running peer instead of creating another document", async () => {
    await send({ target: "background", type: "ensure-engine" });
    await restartServiceWorker(world);
    expect(await send({ target: "background", type: "ensure-engine" })).toEqual({ ok: true });
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
    expect(engineControl().servers).toHaveLength(1);
  });

  it("does not create a second document when it stopped while the first was still starting", async () => {
    let loadPeer!: () => void;
    const loaded = new Promise<void>((resolve) => (loadPeer = resolve));
    world.onCreateDocument = async () => {
      // The document exists at once; its script runs later.
      void loaded.then(() => world.load("offscreen", () => import("../src/offscreen.ts")));
    };
    void send({ target: "background", type: "ensure-engine" }).catch(() => {});
    await settle();
    expect(world.offscreenDocument).toBe(true);

    await restartServiceWorker(world);
    const reply = send({ target: "background", type: "ensure-engine" });
    await settle();
    loadPeer();
    expect(await reply).toEqual({ ok: true });
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
  });

  it("keeps an update Chrome announced before the restart", async () => {
    world.manifest.update_url = "https://clients2.google.com/service/update2/crx";
    fire(world.chrome.runtime.onUpdateAvailable, { version: "0.5.0" });
    await settle();
    await restartServiceWorker(world);

    const { extensionUpdates } = await world.load("page", () => import("../src/updates.ts"));
    expect(await extensionUpdates.check()).toEqual({ version: "0.5.0", apply: "restart" });
    expect(world.callsTo("runtime.requestUpdateCheck")).toEqual([]);
  });

  it("forgets a tab closed after the restart", async () => {
    const tabId = await openViewer(world);
    await restartServiceWorker(world);
    await world.chrome.tabs.remove(tabId);
    await settle();
    expect(world.session.has(`viewer:${tabId}`)).toBe(false);
  });

  it("registers its listeners exactly once per start", async () => {
    await restartServiceWorker(world);
    await restartServiceWorker(world);
    const background = (event: { listeners: { context: string }[] }) => event.listeners.filter((l) => l.context === "background").length;
    expect(background(world.chrome.runtime.onMessage as never)).toBe(1);
    expect(background(world.chrome.debugger.onEvent as never)).toBe(1);
    expect(background(world.chrome.action.onClicked as never)).toBe(1);
    expect(background(world.chrome.tabs.onRemoved as never)).toBe(1);
  });
});
