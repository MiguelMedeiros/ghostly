import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDevicesDb, enrollDevice, setDeviceMirror } from "@ghostly/browser/devices/store";
import { handoffProfileHost, recoverHandoffPointer } from "../../lib/handoffProfile";
import { listProfiles, namespaceOf, pointProfile, registryKey, setProfileBase } from "../../lib/profiles";
// covers: devices.handoff

/*
 * The registry pointer of a profile a handoff moved (WISP 06 § Installing the staged state), on a Desktop that runs in
 * a space of its own (GHOSTLY_PROFILE=<base>): there the first profile's namespace is the base itself, and the registry
 * `ghostly_<base>_profiles` has the prefix of its keys. The Linux bug hunt (2026-10-03) found the profile empty after
 * every handoff to the Desktop: deleting the old namespace at the end of the take deleted the registry with it.
 */

const BASE = "matrix-linux", STAGED = `${BASE}-stageaaaaa`, WORK = "workworkwo";
const dropAll = async () => {
  await closeDevicesDb();
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
};
const makeDatabase = (name: string) => new Promise<void>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
const writeRegistry = (profiles: object[]) => localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active: "", profiles }));

beforeEach(async () => { setProfileBase(BASE); setDeviceMirror(null); await dropAll(); });
afterEach(async () => { setProfileBase(""); await dropAll(); });

describe("a handoff that took the first profile of a Desktop space", () => {
  it("deletes the old namespace's keys and never the registry: the profile stays pointed at its new state, the other profiles listed", async () => {
    writeRegistry([{ id: "", name: "Personal", createdAt: 0 }, { id: WORK, name: "Work", createdAt: 1 }]);
    localStorage.setItem(`ghostly_${BASE}_app_settings`, "{}");
    localStorage.setItem(`ghostly_${BASE}_last_route`, "/");
    localStorage.setItem(`ghostly_${STAGED}_app_settings`, "{}");
    localStorage.setItem(`ghostly_${BASE}-${WORK}_app_settings`, "{}");
    // The install: one pointer. Then the take deletes the old namespace.
    pointProfile(`ghostly_${BASE}`, `ghostly_${STAGED}`);
    await handoffProfileHost("1.1.0", "desktop").staging.drop(`ghostly_${BASE}`);

    expect(localStorage.getItem(registryKey())).not.toBeNull();
    expect(namespaceOf("")).toBe(STAGED);
    expect(listProfiles().map((p) => p.id)).toEqual(["", WORK]);
    expect(localStorage.getItem(`ghostly_${BASE}_app_settings`)).toBeNull();
    expect(localStorage.getItem(`ghostly_${BASE}_last_route`)).toBeNull();
    expect(localStorage.getItem(`ghostly_${STAGED}_app_settings`)).toBe("{}");
    expect(localStorage.getItem(`ghostly_${BASE}-${WORK}_app_settings`)).toBe("{}");
  });

  it("refuses to point a profile at storage that is not a profile's, and says so before a reload", () => {
    expect(() => pointProfile(`ghostly_${BASE}`, "elsewhere")).toThrow("Not a profile's storage");
    expect(namespaceOf("")).toBe(BASE);
  });
});

describe("a profile whose pointer is gone", () => {
  it("is pointed again at the staged namespace whose device record names it home, at start", async () => {
    // What a Desktop left by the bug holds: the staged database with its record, no registry, no record under the old name.
    await makeDatabase(`ghostly_${STAGED}`);
    await enrollDevice(`ghostly_${STAGED}`, "active", { home: `ghostly_${BASE}` });
    expect(await recoverHandoffPointer("")).toBe(true);
    expect(namespaceOf("")).toBe(STAGED);
    // Once pointed, nothing more to do.
    expect(await recoverHandoffPointer("")).toBe(false);
  });

  it("is left alone where its own database still has a record (a handoff not installed yet, or one that stepped back)", async () => {
    await makeDatabase(`ghostly_${STAGED}`);
    await enrollDevice(`ghostly_${STAGED}`, "standby", { home: `ghostly_${BASE}` });
    await enrollDevice(`ghostly_${BASE}`, "standby");
    expect(await recoverHandoffPointer("")).toBe(false);
    expect(namespaceOf("")).toBe(BASE);
  });

  it("is left alone where the staged database is gone, or no record names it", async () => {
    await enrollDevice(`ghostly_${STAGED}`, "active", { home: `ghostly_${BASE}` });
    expect(await recoverHandoffPointer("")).toBe(false);
    await enrollDevice(`ghostly_${BASE}-stagebbbbb`, "active");
    await makeDatabase(`ghostly_${BASE}-stagebbbbb`);
    expect(await recoverHandoffPointer("")).toBe(false);
    expect(namespaceOf("")).toBe(BASE);
    // Nothing at all on the device: nothing to do, and no device database made.
    await dropAll();
    expect(await recoverHandoffPointer("")).toBe(false);
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([]);
  });
});
