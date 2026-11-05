import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { bootExtension, restartServiceWorker } from "./extension";

// covers: extension.engine

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * The peer runs with no page open (it fetches mailbox texts that live minutes, answers contacts, keeps groups in
 * step), so it must come back by itself when its document went away with no Ghostly tab open, and when the extension
 * is turned on again: Chrome fires neither `onStartup` nor `onInstalled` for that, and turning it off closed every tab.
 */

let world: FakeWorld;
const documents = () => world.callsTo("offscreen.createDocument").length;

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
