import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wrap } from "../src/shared/idb";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { registerProfile } from "../../../apps/ui/src/lib/profiles";
import { deleteProfile } from "../../../apps/ui/src/lib/profileData";
// covers: profiles.delete

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
/** The origin-private file system, as far as deleting a file goes. */
const files = new Set<string>();
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
beforeEach(() => {
  setStorageProfile("");
  files.clear();
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() } }, configurable: true });
  const root = { async removeEntry(name: string) { if (!files.delete(name)) throw Object.assign(new Error("missing"), { name: "NotFoundError" }); } };
  Object.defineProperty(globalThis, "navigator", { value: { storage: { getDirectory: async () => root } }, configurable: true });
});
afterEach(() => {
  if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

async function makeDatabase(name: string) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("data"); };
  (await wrap(request)).close();
}
async function makeProfile(id: string, records: Record<string, unknown>) {
  const entry = registerProfile(id, id);
  const request = indexedDB.open(`ghostly_${id}`, 1);
  request.onupgradeneeded = () => {
    const settings = request.result.createObjectStore("settings");
    for (const [key, value] of Object.entries(records)) settings.put(value, key);
  };
  (await wrap(request)).close();
  return entry;
}
const databases = async () => (await indexedDB.databases()).map((d) => d.name);

it("deleting a profile deletes its Bark databases and Fedimint files too, and never those another profile still names", async () => {
  const gone = await makeProfile("goneprofil", {
    "barkWallet-mode-testnet": { config: { walletId: "bark-gone", network: "signet" } },
    "barkWallet-retired-1": { config: { walletId: "bark-shared", network: "signet" } },
    "fedimintWallet-testnet": { federations: [{ id: "f1", database: "ghostly-fedimint-gone.db" }, { id: "f2", database: "ghostly-fedimint-shared.db" }] },
    "fedimintRetired-testnet-f0": { id: "f0", database: "ghostly-fedimint-retired.db" },
  });
  await makeProfile("keptprofil", {
    "barkWallet-mode-testnet": { config: { walletId: "bark-shared", network: "signet" } },
    "fedimintWallet-testnet": { federations: [{ id: "f2", database: "ghostly-fedimint-shared.db" }] },
  });
  for (const name of ["ghostly-bark-bark-gone", "ghostly-bark-bark-gone-onchain", "ghostly-bark-bark-shared", "ghostly-bark-bark-shared-onchain"]) await makeDatabase(name);
  for (const name of ["ghostly-fedimint-gone.db", "ghostly-fedimint-shared.db", "ghostly-fedimint-retired.db"]) files.add(name);

  await deleteProfile(gone.id);

  const left = await databases();
  expect(left).not.toContain("ghostly-bark-bark-gone");
  expect(left).not.toContain("ghostly-bark-bark-gone-onchain");
  expect(left, "the other profile's Bark wallet stays").toContain("ghostly-bark-bark-shared");
  expect(left).toContain("ghostly-bark-bark-shared-onchain");
  expect([...files], "only the other profile's federation file stays").toEqual(["ghostly-fedimint-shared.db"]);
});

it("a Fedimint file already gone, or no file system at all, does not stop the delete", async () => {
  const gone = await makeProfile("nofileprof", { "fedimintWallet-testnet": { federations: [{ id: "f1", database: "ghostly-fedimint-never.db" }] } });
  await deleteProfile(gone.id);
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  const bare = await makeProfile("nofsprofil", { "fedimintWallet-testnet": { federations: [{ id: "f1", database: "ghostly-fedimint-other.db" }] } });
  await deleteProfile(bare.id);
  expect(await databases()).not.toContain(`ghostly_${bare.id}`);
});

// covers: devices.gate
it("deleting a profile takes its device record with it, and leaves another profile's (WISP 06)", async () => {
  const { putDeviceRecord } = await import("./helpers/deviceRecord");
  const { closeDevicesDb, deviceStateOf } = await import("../src/devices/store");
  const gone = registerProfile("devicegone", "Gone"), kept = registerProfile("devicekept", "Kept");
  const record = (id: string) => ({ v: 1 as const, profile: `ghostly_${id}`, state: "standby" as const, saved: 1, turn: 1, rev: 0, deviceSet: [], takeovers: 0, earlierSets: [] });
  await putDeviceRecord(record(gone.id));
  await putDeviceRecord(record(kept.id));
  await deleteProfile(gone.id);
  expect(await deviceStateOf(`ghostly_${gone.id}`)).toBe("single");
  expect(await deviceStateOf(`ghostly_${kept.id}`)).toBe("standby");
  await closeDevicesDb();
});
