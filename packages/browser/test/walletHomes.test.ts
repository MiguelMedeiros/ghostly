import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { clearWalletHomes, homeOf, homeRow, readWalletHomes, writeWalletHomes } from "../src/devices/walletHomes";
import { dropBreezDatabases } from "../src/devices/handoffStandby";
import { awayFrom, refuseAway, setAwayWallets, setSingleWriterGate, WalletAwayError } from "../src/engine/paymentAdapters/away";
import type { PlannedWallet } from "../src/devices/handoffWallets";
// covers: devices.handoff.wallets

/*
 * Where a wallet lives (WISP 06 § Wallets that stay home): the home mark on the wallet's own record, written at
 * quiesce and read at every start; a wallet away from this device is never opened here; and the Breez databases of
 * the wallets that moved are deleted by name, nothing else.
 */

const connect = vi.fn(async (config: { provider: string }) => ({ config, address: async () => "ark1fixture", balance: async () => 0, boardingAddress: async () => "tb1qfixture", incoming: async () => 0, expired: async () => ({ recoverable: 0, sweeping: 0, small: 0 }), expiresAt: async () => undefined, dispose: vi.fn() }));
vi.mock("@arkade-os/sdk", async (original) => ({ ...await original<object>(), RestArkProvider: class { getInfo = async () => ({ network: "mutinynet", signerPubkey: `02${"ab".repeat(32)}` }); } }));
vi.mock("../src/engine/paymentAdapters/arkade", () => ({ ARK_NETWORKS: ["bitcoin", "mutinynet", "signet", "regtest"], ArkadeAdapter: { connect } }));
const { ArkWallet } = await import("../src/engine/paymentAdapters/arkWallet");

const DESKTOP = "D".repeat(43);
const put = (key: string, value: unknown) => transact([STORES.settings], (s) => { s[STORES.settings].put(value, key); });
const get = async (key: string) => wrap<unknown>((await store(STORES.settings, "readonly")).get(key));
const planned = (id: string, route: PlannedWallet["route"], home?: PlannedWallet["home"]): PlannedWallet => {
  const [type, network, card] = id.split(":");
  return { id, type: type as PlannedWallet["type"], network: network as PlannedWallet["network"], ...(card ? { card } : {}), route, ...(home ? { home } : {}) };
};

beforeEach(async () => {
  await transact([STORES.settings], (s) => { s[STORES.settings].clear(); });
  setAwayWallets(new Map());
  connect.mockClear();
});

describe("the home mark", () => {
  it("is written on each wallet's own record, read back by wallet id, and taken off a wallet that moves", async () => {
    await put("barkWallet-mode-testnet", { config: { walletId: "b1" }, seed: {}, deviceKey: "k" });
    await put("fedimintWallet-mainnet", { federations: [{ id: "f", database: "ghostly-fedimint-1.db" }] });
    await put("onchainSource-mainnet", { providerId: "bitcoind", config: {}, savedAt: 1 });
    await put("lightningCards-testnet", { cards: [{ id: "lnd", providerId: "lnd", name: "LND" }, { id: "nwc", providerId: "nwc", name: "NWC" }], receive: "nwc" });
    await put("sparkWallet-mode-testnet", { network: "regtest", seed: {}, deviceKey: "k", home: { key: DESKTOP } });
    await writeWalletHomes([
      planned("bark:testnet", "home", { key: DESKTOP, expiresAt: 1_800_000_000_000 }), planned("fedimint:mainnet", "home", { key: DESKTOP }),
      planned("bitcoin:mainnet", "home", { key: DESKTOP }), planned("lightning:testnet:lnd", "home", { key: DESKTOP }),
      planned("lightning:testnet:nwc", "moves"), planned("spark:testnet", "moves"),
      // A record that is not there is not made.
      planned("usdt:mainnet", "home", { key: DESKTOP }),
    ]);
    expect(await readWalletHomes()).toEqual({
      "bark:testnet": { key: DESKTOP, expiresAt: 1_800_000_000_000 }, "fedimint:mainnet": { key: DESKTOP }, "bitcoin:mainnet": { key: DESKTOP }, "lightning:testnet:lnd": { key: DESKTOP },
    });
    // The rest of each record is as it was: the wallet's database keeps its name.
    expect(await get("barkWallet-mode-testnet")).toEqual({ config: { walletId: "b1" }, seed: {}, deviceKey: "k", home: { key: DESKTOP, expiresAt: 1_800_000_000_000 } });
    expect(await get("sparkWallet-mode-testnet")).toEqual({ network: "regtest", seed: {}, deviceKey: "k" });
    expect(await get("usdtWallet-mode-mainnet")).toBeUndefined();
    expect(((await get("lightningCards-testnet")) as { cards: unknown[] }).cards).toEqual([{ id: "lnd", providerId: "lnd", name: "LND", home: { key: DESKTOP } }, { id: "nwc", providerId: "nwc", name: "NWC" }]);
  });

  it("a removed home device takes its marks with it: the wallets at home there are here again, the others' marks stay (WISP 06 § Removing a device)", async () => {
    const LAPTOP = "L".repeat(43);
    await put("barkWallet-mode-testnet", { config: { walletId: "b1" }, seed: {}, deviceKey: "k", home: { key: DESKTOP, expiresAt: 1_800_000_000_000 } });
    await put("fedimintWallet-mainnet", { federations: [], home: { key: LAPTOP } });
    await put("lightningCards-testnet", { cards: [{ id: "lnd", providerId: "lnd", name: "LND", home: { key: DESKTOP } }, { id: "nwc", providerId: "nwc", name: "NWC" }], receive: "nwc" });
    expect(await clearWalletHomes(DESKTOP)).toBe(true);
    expect(await readWalletHomes()).toEqual({ "fedimint:mainnet": { key: LAPTOP } });
    // The rest of each record is as it was.
    expect(await get("barkWallet-mode-testnet")).toEqual({ config: { walletId: "b1" }, seed: {}, deviceKey: "k" });
    expect(((await get("lightningCards-testnet")) as { cards: unknown[] }).cards).toEqual([{ id: "lnd", providerId: "lnd", name: "LND" }, { id: "nwc", providerId: "nwc", name: "NWC" }]);
    // Nothing more to take off: nothing written.
    expect(await clearWalletHomes(DESKTOP)).toBe(false);
    // Every device the set no longer lists at once (a removal cut short before it cleared its marks).
    expect(await clearWalletHomes((key) => key !== DESKTOP)).toBe(true);
    expect(await readWalletHomes()).toEqual({});
  });

  it("knows where each wallet's record is, and that Cashu has none", () => {
    expect(homeRow("arkade:mainnet")).toEqual({ key: "arkWallet-mode-mainnet" });
    expect(homeRow("lightning:testnet:c1")).toEqual({ key: "lightningCards-testnet", card: "c1" });
    expect(homeRow("cashu:testnet")).toBeNull();
    expect(homeRow("bark:signet")).toBeNull();
  });

  it("a mark that is not one (a key of another shape, an expiry that is no time) is no mark", () => {
    expect(homeOf({ home: { key: "short" } })).toBeUndefined();
    expect(homeOf({ home: { key: DESKTOP, expiresAt: -1 } })).toBeUndefined();
    expect(homeOf({ home: { key: DESKTOP, expiresAt: 5 } })).toEqual({ key: DESKTOP, expiresAt: 5 });
  });
});

describe("a wallet away from this device", () => {
  it("is never opened here, and says where it can be used", async () => {
    await put("arkWallet-mode-testnet", { config: { network: "mutinynet", provider: "https://ark.test", explorer: "https://esplora.test", serverKey: `02${"ab".repeat(32)}`, walletId: "a1" }, seed: { iv: "x", data: "y" }, deviceKey: "k" });
    setAwayWallets(new Map([["arkade:testnet", "Desktop"]]));
    const ark = new ArkWallet("testnet", () => {});
    await ark.start();
    await ark.ensureReady();
    expect(connect).not.toHaveBeenCalled();
    expect(ark.view).toMatchObject({ configured: true, locked: true });
    expect(awayFrom("arkade:testnet")).toBe("Desktop");
    expect(() => refuseAway("arkade:testnet", "Ark")).toThrow(new WalletAwayError("Ark", "Desktop"));
    expect(() => refuseAway("arkade:testnet", "Ark")).toThrow("Ark can't be used here. Use it on Desktop.");
    setAwayWallets(new Map([["arkade:testnet", ""]]));
    expect(() => refuseAway("arkade:testnet", "Ark")).toThrow("Ark can't be used here: its home is another device.");
    expect(() => refuseAway("arkade:mainnet", "Ark")).not.toThrow();
  });
});

describe("a single-writer wallet without a fresh turn read", () => {
  it("does not open, its retry included, until the engine says this device is the active one", async () => {
    await put("arkWallet-mode-testnet", { config: { network: "mutinynet", provider: "https://ark.test", explorer: "https://esplora.test", serverKey: `02${"ab".repeat(32)}`, walletId: "a1" }, seed: { iv: "x", data: "y" }, deviceKey: "k" });
    setSingleWriterGate(async () => false);
    try {
      const ark = new ArkWallet("testnet", () => {});
      await ark.start();
      await ark.ensureReady();
      expect(connect).not.toHaveBeenCalled();
      expect(ark.view.error).toContain("Checking which device is active");
      await ark.stop();
    } finally { setSingleWriterGate(null); }
  });
});

describe("the Breez databases of wallets that moved", () => {
  const open = (name: string) => new Promise<void>((resolve, reject) => { const r = indexedDB.open(name, 1); r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
  const names = async () => (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => !!n && n.startsWith("ghostly-breez-")).sort();

  it("go by the name the phrase gives them, with the tree store beside it; nothing else does", async () => {
    for (const name of ["ghostly-breez-regtest-0123456789abcdef", "ghostly-breez-regtest-0123456789abcdef-tree", "ghostly-breez-regtest-fedcba9876543210", "ghostly-breez-regtest-fedcba9876543210-tree"]) await open(name);
    await dropBreezDatabases(["ghostly-breez-regtest-0123456789abcdef", "not-a-breez-database"]);
    expect(await names()).toEqual(["ghostly-breez-regtest-fedcba9876543210", "ghostly-breez-regtest-fedcba9876543210-tree"]);
  });
});
