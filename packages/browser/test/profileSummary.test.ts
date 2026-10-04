import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { wrap } from "../src/shared/idb";
import { setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { registerProfile } from "../../../apps/ui/src/lib/profiles";
import { profileSummary, walletsIn } from "../../../apps/ui/src/lib/profileData";
// covers: profiles.delete

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

it("the delete dialog's summary names every wallet a profile keeps, as each network's wallet is stored now", async () => {
  const entry = registerProfile("walletprof", "Wallets");
  const request = indexedDB.open(`ghostly_${entry.id}`, 1);
  request.onupgradeneeded = () => {
    const settings = request.result.createObjectStore("settings");
    // Where every wallet has lived since wallets got their own network: never under the bare key.
    settings.put({ config: { walletId: "a", network: "mutinynet" } }, "arkWallet-mode-testnet");
    settings.put({ config: { walletId: "b", network: "bitcoin" } }, "arkWallet-mode-mainnet");
    settings.put({ config: { network: "sepolia" } }, "usdtWallet-mode-testnet");
    settings.put({ config: { walletId: "c", network: "signet" } }, "barkWallet-mode-testnet");
    settings.put({ network: "regtest" }, "sparkWallet-mode-testnet");
    settings.put({ federations: [] }, "fedimintWallet-testnet");
    settings.put({ providerId: "nwc" }, "lightningSource-testnet-card1");
    settings.put({ providerId: "bdk" }, "onchainSource-testnet");
    request.result.createObjectStore("proofs", { keyPath: "secret" });
    request.result.createObjectStore("services", { keyPath: "id" });
  };
  (await wrap(request)).close();

  expect((await profileSummary(entry.id)).wallets).toEqual(["Ark", "USDT", "Bark", "Spark", "Fedimint", "Lightning", "Bitcoin"]);
});

it("an archived wallet, a source's bookkeeping or another record is not a wallet the profile keeps", () => {
  expect(walletsIn(["arkWallet-retired-1", "barkWallet-retired-2-testnet", "fedimintWallet-retired-testnet-3", "fedimintRetired-testnet-f", "fedimintReceive-op",
    "lightningSourceSeen-testnet", "lightningCards-testnet", "settings", "identityProofs"])).toEqual([]);
  expect(walletsIn(["arkWallet", "usdtWallet"]), "an older app's bare keys still count").toEqual(["Ark", "USDT"]);
});

// covers: devices.gate
it("a profile this device is on standby for is summed up without opening its database (WISP 06)", async () => {
  const { putDeviceRecord } = await import("./helpers/deviceRecord");
  const entry = registerProfile("standbypro", "Standby");
  const request = indexedDB.open(`ghostly_${entry.id}`, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("settings").put({ config: { walletId: "a", network: "mutinynet" } }, "arkWallet-mode-testnet");
    request.result.createObjectStore("proofs", { keyPath: "secret" }).put({ secret: "s", amount: 21 });
  };
  (await wrap(request)).close();
  expect(await profileSummary(entry.id)).toMatchObject({ cashuSats: 21, wallets: ["Ark"] });

  await putDeviceRecord({ v: 1, profile: `ghostly_${entry.id}`, state: "standby", saved: 1, turn: 1, rev: 0, deviceSet: [], takeovers: 0, earlierSets: [] });
  const opened: string[] = [];
  const open = indexedDB.open.bind(indexedDB);
  const spy = vi.spyOn(indexedDB, "open").mockImplementation((name: string, version?: number) => { opened.push(name); return open(name, version); });
  expect(await profileSummary(entry.id)).toMatchObject({ cashuSats: 0, wallets: [] });
  expect(opened).not.toContain(`ghostly_${entry.id}`);
  spy.mockRestore();
});
