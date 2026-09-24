import { beforeEach, expect, it, vi } from "vitest";
import { ensureSession, listSessions, ownsKey, setStorageProfile } from "../../../src/lib/storage";
import { clearAllData, loadSettings } from "../../../src/lib/settings";
import { activeProfileId, createProfile, lastRouteOf, listProfiles, renameProfile, switchProfile, themeOf } from "../../../src/lib/profiles";
// covers: profiles.create, profiles.switch, app.clear-data

vi.mock("@ghostly/browser/shared/idb", () => ({ clearChatData: vi.fn(async () => {}) }));

/** Enough of the Web Storage API and of `window` for local profiles; node has neither. */
class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
let storage: FakeStorage;
const reload = vi.fn(), replaceState = vi.fn();
beforeEach(() => {
  replaceState.mockClear();
  storage = new FakeStorage();
  reload.mockClear();
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload }, history: { replaceState } }, configurable: true });
});
const chat = (peer: string) => ensureSession({ seedB64: "c2VlZA", peerPubKeyB64: peer, encKeyB64: "ZW5j" });

it("starts with the default profile, in the original namespace", () => {
  expect(listProfiles()).toEqual([{ id: "", name: "Personal", createdAt: 0 }]);
  expect(activeProfileId()).toBe("");
});

it("gives a new profile a name, a color no other profile uses, and the current language", () => {
  storage.setItem("ghostly_app_settings", JSON.stringify({ colorTheme: "cyan", language: "pt" }));
  const work = createProfile("  Work  ");
  expect(work.name).toBe("Work");
  expect(work.id).toMatch(/^[a-z0-9]{10}$/);
  expect(themeOf(work.id)).toBe("purple");
  expect(themeOf(createProfile("Family").id)).toBe("classic");
  setStorageProfile(work.id);
  expect(loadSettings()).toMatchObject({ colorTheme: "purple", language: "pt" });
  renameProfile(work.id, "Job");
  expect(listProfiles().find((p) => p.id === work.id)?.name).toBe("Job");
  expect(() => createProfile("   ")).toThrow("name");
});

it("switches by restarting as the other profile, each one reopening where it was left", () => {
  vi.useFakeTimers();
  try {
    const work = createProfile("Work");
    (window.location as { hash: string }).hash = "#/wallet";
    switchProfile(work.id);
    // The page shows the switch for a moment, still as the old profile, then restarts as the new one.
    expect(activeProfileId()).toBe("");
    vi.advanceTimersByTime(100);
    expect(activeProfileId()).toBe(work.id);
    expect(reload).toHaveBeenCalledOnce();
    expect(lastRouteOf(""), "Personal was left on its wallet").toBe("/wallet");
    expect(replaceState).toHaveBeenCalledWith(null, "", "#/");
    expect(() => switchProfile("nosuchprof")).toThrow("Unknown");
    // Back to Personal: its wallet.
    switchProfile("");
    vi.advanceTimersByTime(100);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "#/wallet");
  } finally { vi.useRealTimers(); }
});

it("keeps each profile's chats to itself, the default one included", () => {
  chat("personalpeer");
  const work = createProfile("Work");
  setStorageProfile(work.id);
  chat("workpeer");
  expect(listSessions().map((s) => s.peerPubKeyB64)).toEqual(["workpeer"]);
  setStorageProfile("");
  expect(listSessions().map((s) => s.peerPubKeyB64), "the default prefix is also the start of the others").toEqual(["personalpeer"]);
});

it("clears only the active profile's data, and never the list of profiles", async () => {
  chat("personalpeer");
  const work = createProfile("Work");
  setStorageProfile(work.id);
  chat("workpeer");
  // The default profile's clear: its prefix starts every other profile's keys, which stay.
  setStorageProfile("");
  await clearAllData();
  expect(listSessions()).toEqual([]);
  expect(listProfiles().map((p) => p.name)).toEqual(["Personal", "Work"]);
  setStorageProfile(work.id);
  expect(listSessions().map((s) => s.peerPubKeyB64)).toEqual(["workpeer"]);
  expect(themeOf(work.id)).toBe("purple");
  // Work's own clear leaves the list of profiles.
  await clearAllData();
  expect(listSessions()).toEqual([]);
  expect(listProfiles().map((p) => p.name)).toEqual(["Personal", "Work"]);
});

it("the default profile does not take the keys of another storage space side by side with it", async () => {
  chat("personalpeer");
  // A Desktop test space (GHOSTLY_PROFILE=wallets-a) and one of its profiles, in the same storage.
  storage.setItem("ghostly_wallets-a_app_settings", "{}");
  storage.setItem("ghostly_wallets-a_0123456789abcdef0123456789abcdef", "{}");
  storage.setItem("ghostly_wallets-a-abcdefghij_app_settings", "{}");
  storage.setItem("ghostly_wallets-a-abcdefghij_pinned", "[]");
  expect(ownsKey("ghostly_wallets-a_0123456789abcdef0123456789abcdef")).toBe(false);
  expect(ownsKey("ghostly_wallets-a-abcdefghij_pinned")).toBe(false);
  expect(ownsKey("ghostly_app_settings")).toBe(true);
  await clearAllData();
  expect(listSessions()).toEqual([]);
  expect(storage.getItem("ghostly_wallets-a_0123456789abcdef0123456789abcdef"), "the other space keeps its chat").toBe("{}");
  expect(storage.getItem("ghostly_wallets-a-abcdefghij_pinned")).toBe("[]");
});
