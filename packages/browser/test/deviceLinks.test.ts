import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, deviceLinkParams, fromBase64Url, newDeviceSetSecret, randomBytes, toBase64Url, type DeviceFrame, type NativeTransport } from "@ghostly/core";
import { openDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { DeviceLinkOnlyServer } from "../src/devices/linkOnly";
import { DeviceLinks, type DeviceLinksOptions } from "../src/devices/links";
import { createPeerServer } from "../src/devices/peer";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceRecord, DeviceSlot, StoredDeviceState } from "../src/devices/state";
import { DEVICES_DB, closeDevicesDb, setDeviceMirror } from "../src/devices/store";
import { EngineServer } from "../src/engine/server";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
import { NativeWorld } from "../../core/test/support/nativeWorld";
// covers: devices.links.session, devices.gate

/*
 * Device links as device-link-only mode runs them (WISP 06 § Terms, § The gate). No profile can enroll a device yet,
 * so each test writes device records directly, as enrollment, the handoff and removal will: one profile name per
 * "device" in this one process, each with a signing key of its own. Every key and secret is made in the test.
 */

interface TestDevice { profile: string; name: string; key: DeviceSigningKey; slot: DeviceSlot; links: DeviceLinks; frames: [string, DeviceFrame][] }

let pkarr: MemoryPkarr;
const engines: DeviceLinks[] = [];
const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); await yieldToLoop(); }
}
/** Waits for something that takes real turns of the loop (the database, WebCrypto) while the fake clock runs. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => { done = true; });
  tracked.catch(() => {});
  for (let i = 0; !done && i < 400; i++) await run(250);
  return tracked;
}

/** A device's signing key, half of them non-extractable and half stored seeds: a link joins either form. */
async function makeDevice(name: string, options: Partial<DeviceLinksOptions> = {}): Promise<TestDevice> {
  const profile = `ghostly_${name.toLowerCase()}`;
  const key = await createDeviceSigningKey(profile, { forceSeed: engines.length % 2 === 1 });
  const frames: [string, DeviceFrame][] = [];
  const links = new DeviceLinks({
    profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection(name),
    onFrame: (from, frame) => { frames.push([from, frame]); }, ...options,
  });
  engines.push(links);
  return { profile, name, key, slot: { key: toBase64Url(key.publicKey), name }, links, frames };
}

/** Writes a device's record as the later parts will: the set by slot, this device's slot, the secret. */
async function write(device: TestDevice, state: StoredDeviceState, d: Uint8Array, set: (TestDevice | null)[], patch: Partial<DeviceRecord> = {}): Promise<void> {
  const ownSlot = set.indexOf(device);
  await putDeviceRecord({
    v: 1, profile: device.profile, state, saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [],
    deviceSet: set.map((member) => member?.slot ?? null), activeSlot: 0, d: toBase64Url(d), signingKey: device.key.kind,
    ...(ownSlot >= 0 ? { ownSlot } : {}), ...patch,
  });
}

const liveBetween = (a: TestDevice, b: TestDevice) => a.links.live(b.slot.key) && b.links.live(a.slot.key);
async function until(condition: () => boolean, limit: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (condition()) return true;
    await run(250);
  }
  return condition();
}
/** The rendezvous keys of the link between two devices under `d`. */
const rendezvous = (d: Uint8Array, a: TestDevice, b: TestDevice) => [deviceLinkParams(d, a.key.publicKey, b.key.publicKey).peerPubKeyZ32, deviceLinkParams(d, b.key.publicKey, a.key.publicKey).peerPubKeyZ32];

beforeEach(async () => {
  setDeviceMirror(null); resetDeviceGates();
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
  useFakeWorld();
  pkarr = new MemoryPkarr(DESKTOP_NETWORK);
});
afterEach(async () => {
  const stopping = Promise.all(engines.splice(0).map((links) => links.stop()));
  if (vi.isFakeTimers()) { await settled(stopping); await closeWorld(); } else await stopping;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the device links of a profile on this device", () => {
  it("join a standby and the active device from their device records alone: live, a ping echoed, and no profile database opened", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone");
    expect([desktop.key.kind, phone.key.kind]).toEqual(["webcrypto", "seed"]);
    await write(desktop, "active", d, [desktop, phone]);
    await write(phone, "standby", d, [desktop, phone]);
    await settled(Promise.all([desktop.links.start(), phone.links.start()]));
    expect(await until(() => liveBetween(desktop, phone), 60_000)).toBe(true);
    expect(desktop.links.views()).toEqual([{ key: phone.slot.key, name: "Phone", slot: 1, status: "live", transport: "webrtc/1" }]);
    expect(phone.links.views()).toEqual([{ key: desktop.slot.key, name: "Desktop", slot: 0, status: "live", transport: "webrtc/1" }]);
    expect(await settled(phone.links.ping(desktop.slot.key))).toBeGreaterThanOrEqual(0);
    expect(await settled(desktop.links.ping(phone.slot.key))).toBeGreaterThanOrEqual(0);
    // The link's own frames are not handed on; another `devices/1` frame is, with who sent it.
    phone.links.send(desktop.slot.key, { t: "set-ack" });
    await run(1_000);
    expect(desktop.frames).toEqual([[phone.slot.key, { t: "set-ack" }]]);
    expect(phone.frames).toEqual([]);
    // Only the device state and the device keys: no profile's peer database exists, let alone was opened.
    expect((await indexedDB.databases()).map((db) => db.name).sort()).toEqual([DEVICE_KEYS_DB, DEVICES_DB].sort());
    // The relays were asked for the link's two rendezvous keys and nothing else.
    const keys = rendezvous(d, desktop, phone).sort();
    expect([...pkarr.readsByKey.keys()].sort()).toEqual(keys);
    expect([...pkarr.publishesByKey.keys()].sort()).toEqual(keys);
  });

  it("hold in every state that is not the active one and has a device set, and not when the device was removed", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop");
    await write(desktop, "active", d, [desktop, null, null, null]);
    for (const state of ["standby", "releasing", "taking", "superseded", "moving"] as const) {
      const other = await makeDevice(`Device-${state}`);
      await write(other, state, d, [desktop, other]);
      await settled(other.links.start());
      expect(other.links.views().map((v) => [v.name, v.slot]), state).toEqual([["Desktop", 0]]);
    }
    const removed = await makeDevice("Removed");
    await write(removed, "removed", d, [desktop, removed]);
    await settled(removed.links.start());
    expect(removed.links.views()).toEqual([]);
    expect(removed.links.problem).toBeNull();
  });

  it("three devices: every two have a link, though none of them enrolled the other", async () => {
    const d = newDeviceSetSecret();
    const devices = [await makeDevice("Desktop"), await makeDevice("Phone"), await makeDevice("Laptop")];
    for (const [i, device] of devices.entries()) await write(device, i === 0 ? "active" : "standby", d, devices);
    await settled(Promise.all(devices.map((device) => device.links.start())));
    const pairs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => [devices[a], devices[b]] as const);
    expect(await until(() => pairs.every(([a, b]) => liveBetween(a, b)), 90_000)).toBe(true);
    expect(await settled(devices[1].links.ping(devices[2].slot.key))).toBeGreaterThanOrEqual(0);
  });

  it("a device that no longer holds the current D loses its links when the set moves, and derives none of the new ones", async () => {
    const oldD = newDeviceSetSecret(), newD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), lost = await makeDevice("Lost");
    const all = [desktop, phone, lost];
    for (const [i, device] of all.entries()) await write(device, i === 0 ? "active" : "standby", oldD, all);
    await settled(Promise.all(all.map((device) => device.links.start())));
    expect(await until(() => liveBetween(desktop, lost) && liveBetween(phone, lost) && liveBetween(desktop, phone), 90_000)).toBe(true);

    // The set moves to a new D without the third device (removal, a later part, writes exactly this): slot 2 is empty.
    await write(desktop, "active", newD, [desktop, phone, null]);
    await write(phone, "standby", newD, [desktop, phone, null]);
    await settled(Promise.all([desktop.links.refresh(), phone.links.refresh()]));
    // The staying devices hold one link each, under the new D; the old ones are closed, the removed device's too.
    expect(desktop.links.views().map((v) => v.name)).toEqual(["Phone"]);
    expect(phone.links.views().map((v) => v.name)).toEqual(["Desktop"]);
    expect(await until(() => !lost.links.live(desktop.slot.key) && !lost.links.live(phone.slot.key), 30_000)).toBe(true);
    expect(await until(() => liveBetween(desktop, phone), 60_000)).toBe(true);

    // The removed device still holds the old D, its own key and both public keys. It keeps trying, for minutes.
    const publishedBefore = new Map(pkarr.publishesByKey);
    await run(180_000);
    expect(lost.links.live(desktop.slot.key)).toBe(false);
    expect(lost.links.live(phone.slot.key)).toBe(false);
    expect(lost.links.views().every((v) => v.status === "connecting")).toBe(true);
    await expect(settled(lost.links.ping(desktop.slot.key, 1_000))).rejects.toThrow();
    expect(desktop.links.live(lost.slot.key)).toBe(false);
    expect(phone.links.live(lost.slot.key)).toBe(false);
    // It never asks for, or writes, a rendezvous key of the new set: it cannot compute one.
    const fresh = rendezvous(newD, desktop, phone);
    const stale = [...rendezvous(oldD, desktop, lost), ...rendezvous(oldD, phone, lost)];
    for (const key of fresh) expect(stale).not.toContain(key);
    // And the staying devices no longer publish at the old link's keys: what the removed device reads there is what was left.
    const oldKeysOfStaying = [deviceLinkParams(oldD, lost.key.publicKey, desktop.key.publicKey).peerPubKeyZ32, deviceLinkParams(oldD, lost.key.publicKey, phone.key.publicKey).peerPubKeyZ32];
    for (const key of oldKeysOfStaying) expect(pkarr.publishesByKey.get(key)).toBe(publishedBefore.get(key));
    expect(desktop.frames).toEqual([]);
    expect(phone.frames).toEqual([]);
  });

  it("a key the device set does not list gets no link, whatever D it holds", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), stranger = await makeDevice("Stranger");
    await write(desktop, "active", d, [desktop, phone]);
    await write(phone, "standby", d, [desktop, phone]);
    // It holds D and lists itself beside the others; nobody else's record lists it.
    await write(stranger, "standby", d, [desktop, phone, stranger]);
    await settled(Promise.all([desktop, phone, stranger].map((device) => device.links.start())));
    expect(await until(() => liveBetween(desktop, phone), 60_000)).toBe(true);
    await run(120_000);
    expect(stranger.links.views().map((v) => v.status)).toEqual(["connecting", "connecting"]);
    expect(desktop.links.views().map((v) => v.name)).toEqual(["Phone"]);
    expect(phone.links.views().map((v) => v.name)).toEqual(["Desktop"]);
  });

  it("keeps the old link to a staying device that has not taken the new D yet, and to no one else", async () => {
    const oldD = newDeviceSetSecret(), newD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), lost = await makeDevice("Lost");
    // The remover: under the new D with the phone, and the old set kept with the phone still to acknowledge.
    await write(desktop, "active", newD, [desktop, phone, null], { earlierSets: [{ d: toBase64Url(oldD), tombstone: "", setUpdate: "{}", pending: [phone.slot.key] }] });
    // The phone was off: it still holds the old D and is `moving`. The removed device holds the old D too.
    await write(phone, "moving", oldD, [desktop, phone, lost]);
    await write(lost, "standby", oldD, [desktop, phone, lost]);
    await settled(Promise.all([desktop, phone, lost].map((device) => device.links.start())));
    expect(desktop.links.views().map((v) => [v.name, v.earlier ?? false]).sort()).toEqual([["Phone", false], ["Phone", true]]);
    // The old link joins the remover and the moving device; the removed one reaches the remover on none.
    expect(await until(() => phone.links.live(desktop.slot.key), 60_000)).toBe(true);
    desktop.links.send(phone.slot.key, { t: "set-update", d: "the frame the removal part defines" });
    await run(1_000);
    expect(phone.frames).toEqual([[desktop.slot.key, { t: "set-update", d: "the frame the removal part defines" }]]);
    await run(60_000);
    expect(lost.links.live(desktop.slot.key)).toBe(false);
    // Acknowledged: the old link goes.
    await write(desktop, "active", newD, [desktop, phone, null]);
    await settled(desktop.links.refresh());
    expect(desktop.links.views().map((v) => [v.name, v.earlier ?? false])).toEqual([["Phone", false]]);
  });

  it("run on a native transport where one device has no WebRTC", async () => {
    const native = new NativeWorld();
    native.hexIds = true;
    const factories = (name: string) => Object.fromEntries((["iroh/1"] as NativeTransport[]).map((transport) => [transport, async () => native.endpoint(transport, name)]));
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Linux", { createPeerConnection: undefined, nativeTransports: factories("Linux") });
    const phone = await makeDevice("Phone", { nativeTransports: factories("Phone") });
    await write(desktop, "active", d, [desktop, phone]);
    await write(phone, "standby", d, [desktop, phone]);
    await settled(Promise.all([desktop.links.start(), phone.links.start()]));
    expect(await until(() => liveBetween(desktop, phone), 120_000)).toBe(true);
    expect(phone.links.views()[0].transport).toBe("iroh/1");
    expect(await settled(phone.links.ping(desktop.slot.key))).toBeGreaterThanOrEqual(0);
  });

  it("give no old link to a key the current set does not list, whatever the list of devices still to acknowledge says", async () => {
    const oldD = newDeviceSetSecret(), newD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), lost = await makeDevice("Lost");
    await write(desktop, "active", newD, [desktop, phone, null], { earlierSets: [{ d: toBase64Url(oldD), tombstone: "", setUpdate: "{}", pending: [phone.slot.key, lost.slot.key] }] });
    await settled(desktop.links.start());
    expect(desktop.links.views().map((v) => [v.name, v.earlier ?? false]).sort()).toEqual([["Phone", false], ["Phone", true]]);
    expect(desktop.links.views().some((v) => v.key === lost.slot.key)).toBe(false);
  });

  it("are none, and the engine says why, when the stored key cannot be read; the start itself does not fail", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop");
    const phone = await makeDevice("Phone", { loadKey: async () => { throw new Error("The stored device signing key has no key"); } });
    await write(phone, "standby", d, [desktop, phone]);
    await expect(settled(phone.links.start())).resolves.toBeUndefined();
    expect(phone.links.views()).toEqual([]);
    expect(phone.links.problem).toContain("cannot be read");
    expect(pkarr.reads + pkarr.publishes).toBe(0);
  });

  it("are none where the record cannot carry them, and the engine says why", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone");
    // No secret.
    await putDeviceRecord({ v: 1, profile: phone.profile, state: "standby", saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [desktop.slot, phone.slot], ownSlot: 1 });
    await settled(phone.links.start());
    expect(phone.links.views()).toEqual([]);
    expect(phone.links.problem).toContain("no device-set secret");
    // A key that is not the one the record names (storage copied in part).
    await write(phone, "standby", d, [desktop, phone], { deviceSet: [desktop.slot, { key: toBase64Url(randomBytes(32)), name: "Phone" }] });
    await settled(phone.links.refresh());
    expect(phone.links.views()).toEqual([]);
    expect(phone.links.problem).toContain("not the one the device state names");
    expect(pkarr.reads).toBe(0);
    expect(pkarr.publishes).toBe(0);
    await expect(phone.links.ping(desktop.slot.key)).rejects.toThrow("no link");
    expect(() => phone.links.send(desktop.slot.key, { t: "set-ack" })).toThrow("no link");
  });
});

describe("a profile with no device set", () => {
  it("starts no link, looks for no key, makes no database and asks no relay", async () => {
    const loadKey = vi.fn(async () => null);
    const links = new DeviceLinks({ profile: "ghostly", transport: pkarr.transport(), loadKey });
    engines.push(links);
    await settled(links.start());
    await run(30_000);
    expect(links.views()).toEqual([]);
    expect(links.problem).toBeNull();
    expect(loadKey).not.toHaveBeenCalled();
    expect(await settled(links.turnKeeper())).toBeNull();
    expect(await settled(links.checkTurn())).toBeNull();
    expect(pkarr.reads).toBe(0);
    expect(pkarr.publishes).toBe(0);
    expect((await indexedDB.databases()).map((db) => db.name)).toEqual([]);
  });

  it("gets the engine from `createPeerServer`, and no device links beside it", async () => {
    vi.useRealTimers();
    const opened: string[] = [];
    const open = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, "open").mockImplementation((name: string, version?: number) => { opened.push(name); return open(name, version); });
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    const gate = await openDeviceGate("ghostly");
    expect(gate).toMatchObject({ state: "single", full: true });
    const server = await createPeerServer({ transport: pkarr.transport(), automaticWallets: false, singleDevice: false }, { gate });
    expect(server).toBeInstanceOf(EngineServer);
    await server.ready;
    await server.stop();
    // The gate read no device database (there is none), and nothing made a key.
    expect(opened).not.toContain(DEVICES_DB);
    expect(opened).not.toContain(DEVICE_KEYS_DB);
    expect(generate).not.toHaveBeenCalled();
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(DEVICE_KEYS_DB);
  });
});

describe("device-link-only mode", () => {
  it("runs the device links for a standby: a page reads them and pings a device through the server, and nothing else is answered", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop");
    await createDeviceSigningKey("ghostly");
    const phoneKey = (await createDeviceSigningKey("ghostly"));
    const phone: TestDevice = { profile: "ghostly", name: "Phone", key: phoneKey, slot: { key: toBase64Url(phoneKey.publicKey), name: "Phone" }, links: null as unknown as DeviceLinks, frames: [] };
    await write(desktop, "active", d, [desktop, phone]);
    await write(phone, "standby", d, [desktop, phone]);
    await settled(desktop.links.start());
    const opened: string[] = [];
    const open = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, "open").mockImplementation((name: string, version?: number) => { opened.push(name); return open(name, version); });

    const gate = await settled(openDeviceGate("ghostly"));
    expect(gate).toMatchObject({ state: "standby", full: false });
    vi.stubGlobal("RTCPeerConnection", function RTCPeerConnection() { return fakePeerConnection("Phone"); });
    const server = await settled(createPeerServer({ transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS }, { gate }));
    expect(server).toBeInstanceOf(DeviceLinkOnlyServer);
    await settled(server.ready);
    const answers: { id: number; result?: unknown; error?: string }[] = [];
    const page = { post: (message: unknown) => { const m = message as { kind: string; id: number; result?: unknown; error?: string }; if (m.kind === "response") answers.push(m); } };
    server.attach(page);
    const ask = async (id: number, method: string, params?: unknown) => {
      await settled(server.handle(page, { kind: "request", id, method, params } as never));
      return answers.find((a) => a.id === id)!;
    };
    expect(await until(() => desktop.links.live(phone.slot.key), 60_000)).toBe(true);
    expect((await ask(1, "deviceLinks")).result).toEqual([{ key: desktop.slot.key, name: "Desktop", slot: 0, status: "live", transport: "webrtc/1" }]);
    expect((await ask(2, "devicePing", { key: desktop.slot.key })).result).toMatchObject({ ms: expect.any(Number) });
    expect((await ask(3, "devicePing", {})).error).toContain("Name the device");
    expect((await ask(4, "deviceHandoff")).error).toContain("not available yet");
    expect((await ask(5, "sendMessage")).error).toBe("This profile is not active on this device");
    // The page is told names and states: no secret, no private key.
    expect(JSON.stringify(answers)).not.toContain(toBase64Url(d));
    await settled(server.stop());
    // The profile's peer database was never opened: the device state and the device key are all a standby reads.
    expect(opened.filter((name) => name !== DEVICE_KEYS_DB && name !== DEVICES_DB)).toEqual([]);
    expect(fromBase64Url(desktop.slot.key)).toHaveLength(32);
  });
});
