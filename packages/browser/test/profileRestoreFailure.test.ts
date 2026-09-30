import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { STORES, openDb, transact, wrap } from "../src/shared/idb";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { listProfiles } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
// covers: backup.profile.file

/** localStorage with room for `room` more writes, then the browser's QuotaExceededError. */
class FullStorage {
  entries = new Map<string, string>();
  room = Infinity;
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (this.room-- <= 0) throw Object.assign(new Error(`Setting the value of '${k}' exceeded the quota.`), { name: "QuotaExceededError" });
    this.entries.set(k, v);
  }
  removeItem(k: string) { this.entries.delete(k); }
}
let storage: FullStorage;
beforeEach(() => {
  storage = new FullStorage();
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
});

async function makeArkDatabase(walletId: string) {
  const request = indexedDB.open(`ghostly-ark-${walletId}`, 3);
  request.onupgradeneeded = () => {
    for (const name of ["vtxos", "utxos", "transactions", "walletState", "contracts", "contractsCollections"]) request.result.createObjectStore(name, { keyPath: "id" });
  };
  (await wrap(request)).close();
}
const databases = async () => (await indexedDB.databases()).map((d) => d.name).sort();

it("a restore that runs out of room says so and leaves nothing behind: no profile, no database, no key", async () => {
  storage.setItem("ghostly_0123456789abcdef0123456789abcdef", JSON.stringify({ id: "c", mySeedB64: "c2VlZA", messages: [] }));
  storage.setItem("ghostly_app_settings", JSON.stringify({ colorTheme: "purple" }));
  storage.setItem("ghostly_pin_0123456789abcdef0123456789abcdef", "1");
  await openDb();
  await makeArkDatabase("wallet-old");
  await transact([STORES.links, STORES.settings], (s) => {
    s[STORES.links].put({ id: "link1", seedB64: "seed", peerPubKeyZ32: "peer" });
    s[STORES.settings].put({ config: { walletId: "wallet-old", network: "bitcoin" }, seed: { version: 1 } }, "arkWallet-mode-mainnet");
  });
  const bundle = await createProfileBackup("a long backup passphrase");
  const keysBefore = [...storage.entries.keys()].sort();
  const databasesBefore = await databases();

  // Room for one of the profile's three keys: the second write fails.
  storage.room = 1;
  await expect(restoreProfileBackup(bundle, "a long backup passphrase")).rejects.toThrow("no room left");

  expect(listProfiles().map((p) => p.id), "no half-made profile in the list").toEqual([""]);
  expect([...storage.entries.keys()].sort(), "the key written before the failure is gone again").toEqual(keysBefore);
  expect(await databases(), "neither the peer database nor the Ark wallet's copy stays").toEqual(databasesBefore);

  // With room again, the same bundle restores.
  storage.room = Infinity;
  const restored = await restoreProfileBackup(bundle, "a long backup passphrase");
  expect(listProfiles().map((p) => p.id)).toEqual(["", restored.id]);
});
