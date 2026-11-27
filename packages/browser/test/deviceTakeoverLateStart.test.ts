import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, signTurnPacket, toBase64Url, turnKeys } from "@ghostly/core";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { resetDeviceGates, type DeviceGate, type DeviceGateView } from "../src/devices/gate";
import { DeviceLinks } from "../src/devices/links";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey } from "../src/devices/signingKey";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.takeover

/*
 * A forced takeover whose settle read one source that took the put did not answer (WISP 06 § Settle): the device stays
 * `taking`, and a later read of the turn (the screen back in front, the 10-minute read, a reload) settles it as the
 * active device. The pages then start again into the gate, as after a takeover that settled at once: the standby screen
 * has nothing to show for `active`, and the old active device already stopped.
 */

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

describe("a forced takeover that settles on a later read", () => {
  it("starts the pages again into the gate, as one that settled at once does", async () => {
    const d = newDeviceSetSecret(), keys = turnKeys(d);
    const turn = new FakeTurnNetwork();
    const desktop = await createDeviceSigningKey("ghostly_desktop", { forceSeed: true });
    const tablet = await createDeviceSigningKey("ghostly_tablet", { forceSeed: true });
    const slots = [{ key: desktop.publicKey, name: "Desktop" }, { key: tablet.publicKey, name: "Tablet" }, null, null];
    const packet = await signTurnPacket(keys, { turn: 7, rev: 0, author: 0, active: 0, slots, instance: new Uint8Array(8).fill(1) }, (bytes) => desktop.sign(bytes));
    turn.seed(packet);
    // A standby that holds a copy restored from a backup: no password to type, only the active device's name.
    await putDeviceRecord({
      v: 1, profile: "ghostly_tablet", state: "standby", saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], turnPacket: toBase64Url(packet),
      deviceSet: [{ key: toBase64Url(desktop.publicKey), name: "Desktop" }, { key: toBase64Url(tablet.publicKey), name: "Tablet" }], activeSlot: 0, ownSlot: 1,
      d: toBase64Url(d), signingKey: tablet.kind, copy: "restored",
    });
    const shown: DeviceGateView[] = [];
    const links = new DeviceLinks({ profile: "ghostly_tablet", transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Tablet"), turn });
    engines.push(links);
    await settled(links.start({ gate: {} as DeviceGate, show: (view) => { shown.push(view); } }));

    // The relay takes the takeover's put, then does not answer its settle read.
    const relay = turn.source("https://relay.test");
    relay.beforePut = () => { relay.beforePut = undefined; relay.down = true; };
    const taken = await settled(links.call("deviceTakeover", { name: "Desktop" }) as Promise<{ kind: string }>);
    expect(taken.kind).toBe("wait");
    expect((await readDeviceRecord("ghostly_tablet"))!.state).toBe("taking");
    expect(shown.some((view) => view.reload)).toBe(false);

    // Back: the screen's next read of the turn settles it, and this device is the active one.
    relay.down = false;
    await settled(links.call("deviceTurnCheck", null));
    expect((await readDeviceRecord("ghostly_tablet"))!.state).toBe("active");
    expect(shown.at(-1), "the pages start again into the gate").toMatchObject({ reload: true });
  });
});
