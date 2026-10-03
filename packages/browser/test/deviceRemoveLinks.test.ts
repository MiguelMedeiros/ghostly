import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, toBase64Url, type DeviceFrame } from "@ghostly/core";
import { resetDeviceGates } from "../src/devices/gate";
import { DeviceLinks, deviceSetView, type DeviceLinksOptions } from "../src/devices/links";
import { moveSet } from "../src/devices/remove";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceRecord, DeviceSlot, StoredDeviceState } from "../src/devices/state";
import { amendDevice, closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.remove

/*
 * Removing a device over real device links (WISP 06 § Removing a device): the active device removes one, the frame goes
 * over the old link to the device that stays (one that was closed gets it when it opens again), that device writes the
 * new set before it answers, and the remover drops it from its list once it answers. The removed device holds no link
 * to the new set. Every key and secret is made in the test.
 */

interface TestDevice { profile: string; name: string; key: DeviceSigningKey; slot: DeviceSlot; links: DeviceLinks; frames: [string, DeviceFrame][] }

let pkarr: MemoryPkarr;
const engines: DeviceLinks[] = [];
const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); await yieldToLoop(); }
}
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => { done = true; });
  tracked.catch(() => {});
  for (let i = 0; !done && i < 400; i++) await run(250);
  return tracked;
}
async function until(condition: () => boolean | Promise<boolean>, limit: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (await condition()) return true;
    await run(250);
  }
  return condition();
}

function linksFor(profile: string, name: string, frames: [string, DeviceFrame][], options: Partial<DeviceLinksOptions> = {}): DeviceLinks {
  const links = new DeviceLinks({
    profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection(name),
    onFrame: (from, frame) => { frames.push([from, frame]); }, ...options,
  });
  engines.push(links);
  return links;
}

async function makeDevice(name: string): Promise<TestDevice> {
  const profile = `ghostly_${name.toLowerCase()}`;
  const key = await createDeviceSigningKey(profile, { forceSeed: true });
  const frames: [string, DeviceFrame][] = [];
  return { profile, name, key, slot: { key: toBase64Url(key.publicKey), name }, links: linksFor(profile, name, frames), frames };
}

async function write(device: TestDevice, state: StoredDeviceState, d: Uint8Array, set: (TestDevice | null)[]): Promise<void> {
  await putDeviceRecord({
    v: 1, profile: device.profile, state, saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [],
    deviceSet: set.map((member) => member?.slot ?? null), activeSlot: 0, ownSlot: set.indexOf(device), d: toBase64Url(d), signingKey: device.key.kind,
  });
}

const liveBetween = (a: TestDevice, b: TestDevice) => a.links.live(b.slot.key) && b.links.live(a.slot.key);
const record = (device: TestDevice) => readDeviceRecord(device.profile) as Promise<DeviceRecord>;

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
});

describe("removing a device over the device links", () => {
  it("the device that was closed gets the new set when it opens again, answers, and the removed one is out", async () => {
    const oldD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), tablet = await makeDevice("Tablet");
    const all = [desktop, phone, tablet];
    for (const [i, device] of all.entries()) await write(device, i === 0 ? "active" : "standby", oldD, all);
    await settled(Promise.all([desktop.links.start(), tablet.links.start()]));
    expect(await until(() => liveBetween(desktop, tablet), 90_000)).toBe(true);

    // The tablet is removed while the phone is closed. Nothing is put (no turn sources here): the record carries it all.
    const moved = await settled(moveSet({
      read: () => readDeviceRecord(desktop.profile), amend: (patch) => amendDevice(desktop.profile, patch), signer: desktop.key, network: null,
      refresh: () => desktop.links.refresh(),
    }, { remove: tablet.slot.key }));
    expect(moved.removed?.name).toBe("Tablet");
    const newD = moved.record.d!;
    // The removed device's link is closed at once; an old link to the phone waits for it.
    expect(desktop.links.views().map((v) => [v.name, v.earlier ?? false]).sort()).toEqual([["Phone", false], ["Phone", true]]);
    expect(deviceSetView(await record(desktop), desktop.links.views())).toMatchObject({ waiting: [{ key: phone.slot.key, name: "Phone" }] });

    // The phone opens again: it still holds the old secret. The old link joins it to the desktop, and the frame comes.
    await settled(phone.links.start());
    expect(await until(async () => (await record(phone)).d === newD, 120_000)).toBe(true);
    expect(await record(phone)).toMatchObject({ state: "standby", deviceSet: [desktop.slot, phone.slot, null, null], activeSlot: 0, setNotice: { names: ["Desktop", "Phone"] } });
    // Its answer (or its showing up on the new link) takes it off the desktop's list, and the old link goes.
    expect(await until(async () => (await record(desktop)).earlierSets.every((set) => set.pending.length === 0), 60_000)).toBe(true);
    expect(await until(() => desktop.links.views().every((v) => !v.earlier), 30_000)).toBe(true);
    expect(await until(() => liveBetween(desktop, phone), 90_000)).toBe(true);
    // The frames were the links' own business: none was handed on.
    expect(desktop.frames).toEqual([]);
    expect(phone.frames).toEqual([]);
    // The tablet reaches neither of them: it holds no link of the new set, and theirs to it are closed.
    await run(60_000);
    expect(tablet.links.live(desktop.slot.key)).toBe(false);
    expect(tablet.links.live(phone.slot.key)).toBe(false);
    expect(desktop.links.views().some((v) => v.key === tablet.slot.key)).toBe(false);
    expect(phone.links.views().some((v) => v.key === tablet.slot.key)).toBe(false);
  });

  it("the device list is answered once; This is wrong keeps the device out and asks for enrollment", async () => {
    const oldD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), tablet = await makeDevice("Tablet");
    const all = [desktop, phone, tablet];
    for (const [i, device] of all.entries()) await write(device, i === 0 ? "active" : "standby", oldD, all);
    await settled(Promise.all([desktop.links.start(), phone.links.start()]));
    expect(await until(() => liveBetween(desktop, phone), 90_000)).toBe(true);
    await settled(moveSet({
      read: () => readDeviceRecord(desktop.profile), amend: (patch) => amendDevice(desktop.profile, patch), signer: desktop.key, network: null,
      refresh: () => desktop.links.refresh(),
    }, { remove: tablet.slot.key }));
    expect(await until(async () => !!(await record(phone)).setNotice, 90_000)).toBe(true);
    expect((await settled(phone.links.call("deviceSet", {})) as { notice?: string[] }).notice).toEqual(["Desktop", "Phone"]);
    await settled(phone.links.call("deviceSetNoticeSeen", { wrong: true }));
    expect(await record(phone)).toMatchObject({ state: "removed", reenroll: true, setNotice: { seen: true } });
    expect(phone.links.views()).toEqual([]);
  });
});
