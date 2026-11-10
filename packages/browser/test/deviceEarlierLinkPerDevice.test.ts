import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink, RELAY_POLL_INTERVALS, SET_ACK, newDeviceSetSecret, toBase64Url, type DeviceFrame } from "@ghostly/core";
import { resetDeviceGates } from "../src/devices/gate";
import { DeviceLinks } from "../src/devices/links";
import { acknowledged, delivered, moveSet, planSetMove } from "../src/devices/remove";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import { MAX_DELIVERED, MAX_EARLIER_SETS, isEarlierSet, parseDeviceRecord, type DevicePatch, type DeviceRecord, type DeviceSlot, type EarlierDeviceSet, type StoredDeviceState } from "../src/devices/state";
import { amendDevice, closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.remove

/*
 * The links an active device keeps under earlier device sets for the devices that stay and were off across several
 * moves. Such a device holds one secret, the oldest set still waiting for it; that set's frame names the secret it
 * takes next, and only the link of that next set may follow. A link under a secret it never got cannot open, and was
 * read every 30 s like a live one.
 */

interface TestDevice { profile: string; name: string; key: DeviceSigningKey; slot: DeviceSlot; links: DeviceLinks }

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

function linksFor(profile: string, name: string): DeviceLinks {
  const links = new DeviceLinks({ profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection(name) });
  engines.push(links);
  return links;
}

async function makeDevice(name: string): Promise<TestDevice> {
  const profile = `ghostly_${name.toLowerCase()}`;
  const key = await createDeviceSigningKey(profile, { forceSeed: true });
  return { profile, name, key, slot: { key: toBase64Url(key.publicKey), name }, links: linksFor(profile, name) };
}

async function write(device: TestDevice, state: StoredDeviceState, d: Uint8Array, set: TestDevice[], active = 0): Promise<void> {
  await putDeviceRecord({
    v: 1, profile: device.profile, state, saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [],
    deviceSet: set.map((member) => member.slot), activeSlot: active, ownSlot: set.indexOf(device), d: toBase64Url(d), signingKey: device.key.kind,
  });
}

const record = (device: TestDevice) => readDeviceRecord(device.profile) as Promise<DeviceRecord>;
const reads = () => [...pkarr.readsByKey.values()].reduce((sum, n) => sum + n, 0);
/** The earlier links a device runs, as `<secret>|<device>`. */
const earlierLinks = (device: TestDevice) => [...(device.links as unknown as { running: Map<string, { earlier: boolean }> }).running.entries()].filter(([, r]) => r.earlier).map(([id]) => id).sort();
const ports = (device: TestDevice) => ({ read: () => readDeviceRecord(device.profile), amend: (patch: DevicePatch) => amendDevice(device.profile, patch), signer: device.key, network: null, refresh: () => device.links.refresh() });

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
});

describe("the earlier links to devices that stay and were off across several moves", () => {
  it("are one per device, under the secret it holds, read as one link each; the device still gets the newest set", async () => {
    const firstD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), tablet = await makeDevice("Tablet");
    const all = [desktop, phone, tablet];
    for (const [i, device] of all.entries()) await write(device, i === 0 ? "active" : "standby", firstD, all);
    // "New device secret" as many times as the record keeps earlier sets, the phone and the tablet off the whole time.
    for (let i = 0; i < MAX_EARLIER_SETS; i++) await settled(moveSet(ports(desktop)));
    const moved = await record(desktop);
    expect(moved.earlierSets).toHaveLength(MAX_EARLIER_SETS);
    expect(moved.earlierSets.every((set) => set.pending.length === 2)).toBe(true);

    await settled(desktop.links.start());
    // Both off devices hold the first secret: one link each under it, none under the seven they never got.
    expect(earlierLinks(desktop)).toEqual([phone, tablet].map((device) => `${toBase64Url(firstD)}|${device.slot.key}`).sort());
    const before = reads();
    await run(30 * 60_000);
    // Four links (two current, two earlier), each read every 30 s: about 240. One per earlier set, it was 1,080.
    expect(reads() - before).toBeLessThanOrEqual(4 * 66);

    // Nothing is lost: the phone opens with the first secret, and the frame on that link takes it to the newest.
    await settled(phone.links.start());
    expect(await until(async () => (await record(phone)).d === moved.d, 120_000)).toBe(true);
    expect(await until(async () => (await record(desktop)).earlierSets.every((set) => !set.pending.includes(phone.slot.key)), 60_000)).toBe(true);
    expect(await until(() => earlierLinks(desktop).every((id) => !id.endsWith(phone.slot.key)), 30_000)).toBe(true);
  }, 300_000);

  it("a frame another device signed names only the next set: the link of that set still runs after it", async () => {
    const firstD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), tablet = await makeDevice("Tablet");
    const all = [desktop, phone, tablet];
    // The tablet was active and moved the set while the phone was off; then the desktop took over and moved it again.
    await write(tablet, "active", firstD, all, 2);
    const byTablet = await planSetMove(await record(tablet), tablet.key);
    const secondD = byTablet.patch.d!;
    await putDeviceRecord({ ...(await record(tablet)), ...byTablet.patch, profile: desktop.profile, ownSlot: 0, activeSlot: 0, signingKey: desktop.key.kind } as DeviceRecord);
    await settled(moveSet(ports(desktop)));
    const moved = await record(desktop);
    expect(moved.earlierSets.map((set) => [set.d, set.pending.slice().sort()])).toEqual([
      [toBase64Url(firstD), [phone.slot.key]],
      [secondD, [phone.slot.key, tablet.slot.key].sort()],
    ]);

    await settled(desktop.links.start());
    // The phone takes the tablet's frame to the second secret, and needs the second set's link from there. The tablet
    // holds the second secret: one link, under it.
    expect(earlierLinks(desktop)).toEqual([
      `${toBase64Url(firstD)}|${phone.slot.key}`, `${secondD}|${phone.slot.key}`, `${secondD}|${tablet.slot.key}`,
    ].sort());
  }, 120_000);

  it("a device that took a set's frame but whose acknowledgement was lost still gets the set after the next move", async () => {
    const firstD = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone"), tablet = await makeDevice("Tablet");
    const all = [desktop, phone, tablet];
    for (const [i, device] of all.entries()) await write(device, i === 0 ? "active" : "standby", firstD, all);
    await settled(moveSet(ports(desktop)));
    const second = (await record(desktop)).d!;

    // The phone takes the frame over its old link, and its `set-ack` never reaches the desktop (the link dropped first).
    const phoneLinks = () => [...(phone.links as unknown as { running: Map<string, { link: GhostLink }> }).running.values()].map((r) => r.link);
    const send = GhostLink.prototype.sendDeviceFrame;
    const lost = vi.spyOn(GhostLink.prototype, "sendDeviceFrame").mockImplementation(function (this: GhostLink, frame: DeviceFrame) {
      if (frame.t !== SET_ACK || !phoneLinks().includes(this)) send.call(this, frame);
    });
    await settled(desktop.links.start());
    await settled(phone.links.start());
    expect(await until(async () => (await record(phone)).d === second, 120_000)).toBe(true);
    // It goes off before its link under the new secret opens: nothing tells the desktop that it holds that secret.
    await settled(phone.links.stop());
    lost.mockRestore();
    expect((await record(desktop)).earlierSets[0]!.pending).toContain(phone.slot.key);

    // The set moves again while the phone is off: the first set's frame now names the third secret.
    await settled(moveSet(ports(desktop)));
    const moved = await record(desktop);
    expect(moved.earlierSets.map((set) => [set.d, set.pending.includes(phone.slot.key)])).toEqual([[toBase64Url(firstD), true], [second, true]]);
    // The phone opens only the link of the secret it holds, the second one: the desktop keeps it.
    expect(earlierLinks(desktop)).toContain(`${second}|${phone.slot.key}`);
    phone.links = linksFor(phone.profile, phone.name);
    await settled(phone.links.start());
    expect(await until(async () => (await record(phone)).d === moved.d, 120_000)).toBe(true);
    expect(await until(async () => (await record(desktop)).earlierSets.every((set) => !set.pending.includes(phone.slot.key)), 60_000)).toBe(true);
  }, 300_000);
});

/*
 * v1.10.1's reader of an earlier set, as released (git show v1.10.1:packages/browser/src/devices/state.ts, lines
 * 456-460 and 509-513; `parseDeviceRecord` takes each of `earlierSets` through it, lines 603-604, and keeps the value as
 * it was stored). `delivered` came after it: a record a newer build wrote, or a handoff part it brought, must still read.
 */
const v1101 = (() => {
  const MAX_DEVICES = 4;
  const B64URL = /^[A-Za-z0-9_-]*$/;
  const text = (value: unknown): value is string => typeof value === "string";
  const bytes = (value: unknown): value is string => text(value) && B64URL.test(value);
  const optional = <T>(value: unknown, is: (v: unknown) => v is T): boolean => value === undefined || is(value);
  return function isEarlierSet(value: unknown): boolean {
    const set = value as Partial<EarlierDeviceSet> | null;
    if (!set || typeof set !== "object" || !bytes(set.d) || !bytes(set.tombstone) || !text(set.setUpdate) || !Array.isArray(set.pending) || !set.pending.every(bytes)) return false;
    return set.pending.length <= MAX_DEVICES && (set.foreign === undefined || set.foreign === true) && optional(set.removed, bytes);
  };
})();

describe("an earlier set's delivered devices", () => {
  it("are noted once per device and secret, read by v1.10.1 as the same set, and dropped when the device answers", async () => {
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone");
    await write(desktop, "active", newDeviceSetSecret(), [desktop, phone]);
    await amendDevice(desktop.profile, (await planSetMove(await record(desktop), desktop.key)).patch);
    const moved = await record(desktop);
    const set = moved.earlierSets[0]!;
    const patch = delivered(moved, phone.slot.key, set.d)!;
    expect(patch.earlierSets![0]!.delivered).toEqual([{ key: phone.slot.key, d: moved.d }]);
    const noted = await amendDevice(desktop.profile, patch);
    expect(delivered(noted, phone.slot.key, set.d)).toBeNull();

    // The stored record, as v1.10.1 reads it: the same answer as for the set without the field.
    const stored = JSON.parse(JSON.stringify(noted)) as DeviceRecord;
    const { delivered: _field, ...without } = stored.earlierSets[0]!;
    expect(stored.earlierSets[0]!.delivered).toHaveLength(1);
    expect(v1101(stored.earlierSets[0])).toBe(true);
    expect(v1101(stored.earlierSets[0])).toBe(v1101(without));
    expect(parseDeviceRecord(stored).earlierSets[0]).toEqual(stored.earlierSets[0]);
    // This build refuses a malformed one, as it does every field of the record.
    expect(isEarlierSet({ ...without, delivered: [{ key: phone.slot.key }] })).toBe(false);
    expect(isEarlierSet({ ...without, delivered: Array.from({ length: MAX_DELIVERED + 1 }, () => ({ key: phone.slot.key, d: moved.d })) })).toBe(false);

    expect(acknowledged(noted, phone.slot.key, set.d)!.earlierSets![0]).toEqual({ ...without, pending: [] });
  });
});
