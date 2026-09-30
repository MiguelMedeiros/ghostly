import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProfile, currentProfile, listProfiles, registryKey, renameProfile, setDefaultProfileName } from "../../../apps/ui/src/lib/profiles";
// covers: profiles.create, app.i18n

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
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
});
afterEach(() => setDefaultProfileName("Personal"));

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
