import { beforeEach, describe, expect, it, vi } from "vitest";
import { settle, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { bootExtension, restartServiceWorker, useProfile } from "./extension";

// covers: extension.engine, profiles.switch

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
    useProfile(world, WORK);
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
    useProfile(world, WORK);
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
    useProfile(world, WORK);
    await ensure();
    await restartServiceWorker(world);
    await ensure();
    expect(log()).toEqual([`start ghostly_${WORK}`]);
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
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
    expect(log()).toEqual([]);
    letGo();
    expect(await reply).toEqual({ ok: true });
    expect(log()).toEqual([`start ghostly_${WORK}`]);
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

describe("a page of the profile before a switch", () => {
  it("does not reach the peer of the profile after it, and starts again instead", async () => {
    const reload = vi.fn();
    Object.assign(globalThis, { location: { reload } });
    try {
      const { openPageProfile } = await world.load("page", () => import("../src/profile.ts"));
      const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
      expect(openPageProfile()).toBe("");
      await extensionHost.connect(() => {}, () => {});
      expect(world.callsTo("runtime.connect")).toEqual([["ui"]]);

      useProfile(world, WORK);
      await expect(extensionHost.connect(() => {}, () => {})).rejects.toThrow("Switching profiles");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(world.callsTo("runtime.connect")).toHaveLength(1);
      expect(log()).toEqual(["start ghostly"]);
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });
});
