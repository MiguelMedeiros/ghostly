import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { activeAgainIfReleasing } from "../src/devices/handoffStandby";
import { firstRecord, transition } from "../src/devices/state";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import type { DeviceGateView } from "../src/devices/gate";
// covers: devices.handoff.machine

/*
 * A device frozen for pass 2 (`releasing`) whose handoff cannot run in device-link-only mode (no profile host, a key
 * that does not load, any error there) never signed a release: it is the active device again, never no device at all.
 */

afterEach(async () => { setDeviceMirror(null); await closeDevicesDb(); await dropDevicesDatabase(); });

const KEY = "a".repeat(43);

describe("a releasing device whose pass 2 cannot run", () => {
  it("writes active and starts again into the gate", async () => {
    const active = firstRecord("ghostly", "active", { turn: 7, deviceSet: [{ key: KEY, name: "Desktop" }], ownSlot: 0, activeSlot: 0 });
    await putDeviceRecord({ ...transition(active, "ghostly", "releasing", { handoff: { role: "releasing", step: "pass2" } }), saved: 2 });
    const shown: DeviceGateView[] = [];
    expect(await activeAgainIfReleasing("ghostly", (view) => shown.push(view))).toBe(true);
    const record = await readDeviceRecord("ghostly");
    expect(record?.state).toBe("active");
    expect(record?.handoff).toBeUndefined();
    expect(shown).toEqual([{ state: "releasing", reload: true }]);
  });

  it("leaves any other state as it is", async () => {
    await putDeviceRecord({ ...firstRecord("ghostly", "standby", { turn: 7, deviceSet: [{ key: KEY, name: "Desktop" }], ownSlot: 0, activeSlot: 0 }), saved: 1 });
    const shown: DeviceGateView[] = [];
    expect(await activeAgainIfReleasing("ghostly", (view) => shown.push(view))).toBe(false);
    expect((await readDeviceRecord("ghostly"))?.state).toBe("standby");
    expect(shown).toEqual([]);
  });
});
