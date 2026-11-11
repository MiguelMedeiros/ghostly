import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { OTHER_PEER, PEER, SERVICE, TAG, bootExtension, openViewer, reloadExtension, restartServiceWorker } from "./extension";

// covers: services.open, app.updates.extension

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * A reload of the extension (Update and restart, chrome://extensions, off and on) forgets session storage, where a
 * viewer tab's binding lives, but the tab is an ordinary web tab and stays open with the contact's page in it. What
 * closes a contact's app (the lock screen, a profile switch, Clear all data, Hide my IP) must still close it.
 */

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

const send = (message: unknown) => world.chrome.runtime.sendMessage(message);

describe("a contact's app open when the extension reloads", () => {
  it("is closed by the new version, and stays closed through the lock screen", async () => {
    const viewer = await openViewer(world);
    const other = await world.chrome.tabs.create({ url: "https://example.com/" });

    await reloadExtension(world);
    fire(world.chrome.runtime.onInstalled, { reason: "update", previousVersion: "1.10.1" });
    await settle();
    await send({ target: "background", type: "close-services" });
    await settle();

    expect(world.tabs.has(viewer)).toBe(false);
    expect(world.tabs.has(other.id!)).toBe(true);
    expect([...world.local.keys()].filter((key) => key.startsWith("viewer:"))).toEqual([]);
  });

  it("is closed even when its page went to another address while no worker ran", async () => {
    const viewer = await openViewer(world, OTHER_PEER);
    // No debugger is on the tab any more, so nothing hears it leave the app's address.
    await reloadExtension(world, () => { world.tabs.get(viewer)!.url = "https://contact.example/"; });
    expect(world.tabs.has(viewer)).toBe(false);
  });

  it("is closed by the next lock when the reload left it open", async () => {
    const viewer = await openViewer(world);
    // The new worker found no target list (it failed): the next closer still finds the tab.
    const getTargets = world.chrome.debugger.getTargets;
    world.chrome.debugger.getTargets = (async () => { throw new Error("busy"); }) as never;
    await reloadExtension(world);
    world.chrome.debugger.getTargets = getTargets;
    expect(world.tabs.has(viewer)).toBe(true);

    await send({ target: "background", type: "close-services" });
    expect(world.tabs.has(viewer)).toBe(false);
  });

  it("is still served, and not closed, when only the idle worker restarts", async () => {
    const viewer = await openViewer(world);
    await restartServiceWorker(world);
    expect(world.tabs.has(viewer)).toBe(true);
    expect(world.session.has(`viewer:${viewer}`)).toBe(true);
  });

  it("never closes another tab that took the same id in a later browser run", async () => {
    const viewer = await openViewer(world);
    // The browser restarted: tab ids start over, and one of the person's tabs has the viewer's old id.
    world.tabs.set(viewer, { id: viewer, url: "https://example.com/", windowId: 1 });
    await reloadExtension(world);
    expect(world.tabs.has(viewer)).toBe(true);
    expect(world.local.has(`viewer:${viewer}`)).toBe(false);
  });

  it("forgets a viewer tab the person closed", async () => {
    const viewer = await openViewer(world, PEER, SERVICE, TAG);
    await settle();
    expect(world.local.has(`viewer:${viewer}`)).toBe(true);
    await world.chrome.tabs.remove(viewer);
    await settle();
    expect(world.local.has(`viewer:${viewer}`)).toBe(false);
  });
});
