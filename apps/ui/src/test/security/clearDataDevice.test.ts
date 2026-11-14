import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { createDeviceSigningKey, loadDeviceSigningKey } from "@ghostly/browser/devices/signingKey";
import { enrollDevice, readDeviceRecord, setDeviceMirror } from "@ghostly/browser/devices/store";
import { clearAllData } from "../../lib/clearData";
import { profileDatabase } from "../../lib/profileData";
import { activeProfileId } from "../../lib/profiles";

// covers: app.clear-data, devices.signing-key

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/** Desktop's fsynced copy of each record, in memory. */
const mirrored = new Map<string, string>();

beforeEach(() => {
  mirrored.clear();
  setDeviceMirror({
    read: async (profile) => mirrored.get(profile) ?? null,
    write: async (profile, record) => { if (record === null) mirrored.delete(profile); else mirrored.set(profile, record); },
  });
});
afterEach(() => { setDeviceMirror(null); vi.restoreAllMocks(); });

describe("Clear all data and the device set (WISP 04, WISP 06)", () => {
  it("takes this device out of the profile's device set: its record, Desktop's copy and its signing key go; another profile's stay", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    const own = profileDatabase(activeProfileId()), other = "ghostly_another";
    for (const profile of [own, other]) {
      await enrollDevice(profile, "active");
      await createDeviceSigningKey(profile, { forceSeed: true });
    }
    expect((await readDeviceRecord(own))?.state).toBe("active");
    expect(mirrored.has(own)).toBe(true);
    expect(await loadDeviceSigningKey(own)).not.toBeNull();

    await clearAllData();

    // The profile starts again as a device of no set (`single`), with no key the other devices know.
    expect(await readDeviceRecord(own)).toBeNull();
    expect(mirrored.has(own)).toBe(false);
    expect(await loadDeviceSigningKey(own)).toBeNull();
    expect((await readDeviceRecord(other))?.state).toBe("active");
    expect(mirrored.has(other)).toBe(true);
    expect(await loadDeviceSigningKey(other)).not.toBeNull();
  });
});
