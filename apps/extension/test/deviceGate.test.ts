import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { PEER, SERVICE, bootExtension, useProfile } from "./extension";

// covers: devices.gate, extension.engine

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
vi.mock("@ghostly/browser/shared/idb", async (actual) => await actual());

/**
 * The gate in the extension (WISP 06 § The gate). The peer lives in the offscreen document, which the service worker
 * creates when the browser starts, with no page open: the device state is read there, before the engine is made. A
 * device that is not the active one for the profile gets the document (device-link-only mode lives in it) and no
 * engine: no peer database, no wallet, nothing published.
 */

const WORK = "work000000";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Puts a profile in a state directly: nothing can enroll a device yet. */
async function putState(profile: string, state: "active" | "standby" | "superseded" | "removed"): Promise<void> {
  const store = await import("@ghostly/browser/devices/store");
  await store.writeDeviceRecord({ v: 1, profile, state, saved: 1, turn: 4, rev: 0, deviceSet: [{ key: KEY, name: "MacBook" }, { key: KEY, name: "This browser" }], activeSlot: 0, ownSlot: 1, takeovers: 0, earlierSets: [] });
  await store.closeDevicesDb();
}
const dropDevices = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase("ghostly-devices"); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });

let world: FakeWorld;
const ensure = () => world.chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" });
const log = () => engineControl().log;

beforeEach(async () => {
  resetEngine();
  await (await import("@ghostly/browser/devices/store")).closeDevicesDb();
  await dropDevices();
});

describe("a profile with no device set", () => {
  it("starts the engine at browser start exactly as before", async () => {
    world = await bootExtension();
    fire(world.chrome.runtime.onStartup);
    expect(await ensure()).toEqual({ ok: true });
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
    expect(log()).toEqual(["start ghostly"]);
    expect(engineControl().servers[0].options).toEqual({ platform: "extension", irohWeb: true, defaultWallets: expect.any(Function) });
  });
});

describe("the active device", () => {
  it("starts the engine", async () => {
    await putState("ghostly", "active");
    world = await bootExtension();
    expect(await ensure()).toEqual({ ok: true });
    expect(log()).toEqual(["start ghostly"]);
  });
});

describe.each(["standby", "superseded", "removed"] as const)("a device that is %s", (state) => {
  it("makes no engine when the browser starts with no page open, or when the extension is installed or updated", async () => {
    await putState("ghostly", state);
    world = await bootExtension();
    fire(world.chrome.runtime.onStartup);
    expect(await ensure()).toEqual({ ok: true });
    fire(world.chrome.runtime.onInstalled, { reason: "update", previousVersion: "1.0.2" });
    expect(await ensure()).toEqual({ ok: true });
    // The document is there (it is where device-link-only mode runs), and it holds the profile's lock.
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
    expect(world.locks).toEqual(new Map([["ghostly-peer", "offscreen"]]));
    // No engine was ever made: nothing opened the peer database, started a wallet or published.
    expect(engineControl().servers).toHaveLength(0);
    expect(log()).toEqual([]);
  });

  it("tells a page its state in place of the engine's, and refuses every call", async () => {
    await putState("ghostly", state);
    world = await bootExtension();
    expect(await ensure()).toEqual({ ok: true });
    const port = world.chrome.runtime.connect({ name: "ui" });
    const heard: unknown[] = [];
    port.onMessage.addListener((message: unknown) => heard.push(message));
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toEqual({ kind: "device-gate", gate: { state, activeDevice: "MacBook" } });

    port.postMessage({ kind: "request", id: 5, method: "sendMessage", params: { linkId: "a", text: "hello" } });
    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(heard[1]).toEqual({ kind: "response", id: 5, error: "This profile is not active on this device" });
    expect(engineControl().servers).toHaveLength(0);
  });

  it("serves no contact's app, and stops without an engine to stop", async () => {
    await putState("ghostly", state);
    world = await bootExtension();
    expect(await ensure()).toEqual({ ok: true });
    const reply = await world.chrome.runtime.sendMessage({ target: "engine", type: "http-request", peerPubKeyZ32: PEER, serviceId: SERVICE, method: "GET", path: "/", headers: [], bodyB64: null });
    expect(reply).toEqual({ ok: false, code: "offline", message: "This profile is not active on this device" });
    expect(await world.chrome.runtime.sendMessage({ target: "engine", type: "stop" })).toBe(true);
    expect(log()).toEqual([]);
  });
});

describe("the state is the profile's own", () => {
  it("a standby profile does not stop another profile of the same browser, and a switch to it starts no engine", async () => {
    await putState(`ghostly_${WORK}`, "standby");
    world = await bootExtension();
    expect(await ensure()).toEqual({ ok: true });
    expect(log()).toEqual(["start ghostly"]);

    useProfile(world, WORK);
    expect(await ensure()).toEqual({ ok: true });
    expect(world.callsTo("offscreen.closeDocument")).toHaveLength(1);
    // The first profile's engine stopped; the standby one got none.
    expect(log()).toEqual(["start ghostly", "stop ghostly"]);
    expect(world.locks).toEqual(new Map([[`ghostly-peer-${WORK}`, "offscreen"]]));

    useProfile(world, "", [WORK]);
    expect(await ensure()).toEqual({ ok: true });
    expect(log()).toEqual(["start ghostly", "stop ghostly", "start ghostly"]);
  });
});
