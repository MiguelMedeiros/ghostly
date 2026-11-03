import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, signTurnPacket, toBase64Url, turnKeys } from "@ghostly/core";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { resetDeviceGates, type DeviceGate, type DeviceGateView } from "../src/devices/gate";
import { DeviceLinks } from "../src/devices/links";
import { moveSet } from "../src/devices/remove";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceRecord, DeviceSlot, StoredDeviceState } from "../src/devices/state";
import { amendDevice, closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.remove

/*
 * A standby whose screen stays open while the active device removes it (WISP 06 § Removing a device). The active device
 * puts a tombstone at the old address and then closes the removed device's link. The standby read the turn only when
 * its screen opened, every 10 minutes, or when the page came back to the front: a screen left in front kept saying
 * "This device is on standby" with Use here for up to 10 minutes. Its link closing by the other side's doing is a sign
 * worth one read, as a hint is.
 */

interface Keys { profile: string; name: string; key: DeviceSigningKey; slot: DeviceSlot }

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

async function makeDevice(name: string): Promise<Keys> {
  const profile = `ghostly_${name.toLowerCase()}`;
  const key = await createDeviceSigningKey(profile, { forceSeed: true });
  return { profile, name, key, slot: { key: toBase64Url(key.publicKey), name } };
}

async function write(device: Keys, state: StoredDeviceState, d: Uint8Array, set: Keys[], packet: Uint8Array): Promise<void> {
  await putDeviceRecord({
    v: 1, profile: device.profile, state, saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], turnPacket: toBase64Url(packet),
    deviceSet: set.map((member) => member.slot), activeSlot: 0, ownSlot: set.indexOf(device), d: toBase64Url(d), signingKey: device.key.kind,
  });
}

const record = (device: { profile: string }) => readDeviceRecord(device.profile) as Promise<DeviceRecord>;

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

describe("a standby removed while its screen stays open", () => {
  it("reads the turn when the active device closes its link, and says it was removed within seconds", async () => {
    const d = newDeviceSetSecret(), keys = turnKeys(d);
    const turn = new FakeTurnNetwork();
    const desktop = await makeDevice("Desktop"), tablet = await makeDevice("Tablet");
    const both = [desktop, tablet];
    const packet = await signTurnPacket(keys, { turn: 7, rev: 0, author: 0, active: 0, slots: [...both.map((device) => ({ key: device.key.publicKey, name: device.name })), null, null], instance: new Uint8Array(8).fill(1) }, (bytes) => desktop.key.sign(bytes));
    turn.seed(packet);
    await write(desktop, "active", d, both, packet);
    await write(tablet, "standby", d, both, packet);

    const shown: DeviceGateView[] = [];
    const desktopLinks = new DeviceLinks({ profile: desktop.profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Desktop") });
    // The standby screen's links, as device-link-only mode runs them (`peer.ts`).
    const tabletLinks = new DeviceLinks({ profile: tablet.profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Tablet"), turn, watchTurn: true });
    engines.push(desktopLinks, tabletLinks);
    await settled(Promise.all([desktopLinks.start(), tabletLinks.start({ gate: {} as DeviceGate, show: (view) => { shown.push(view); } })]));
    expect(await until(() => desktopLinks.live(tablet.slot.key) && tabletLinks.live(desktop.slot.key), 90_000)).toBe(true);
    // The read when the screen opened and the one on the desktop's hint are over.
    await run(30_000);
    const reads = turn.calls.filter((call) => call.op === "read").length;

    // The desktop removes the tablet: a tombstone at the old address, then the tablet's link closed.
    await settled(moveSet({
      read: () => readDeviceRecord(desktop.profile), amend: (patch) => amendDevice(desktop.profile, patch), signer: desktop.key, network: turn,
      refresh: () => desktopLinks.refresh(),
    }, { remove: tablet.slot.key }));
    const removedAt = Date.now();

    // Well before its 10-minute read, the tablet knows, and its screen says so.
    expect(await until(() => shown.at(-1)?.state === "removed", 20_000), "the screen says removed within 20 s of the link closing").toBe(true);
    expect(Date.now() - removedAt).toBeLessThan(20_000);
    expect((await record(tablet)).state).toBe("removed");
    // One read of its own for it, not one per link event.
    const tabletReads = turn.calls.filter((call) => call.op === "read").length - reads;
    expect(tabletReads).toBeLessThanOrEqual(4);
  });
});
