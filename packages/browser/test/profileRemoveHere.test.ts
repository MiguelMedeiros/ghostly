import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../src/shared/idb";
import { closeDevicesDb, readDeviceRecord } from "../src/devices/store";
import { setHandoffProfileHost } from "../src/devices/handoffHost";
import { putDeviceRecord, dropDevicesDatabase } from "./helpers/deviceRecord";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { chosenProfileId, listProfiles, namespaceOf, pointProfile, registerProfile, registryKey, setRunningProfile, switchProfile } from "../../../apps/ui/src/lib/profiles";
import { removeProfileHere } from "../../../apps/ui/src/lib/profileData";
import { handoffProfileHost } from "../../../apps/ui/src/lib/handoffProfile";
// covers: devices.remove, profiles.delete

/*
 * "Remove this profile here" (WISP 06 § User experience): a device that is out of the profile's device set for good
 * holds a frozen copy, not encrypted. The page runs as that profile, on its standby screen; the button takes the copy
 * off this device, the first profile's included.
 */

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}

beforeEach(async () => {
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() }, history: { replaceState: vi.fn() } }, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: new FakeStorage(), configurable: true });
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  setHandoffProfileHost(handoffProfileHost("test", "web"));
});
afterEach(async () => {
  setHandoffProfileHost(null);
  setRunningProfile(undefined);
  await closeDevicesDb();
  await dropDevicesDatabase();
});

/** A profile's peer database with a chat's message in it, as the frozen copy keeps it. */
async function makeCopy(database: string, text: string) {
  const request = indexedDB.open(database, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("messages").put({ text }, "m1");
    request.result.createObjectStore("settings").put({ config: { walletId: `w-${database}` } }, "arkWallet-mode-mainnet");
  };
  (await wrap(request)).close();
  const wallet = indexedDB.open(`ghostly-ark-w-${database}`, 1);
  wallet.onupgradeneeded = () => { wallet.result.createObjectStore("seed").put("a wallet seed", "seed"); };
  (await wrap(wallet)).close();
}
const record = (profile: string, state: string, patch: Record<string, unknown> = {}) => ({ v: 1, profile, state, saved: 1, turn: 1, rev: 0, deviceSet: [], takeovers: 0, earlierSets: [], ...patch });
const databases = async () => (await indexedDB.databases()).map((d) => d.name);
/** The page runs as `id`, as an entry point opens it (`openProfile`). */
function runAs(id: string) {
  setRunningProfile(id);
  setStorageProfile(namespaceOf(id));
}

describe("Remove this profile here", () => {
  it("the first profile, removed: its copy, its fork and its device record go; it stays on the list, empty, and the other profiles stay as they were", async () => {
    const other = registerProfile("otherprof1", "Work");
    await makeCopy("ghostly", "a chat of the removed copy");
    await makeCopy("ghostly_oldfork01", "an older copy");
    await makeCopy(`ghostly_${other.id}`, "the other profile's chat");
    localStorage.setItem("ghostly_sess1", "the removed copy's chat");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ghostly_${other.id}_sess1`, "the other profile's chat");
    localStorage.setItem("ghostly_oldfork01_sess1", "the fork's chat");
    await putDeviceRecord(record("ghostly", "removed", { forks: ["ghostly_oldfork01"] }));
    await putDeviceRecord(record(`ghostly_${other.id}`, "active"));
    runAs("");

    await removeProfileHere();

    const left = await databases();
    expect(left, "the frozen copy").not.toContain("ghostly");
    expect(left, "its wallet's own storage").not.toContain("ghostly-ark-w-ghostly");
    expect(left, "its fork").not.toContain("ghostly_oldfork01");
    expect(left).not.toContain("ghostly-ark-w-ghostly_oldfork01");
    expect(localStorage.getItem("ghostly_sess1")).toBeNull();
    expect(localStorage.getItem("ghostly_app_settings")).toBeNull();
    expect(localStorage.getItem("ghostly_oldfork01_sess1")).toBeNull();
    expect(await readDeviceRecord("ghostly"), "no device set: it starts again empty").toBeNull();
    // The registry the app needs stays: the first profile on it, chosen; the other profile untouched.
    expect(localStorage.getItem(registryKey())).not.toBeNull();
    expect(listProfiles().map((p) => p.id)).toEqual(["", other.id]);
    expect(chosenProfileId()).toBe("");
    expect(left).toContain(`ghostly_${other.id}`);
    expect(left).toContain(`ghostly-ark-w-ghostly_${other.id}`);
    expect(localStorage.getItem(`ghostly_${other.id}_sess1`)).toBe("the other profile's chat");
    expect((await readDeviceRecord(`ghostly_${other.id}`))?.state).toBe("active");
  });

  it("the first profile, running on a namespace a handoff installed: that namespace goes, and the profile points at its own again", async () => {
    await makeCopy("ghostly_installed1", "the installed copy");
    localStorage.setItem("ghostly_installed1_sess1", "the installed copy's chat");
    pointProfile("ghostly", "ghostly_installed1");
    await putDeviceRecord(record("ghostly_installed1", "moving", { reenroll: true, home: "ghostly" }));
    runAs("");

    await removeProfileHere();

    expect(await databases()).not.toContain("ghostly_installed1");
    expect(localStorage.getItem("ghostly_installed1_sess1")).toBeNull();
    expect(namespaceOf("")).toBe("");
    expect(await readDeviceRecord("ghostly_installed1")).toBeNull();
  });

  it("another profile, removed: it goes from the list and from this device, and the next page starts as the first profile", async () => {
    const gone = registerProfile("goneprofil", "Gone");
    await makeCopy(`ghostly_${gone.id}`, "a chat of the removed copy");
    await makeCopy("ghostly", "the first profile's chat");
    localStorage.setItem(`ghostly_${gone.id}_sess1`, "the removed copy's chat");
    localStorage.setItem("ghostly_sess1", "the first profile's chat");
    await putDeviceRecord(record(`ghostly_${gone.id}`, "removed"));
    vi.useFakeTimers();
    try { switchProfile(gone.id); vi.runAllTimers(); } finally { vi.useRealTimers(); }
    runAs(gone.id);

    await removeProfileHere();

    const left = await databases();
    expect(left).not.toContain(`ghostly_${gone.id}`);
    expect(left).not.toContain(`ghostly-ark-w-ghostly_${gone.id}`);
    expect(localStorage.getItem(`ghostly_${gone.id}_sess1`)).toBeNull();
    expect(await readDeviceRecord(`ghostly_${gone.id}`)).toBeNull();
    expect(listProfiles().map((p) => p.id)).toEqual([""]);
    expect(chosenProfileId()).toBe("");
    expect(left, "the first profile's data stays").toContain("ghostly");
    expect(localStorage.getItem("ghostly_sess1")).toBe("the first profile's chat");
  });

  it("is refused on a device that is still in the set (standby, moving with a way back, active, or no set): nothing is deleted", async () => {
    await makeCopy("ghostly", "kept");
    localStorage.setItem("ghostly_sess1", "kept");
    runAs("");
    await expect(removeProfileHere()).rejects.toThrow();
    for (const [state, patch] of [["standby", {}], ["moving", {}], ["active", {}]] as const) {
      await putDeviceRecord({ ...record("ghostly", state, patch), saved: 2 });
      await closeDevicesDb();
      await expect(removeProfileHere()).rejects.toThrow();
    }
    expect(await databases()).toContain("ghostly");
    expect(localStorage.getItem("ghostly_sess1")).toBe("kept");
    expect((await readDeviceRecord("ghostly"))?.state).toBe("active");
  });
});
