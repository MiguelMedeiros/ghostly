import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../src/shared/idb";
import { closeDevicesDb } from "../src/devices/store";
import { putDeviceRecord, dropDevicesDatabase } from "./helpers/deviceRecord";
import { registerProfile } from "../../../apps/ui/src/lib/profiles";
import { walletsAtHome, walletsAtHomeHere } from "../../../apps/ui/src/lib/profileData";
// covers: devices.remove

/*
 * Which wallets are at home on this device (WISP 06 § Wallets that stay home), read from the frozen copy of a profile
 * on a device out of its set: what "Remove this profile here" names before it deletes their own storage.
 */

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}

const HERE = "H".repeat(43), OTHER = "O".repeat(43);

beforeEach(async () => {
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "" } }, configurable: true });
  for (const { name } of await indexedDB.databases()) if (name) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
});
afterEach(async () => {
  await closeDevicesDb();
  await dropDevicesDatabase();
});

/** A profile's frozen copy with its wallet records, as `walletHomes.ts` marks them. */
async function makeCopy(database: string, rows: Record<string, unknown>) {
  const request = indexedDB.open(database, 1);
  request.onupgradeneeded = () => {
    const settings = request.result.createObjectStore("settings");
    for (const [key, value] of Object.entries(rows)) settings.put(value, key);
  };
  (await wrap(request)).close();
}
const record = (profile: string, patch: Record<string, unknown> = {}) => ({
  v: 1, profile, state: "removed", saved: 1, turn: 1, rev: 0, takeovers: 0, earlierSets: [],
  deviceSet: [{ key: OTHER, name: "Desktop" }, { key: HERE, name: "Phone" }], ownSlot: 1, ...patch,
});
const ROWS = {
  "barkWallet-mode-mainnet": { config: { walletId: "b1" }, home: { key: HERE } },
  "usdtWallet-mode-testnet": { config: {}, home: { key: HERE, expiresAt: 1 } },
  "fedimintWallet-mainnet": { database: "ghostly-fedimint-x.db", home: { key: OTHER } },
  "arkWallet-mode-mainnet": { config: { walletId: "a1" } },
  "lightningCards-mainnet": { cards: [{ id: "c1", name: "My LND", home: { key: HERE } }, { id: "c2", name: "Alby" }] },
  "barkWallet-retired-1": { home: { key: HERE } },
};

describe("the wallets at home on this device", () => {
  it("are the records and cards whose home is this device's own slot, by network", async () => {
    const profile = registerProfile("removedpr1", "Work");
    await makeCopy(`ghostly_${profile.id}`, ROWS);
    await putDeviceRecord(record(`ghostly_${profile.id}`));
    expect(await walletsAtHomeHere(profile.id)).toEqual([
      { type: "bark", network: "mainnet" },
      { type: "lightning", network: "mainnet" },
      { type: "usdt", network: "testnet" },
    ]);
  });

  it("are none without a slot of this device's own, or without a copy here", async () => {
    const profile = registerProfile("removedpr2", "Work");
    await makeCopy(`ghostly_${profile.id}`, ROWS);
    await putDeviceRecord(record(`ghostly_${profile.id}`, { ownSlot: undefined }));
    expect(await walletsAtHomeHere(profile.id)).toEqual([]);
    const empty = registerProfile("removedpr3", "Empty");
    await putDeviceRecord(record(`ghostly_${empty.id}`));
    expect(await walletsAtHomeHere(empty.id)).toEqual([]);
  });

  it("skip rows of another kind, an unknown network and a mark that is not a key", () => {
    expect(walletsAtHome(HERE, [
      ["sparkWallet-mode-regtest", { home: { key: HERE } }],
      ["onchainSource-testnet", { home: { key: HERE } }],
      ["fedimintWallet-testnet", { home: { key: 7 } }],
      [3, { home: { key: HERE } }],
      ["lightningCards-testnet", { cards: "not a list" }],
    ])).toEqual([{ type: "bitcoin", network: "testnet" }]);
  });
});
