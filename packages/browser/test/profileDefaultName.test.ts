import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { clearRestoredMark, createProfile, currentProfile, listProfiles, registerProfile, registryKey, renameProfile, setDefaultProfileName, setRestoredProfileName, storedProfileName } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
// covers: profiles.create, backup.profile.file, app.i18n

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
let storage: FakeStorage;
beforeEach(() => {
  storage = new FakeStorage();
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
});
afterEach(() => english());

const PASSPHRASE = "a long backup passphrase";
const stored = () => (JSON.parse(storage.getItem(registryKey())!) as { profiles: { id: string; name: string; restored?: boolean }[] }).profiles;
const shownName = (id: string) => listProfiles().find((p) => p.id === id)?.name;
/** What I18nContext sets for each language. */
const portuguese = () => { setDefaultProfileName("Pessoal"); setRestoredProfileName((name) => `${name} (restaurado)`); };
const english = () => { setDefaultProfileName("Personal"); setRestoredProfileName((name) => `${name} (restored)`); };

it("the first profile, never renamed, is called by the app's language, and the registry keeps the built-in name", () => {
  createProfile("Work");
  setDefaultProfileName("Pessoal");
  expect(listProfiles().map((p) => p.name)).toEqual(["Pessoal", "Work"]);
  expect(currentProfile().name).toBe("Pessoal");
  expect(JSON.parse(storage.getItem(registryKey())!).profiles[0].name, "back to English, it reads Personal again").toBe("Personal");
  setDefaultProfileName("Personal");
  expect(listProfiles()[0].name).toBe("Personal");
});

it("a name someone gave the first profile is never replaced", () => {
  setDefaultProfileName("Pessoal");
  renameProfile("", "Casa");
  expect(listProfiles()[0].name).toBe("Casa");
});

// A backup made in Portuguese carried "Pessoal": the restored copy kept it, in every language.
it("backed up in Portuguese and restored, the first profile never renamed follows the language", async () => {
  portuguese();
  expect(storedProfileName(""), "shown as Pessoal, kept as the built-in name").toBe("Personal");
  const back = await restoreProfileBackup(await createProfileBackup(PASSPHRASE), PASSPHRASE);
  expect(back.name).toBe("Pessoal (restaurado)");
  expect(stored().find((p) => p.id === back.id)).toMatchObject({ name: "Personal", restored: true });

  english();
  expect(shownName(back.id), "switched to English").toBe("Personal (restored)");
  clearRestoredMark(back.id);
  expect(shownName(back.id), "the mark taken off, the name still follows the language").toBe("Personal");
  portuguese();
  expect(shownName(back.id)).toBe("Pessoal");
});

it("a backup an older app made of the first profile, in that app's language, restores with the built-in name", () => {
  for (const [id, name] of [["pessoal000", "Pessoal"], ["personnel0", "Personnel"], ["kojin00000", "個人"]]) {
    expect(registerProfile(id, name, true).name, name).toBe("Personal (restored)");
    expect(stored().find((p) => p.id === id)?.name).toBe("Personal");
  }
  // Only a restored one: a profile someone names "Pessoal" keeps that name.
  expect(createProfile("Pessoal").name).toBe("Pessoal");
});

it("a renamed first profile's backup carries the name it was given", async () => {
  portuguese();
  renameProfile("", "Casa");
  const bundle = await createProfileBackup(PASSPHRASE);
  english();
  expect((await restoreProfileBackup(bundle, PASSPHRASE)).name).toBe("Casa (restored)");
});
