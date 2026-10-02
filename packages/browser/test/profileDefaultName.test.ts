import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { builtInNameBefore, clearRestoredMark, createProfile, currentProfile, listProfiles, registerProfile, registryKey, renameProfile, setDefaultProfileName, setRestoredProfileName, storedProfileName } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, openProfileBackup, restoreOpenedBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
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

/** A bundle of the active profile as an app from before the marker made it: this name, no `builtIn`, these settings. */
async function oldBackup(name: string, language?: string) {
  const opened = await openProfileBackup(await createProfileBackup(PASSPHRASE), PASSPHRASE);
  const payload = opened.payload as unknown as { profile: { name: string; builtIn?: boolean }; storage: Record<string, string> };
  payload.profile = { name };
  if (language) payload.storage.app_settings = JSON.stringify({ language }); else delete payload.storage.app_settings;
  return opened;
}

it("the backup says whether its name is the built-in one", async () => {
  portuguese();
  const marker = async () => (await openProfileBackup(await createProfileBackup(PASSPHRASE), PASSPHRASE)).payload.profile;
  expect(await marker(), "never renamed").toEqual({ name: "Personal", builtIn: true });
  renameProfile("", "Pessoal");
  expect(await marker(), "typed, the same word as the Portuguese built-in name").toEqual({ name: "Pessoal", builtIn: false });
  renameProfile("", "Casa");
  expect(await marker()).toEqual({ name: "Casa", builtIn: false });
});

// The restore read every "Pessoal" as the built-in name: one someone typed came back as "Personal" in an English app.
it("a name typed like the built-in name of a language is restored as typed, in every language", async () => {
  english();
  renameProfile("", "Pessoal");
  const bundle = await createProfileBackup(PASSPHRASE);
  const back = await restoreProfileBackup(bundle, PASSPHRASE);
  expect(back.name).toBe("Pessoal (restored)");
  expect(stored().find((p) => p.id === back.id)).toMatchObject({ name: "Pessoal", restored: true });
  portuguese();
  expect(shownName(back.id)).toBe("Pessoal (restaurado)");
  setDefaultProfileName("個人");
  expect(shownName(back.id), "no language renames it").toBe("Pessoal (restaurado)");

  // A second profile named so in a Portuguese app, too.
  const typed = createProfile("Pessoal");
  expect(registerProfile("typedcopy0", typed.name, true, false).name).toBe("Pessoal (restaurado)");
  expect(stored().find((p) => p.id === "typedcopy0")?.name).toBe("Pessoal");
});

it("a backup from before the marker has the built-in name when its name is the first profile's in its own language", async () => {
  for (const [language, name] of [["pt", "Pessoal"], ["fr", "Personnel"], ["ja", "個人"], ["es", "Personal"], [undefined, "Personal"], ["pt", "Personal"]] as const) {
    const back = await restoreOpenedBackup(await oldBackup(name, language));
    expect(back.name, `${language}: ${name}`).toBe("Personal (restored)");
    expect(stored().find((p) => p.id === back.id)?.name).toBe("Personal");
  }
  // An older app that restored it wrote the word for restored in the name: it comes off first.
  const again = await restoreOpenedBackup(await oldBackup("Pessoal (restaurado)", "pt"));
  expect(stored().find((p) => p.id === again.id)).toMatchObject({ name: "Personal", restored: true });
});

it("a backup from before the marker keeps a name that is the first profile's in another language than its own", async () => {
  for (const [language, name] of [["en", "Pessoal"], [undefined, "Pessoal"], ["pt", "Personnel"], ["ja", "个人"], ["xx", "Pessoal"]] as const) {
    const back = await restoreOpenedBackup(await oldBackup(name, language));
    expect(back.name, `${language}: ${name}`).toBe(`${name} (restored)`);
    expect(stored().find((p) => p.id === back.id)?.name).toBe(name);
  }
  expect(builtInNameBefore("Casa", "pt")).toBe(false);
});

it("a marker that is not a yes or a no is read as none", async () => {
  const opened = await oldBackup("Pessoal", "pt");
  (opened.payload.profile as { builtIn?: unknown }).builtIn = "yes";
  expect((await restoreOpenedBackup(opened)).name).toBe("Personal (restored)");
});

it("a profile someone names like the built-in name of a language keeps that name", () => {
  expect(createProfile("Pessoal").name).toBe("Pessoal");
  expect(registerProfile("pessoal000", "Pessoal", true).name, "restored with no marker said").toBe("Pessoal (restored)");
});

it("a renamed first profile's backup carries the name it was given", async () => {
  portuguese();
  renameProfile("", "Casa");
  const bundle = await createProfileBackup(PASSPHRASE);
  english();
  expect((await restoreProfileBackup(bundle, PASSPHRASE)).name).toBe("Casa (restored)");
});
