import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wrap } from "../src/shared/idb";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { activeProfileId, createProfile, currentProfile, registryKey, setRunningProfile, switchProfile } from "../../../apps/ui/src/lib/profiles";
import { deleteProfile } from "../../../apps/ui/src/lib/profileData";
import { createProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
import { hashPassword } from "../../../apps/ui/src/lib/settings";
// covers: profiles.switch, profiles.lock

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
let storage: FakeStorage;
const reload = vi.fn();
beforeEach(() => {
  storage = new FakeStorage();
  reload.mockClear();
  setStorageProfile("");
  setRunningProfile(undefined);
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload }, history: { replaceState: vi.fn() } }, configurable: true });
});
afterEach(() => setRunningProfile(undefined));

/** Another tab makes `id` the profile in use, the way its switchProfile writes the registry. */
function chosenElsewhere(id: string) {
  const registry = JSON.parse(storage.getItem(registryKey())!) as { active: string };
  storage.setItem(registryKey(), JSON.stringify({ ...registry, active: id }));
}

it("a tab that took over as Personal stays Personal after another tab chose Work, and asks Work's lock password", async () => {
  const lockScreen = { enabled: true, passwordHash: await hashPassword("hunter2 hunter2"), timeoutMinutes: 5 };
  const work = createProfile("Work");
  storage.setItem(`ghostly_${work.id}_app_settings`, JSON.stringify({ lockScreen }));
  const request = indexedDB.open(`ghostly_${work.id}`, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("settings").put({ nick: "work" }, "settings"); };
  (await wrap(request)).close();

  // This tab started as Personal (the entry point fixes it), then waited while another tab switched to Work.
  setRunningProfile("");
  chosenElsewhere(work.id);

  expect(activeProfileId(), "this page still runs Personal's storage").toBe("");
  expect(currentProfile().name, "and says so: not Work's name over Personal's chats").toBe("Personal");
  await expect(createProfileBackup("a long backup passphrase", work.id), "Work is another profile here: its lock holds").rejects.toThrow("lock password");
  await expect(deleteProfile(work.id, "hunter2 hunter2"), "the profile the other tab chose is not deleted under it").rejects.toThrow("Switch to another profile first");

  // Switching to Work from here restarts this tab as Work, though the registry already names it.
  vi.useFakeTimers();
  try {
    switchProfile(work.id);
    vi.advanceTimersByTime(100);
  } finally { vi.useRealTimers(); }
  expect(reload).toHaveBeenCalledOnce();
});

it("before a page starts, the profile in use is the one last chosen", () => {
  const work = createProfile("Work");
  chosenElsewhere(work.id);
  expect(activeProfileId()).toBe(work.id);
});

it("deleting a profile another tab runs says it is open there, not to switch, though that tab made it the choice", async () => {
  const work = createProfile("Work");
  setRunningProfile("");
  chosenElsewhere(work.id);
  // The other tab holds Work's peer lock (see the entry points).
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { locks: { query: async () => ({ held: [{ name: `ghostly-peer-${work.id}` }] }) } }, configurable: true });
  try {
    await expect(deleteProfile(work.id)).rejects.toThrow("This profile is open in another window. Close it, then try again.");
  } finally {
    if (before) Object.defineProperty(globalThis, "navigator", before);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
  await expect(deleteProfile(work.id), "once it is closed there, it is still the choice of the next page").rejects.toThrow("Switch to another profile first");
});
