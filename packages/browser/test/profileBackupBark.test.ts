import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { wrap } from "../src/shared/idb";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { registerProfile } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
// covers: backup.profile.file

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
beforeEach(() => {
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
});

it("a restored copy never opens its original's Bark databases: every Bark wallet, current or retired, gets a fresh id", async () => {
  const original = registerProfile("barkorigin", "Bark");
  const request = indexedDB.open(`ghostly_${original.id}`, 1);
  request.onupgradeneeded = () => {
    const settings = request.result.createObjectStore("settings");
    settings.put({ config: { walletId: "bark-current", network: "signet" }, seed: { version: 1 } }, "barkWallet-mode-testnet");
    settings.put({ config: { walletId: "bark-old", network: "signet" }, seed: { version: 1 } }, "barkWallet-retired-1");
  };
  (await wrap(request)).close();

  const copy = await restoreProfileBackup(await createProfileBackup("a long backup passphrase", original.id), "a long backup passphrase");
  const db = await wrap(indexedDB.open(`ghostly_${copy.id}`));
  try {
    const store = db.transaction("settings").objectStore("settings");
    const current = await wrap(store.get("barkWallet-mode-testnet")) as { config: { walletId: string; network: string } };
    const retired = await wrap(store.get("barkWallet-retired-1")) as { config: { walletId: string } };
    expect(current.config.walletId, "the original's ghostly-bark-<id> may still be on this device").not.toBe("bark-current");
    expect(retired.config.walletId).not.toBe("bark-old");
    expect(current.config.walletId).not.toBe(retired.config.walletId);
    expect(current.config.network).toBe("signet");
  } finally { db.close(); }
});
