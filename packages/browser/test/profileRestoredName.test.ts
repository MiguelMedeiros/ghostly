import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { createProfile, listProfiles, registryKey, renameProfile, setRestoredProfileName } from "../../../apps/ui/src/lib/profiles";
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

it("a name someone gives a restored profile is shown as they wrote it", async () => {
  const work = createProfile("Work");
  const back = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, work.id), PASSPHRASE);
  setRestoredProfileName(pt);
  renameProfile(back.id, "Old work");
  expect(listProfiles().find((p) => p.id === back.id)?.name).toBe("Old work");
  expect(stored().find((p) => p.id === back.id)).not.toHaveProperty("restored");
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
