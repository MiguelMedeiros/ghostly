import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { baseProfileName, clearRestoredMark, createProfile, listProfiles, registryKey, renameProfile, setRestoredProfileName } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
// covers: backup.profile.file, app.i18n

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
afterEach(() => setRestoredProfileName((name) => `${name} (restored)`));

const PASSPHRASE = "a long backup passphrase";
const stored = () => (JSON.parse(storage.getItem(registryKey())!) as { profiles: { id: string; name: string; restored?: boolean }[] }).profiles;
const pt = (name: string) => `${name} (restaurado)`;

it("a restored profile says \"restored\" in the app's language, and the registry keeps its name without it", async () => {
  const work = createProfile("Work");
  const bundle = await createProfileBackup(PASSPHRASE, work.id);
  setRestoredProfileName(pt);
  const back = await restoreProfileBackup(bundle, PASSPHRASE);
  expect(back.name, "what the restore says it made").toBe("Work (restaurado)");
  expect(listProfiles().find((p) => p.id === back.id)?.name).toBe("Work (restaurado)");
  expect(stored().find((p) => p.id === back.id), "nothing translated is written").toMatchObject({ name: "Work", restored: true });

  setRestoredProfileName((name) => `${name} (restored)`);
  expect(listProfiles().find((p) => p.id === back.id)?.name, "back to English").toBe("Work (restored)");

  // A backup of the restored one carries its name, not the word: restored again, it is not "restored" twice.
  setRestoredProfileName(pt);
  const again = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, back.id), PASSPHRASE);
  expect(again.name).toBe("Work (restaurado)");
});

const es = (name: string) => `${name} (restaurado)`;
const shownName = (id: string) => listProfiles().find((p) => p.id === id)?.name;

// The Profile page's field once showed "Work (restaurado)", and saving it wrote the word into the name and dropped
// the mark: English then still said "(restaurado)", and a backup and restore of it said restored twice.
it.each([["pt", pt], ["es", es]] as const)("in %s, a restored profile renamed keeps its mark and never the word, in any language and after a round trip", async (_, local) => {
  const work = createProfile("Work");
  setRestoredProfileName(local);
  const back = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, work.id), PASSPHRASE);
  expect(back.name).toBe("Work (restaurado)");
  // What the field holds: the name alone.
  expect(baseProfileName(back.id)).toBe("Work");

  // The name part edited, as written in the field before: the word comes off and is the mark.
  renameProfile(back.id, "Old work (restaurado)");
  expect(stored().find((p) => p.id === back.id)).toMatchObject({ name: "Old work", restored: true });
  renameProfile(back.id, "Old work");
  expect(stored().find((p) => p.id === back.id), "a rename keeps the mark").toMatchObject({ name: "Old work", restored: true });
  expect(shownName(back.id)).toBe("Old work (restaurado)");

  setRestoredProfileName((name) => `${name} (restored)`);
  expect(shownName(back.id), "in English").toBe("Old work (restored)");
  setRestoredProfileName(local);

  const again = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, back.id), PASSPHRASE);
  expect(again.name, "restored once, not twice").toBe("Old work (restaurado)");
  expect(stored().find((p) => p.id === again.id)).toMatchObject({ name: "Old work", restored: true });
});

it("the word in any of the app's languages, or twice, is never kept in a name", () => {
  const work = createProfile("Work");
  for (const [typed, name] of [
    ["Old work (restaurado) (restored)", "Old work"],
    ["Travail (restauré)", "Travail"],
    ["Travail (restaure\u0301)", "Travail"],
    ["Lavoro (ripristinato)", "Lavoro"],
    ["عمل (مستعاد)", "عمل"],
    ["工作（已恢复）", "工作"],
    ["仕事（復元）", "仕事"],
    ["Work  (Restored) ", "Work"],
  ]) {
    renameProfile(work.id, typed);
    expect(stored().find((p) => p.id === work.id), typed).toMatchObject({ name, restored: true });
  }
  // A name that is only the word, or with the word inside it, is a name.
  renameProfile(work.id, "Restored (old) work");
  expect(stored().find((p) => p.id === work.id)?.name).toBe("Restored (old) work");
});

it("the mark taken off, a restored profile is shown by its name alone", async () => {
  const work = createProfile("Work");
  const back = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, work.id), PASSPHRASE);
  setRestoredProfileName(pt);
  clearRestoredMark(back.id);
  expect(shownName(back.id)).toBe("Work");
  expect(stored().find((p) => p.id === back.id)).not.toHaveProperty("restored");
});

it("a registry or backup that kept the translated word in the name, unmarked, is read as restored", async () => {
  const work = createProfile("Work");
  const registry = JSON.parse(storage.getItem(registryKey())!) as { profiles: { id: string; name: string }[] };
  storage.setItem(registryKey(), JSON.stringify({ ...registry, profiles: registry.profiles.map((p) => (p.id === work.id ? { ...p, name: "Old work (restaurado)" } : p)) }));
  setRestoredProfileName((name) => `${name} (restored)`);
  expect(shownName(work.id)).toBe("Old work (restored)");
  expect(baseProfileName(work.id)).toBe("Old work");
  const back = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, work.id), PASSPHRASE);
  expect(back.name).toBe("Old work (restored)");
});

it("a profile an older app restored, with the English word in its name, is read as restored", async () => {
  const work = createProfile("Work");
  const registry = JSON.parse(storage.getItem(registryKey())!) as { profiles: { id: string; name: string }[] };
  storage.setItem(registryKey(), JSON.stringify({ ...registry, profiles: registry.profiles.map((p) => (p.id === work.id ? { ...p, name: "Work (restored)" } : p)) }));
  setRestoredProfileName(pt);
  expect(listProfiles().find((p) => p.id === work.id)?.name).toBe("Work (restaurado)");
  // And a backup of it restores without the English word either.
  expect((await restoreProfileBackup(await createProfileBackup(PASSPHRASE, work.id), PASSPHRASE)).name).toBe("Work (restaurado)");
});
