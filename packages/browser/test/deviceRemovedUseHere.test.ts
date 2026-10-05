import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, signTurnPacket, toBase64Url, turnKeys } from "@ghostly/core";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { resetDeviceGates, type DeviceGateView } from "../src/devices/gate";
import type { HandoffSource, HandoffStaging, HandoffStagingHost } from "../src/devices/handoff";
import type { HandoffProfileHost } from "../src/devices/handoffHost";
import { standbyHandoff } from "../src/devices/handoffStandby";
import { DeviceLinks } from "../src/devices/links";
import { moveSet } from "../src/devices/remove";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceRecord, DeviceSlot, StoredDeviceState } from "../src/devices/state";
import { amendDevice, closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { DB_VERSION } from "../src/shared/idb";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.remove, devices.handoff

/*
 * Use here on a device that was removed while its standby screen stayed open (WISP 06 § Removing a device). The active
 * device closes the removed device's link and puts a tombstone at the old address; the removed device reads the turn
 * only every 10 minutes on its own. Its Use here reads it first when its link to the active device is down, and the
 * screen says it was removed, instead of trying for a minute and saying the active device cannot be reached.
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

/** A profile host that never stages anything: what a pull may reach of it before it connects. */
const host: HandoffProfileHost = {
  app: "test", kind: "web",
  source: () => ({}) as HandoffSource,
  staging: {
    open: async (database?: string) => ({ database: database ?? "ghostly_staged", dropRest: async () => {} }) as unknown as HandoffStaging,
    install: async () => {}, revert: async () => {}, drop: async () => {},
  } satisfies HandoffStagingHost,
  storedVersion: async () => DB_VERSION,
};

async function makeDevice(name: string): Promise<Omit<TestDevice, "links">> {
  const profile = `ghostly_${name.toLowerCase()}`;
  const key = await createDeviceSigningKey(profile, { forceSeed: true });
  return { profile, name, key, slot: { key: toBase64Url(key.publicKey), name } };
}

async function write(device: Omit<TestDevice, "links">, state: StoredDeviceState, d: Uint8Array, set: Omit<TestDevice, "links">[], packet: Uint8Array): Promise<void> {
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

describe("Use here on a device removed while its screen was open", () => {
  it("reads the turn first, shows the removal and starts no pull", async () => {
    const d = newDeviceSetSecret(), keys = turnKeys(d);
    const turn = new FakeTurnNetwork();
    const desktopKeys = await makeDevice("Desktop"), tabletKeys = await makeDevice("Tablet");
    const both = [desktopKeys, tabletKeys];
    const packet = await signTurnPacket(keys, { turn: 7, rev: 0, author: 0, active: 0, slots: [...both.map((device) => ({ key: device.key.publicKey, name: device.name })), null, null], instance: new Uint8Array(8).fill(1) }, (bytes) => desktopKeys.key.sign(bytes));
    turn.seed(packet);
    await write(desktopKeys, "active", d, both, packet);
    await write(tabletKeys, "standby", d, both, packet);

    const shown: DeviceGateView[] = [];
    const desktop: TestDevice = { ...desktopKeys, links: new DeviceLinks({ profile: desktopKeys.profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Desktop") }) };
    const tabletLinks: DeviceLinks = new DeviceLinks({
      profile: tabletKeys.profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Tablet"), turn,
      handoff: async (running) => standbyHandoff({ profile: tabletKeys.profile, links: running, host, show: (view) => { shown.push(view); }, take: async () => null }),
    });
    const tablet: TestDevice = { ...tabletKeys, links: tabletLinks };
    engines.push(desktop.links, tablet.links);
    await settled(Promise.all([desktop.links.start(), tablet.links.start()]));
    expect(await until(() => desktop.links.live(tablet.slot.key) && tablet.links.live(desktop.slot.key), 90_000)).toBe(true);
    // The desktop's hint on the new link made the tablet read the turn once; that read is over.
    await run(30_000);
    const reads = turn.calls.length;

    // The desktop removes the tablet: a tombstone at the old address, and the tablet's link closed.
    await settled(moveSet({
      read: () => readDeviceRecord(desktop.profile), amend: (patch) => amendDevice(desktop.profile, patch), signer: desktop.key, network: turn,
      refresh: () => desktop.links.refresh(),
    }, { remove: tablet.slot.key }));
    expect(await until(() => !tablet.links.handoffLive(desktop.slot.key), 120_000)).toBe(true);
    // The tablet has not read the turn since: it still believes it is on standby.
    expect((await record(tablet)).state).toBe("standby");
    expect(turn.calls.slice(reads).filter((call) => call.op === "read").length, "reads since the removal: the remover's own").toBeGreaterThan(0);

    // Use here.
    const view = await settled(tablet.links.call("deviceHandoffPull", { password: "a long lock password" }) as Promise<unknown>);
    expect((await record(tablet)).state).toBe("removed");
    expect(shown.at(-1)).toMatchObject({ state: "removed" });
    // No pull started: nothing waits for a device that will never answer.
    expect(view).toBeNull();
    expect((await record(tablet)).handoff).toBeUndefined();
  });
});
