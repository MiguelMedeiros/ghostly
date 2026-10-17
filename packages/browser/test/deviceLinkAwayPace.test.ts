import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, toBase64Url } from "@ghostly/core";
import { resetDeviceGates } from "../src/devices/gate";
import { DeviceLinks } from "../src/devices/links";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceSlot, StoredDeviceState } from "../src/devices/state";
import { closeDevicesDb, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.links.session

/*
 * A device link whose other device is away (a phone closed for the day): its packet is not at the relays, and the
 * link reads it at its pace. A device link is never an invite just sent, so the first ten minutes of a start are not a
 * join being awaited: they are read at the background pace, as after them.
 */

interface TestDevice { profile: string; key: DeviceSigningKey; slot: DeviceSlot; links: DeviceLinks }

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

/** Over the relays, as the web app runs (`RELAY_POLL_INTERVALS`: active 4 s, background 30 s). */
async function makeDevice(name: string): Promise<TestDevice> {
  const profile = `ghostly_${name.toLowerCase()}`;
  const key = await createDeviceSigningKey(profile, { forceSeed: engines.length % 2 === 1 });
  const links = new DeviceLinks({ profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection(name) });
  engines.push(links);
  return { profile, key, slot: { key: toBase64Url(key.publicKey), name }, links };
}

async function write(device: TestDevice, state: StoredDeviceState, d: Uint8Array, set: TestDevice[]): Promise<void> {
  await putDeviceRecord({
    v: 1, profile: device.profile, state, saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [],
    deviceSet: set.map((member) => member.slot), activeSlot: 0, ownSlot: set.indexOf(device), d: toBase64Url(d), signingKey: device.key.kind,
  });
}

const reads = () => [...pkarr.readsByKey.values()].reduce((sum, n) => sum + n, 0);

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

describe("a device link whose other device is away", () => {
  it("is read at the background pace from the start, not every 4 s for ten minutes", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone");
    await write(desktop, "active", d, [desktop, phone]);
    await settled(desktop.links.start());
    const before = reads();
    await run(10 * 60_000);
    // 30 s apart: 20 in ten minutes, a few more for the first ones. Every 4 s, it was 150.
    expect(reads() - before).toBeLessThanOrEqual(26);
  }, 120_000);

  it("still goes live within the background pace once the other device comes back", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone");
    await write(desktop, "active", d, [desktop, phone]);
    await write(phone, "standby", d, [desktop, phone]);
    await settled(desktop.links.start());
    await run(3 * 60_000);
    await settled(phone.links.start());
    const back = Date.now();
    // Usually one background read (31-41 s). A read that lands just before the other side's publish finds nothing new
    // and waits a second pace (66-76 s): two paces, and the slack a slow host's fake clock runs ahead of real work.
    const within = 3 * RELAY_POLL_INTERVALS.background;
    while (Date.now() - back < within && !(desktop.links.live(phone.slot.key) && phone.links.live(desktop.slot.key))) await run(250);
    expect(desktop.links.live(phone.slot.key) && phone.links.live(desktop.slot.key)).toBe(true);
  }, 120_000);
});
