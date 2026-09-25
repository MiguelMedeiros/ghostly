import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { migrateWalletNetworks, walletKey } from "../src/engine/paymentAdapters/walletNetworks";
// covers: wallet.instances.migration

/**
 * Records shaped the way each wallet stores itself (a sealed seed, its config), with the rest of a profile's
 * settings beside them: a copy of what a real profile holds, minus real secrets.
 */
const seed = (tag: string) => ({ v: 1, salt: `salt-${tag}`, iv: `iv-${tag}`, data: `sealed-${tag}` });
const ark = (network: string, tag: string) => ({ config: { network, provider: network === "bitcoin" ? "https://arkade.computer" : "https://mutinynet.arkade.sh", explorer: "https://mempool.space/api", serverKey: `key-${tag}`, walletId: `ark-${tag}` }, seed: seed(`ark-${tag}`), deviceKey: `device-${tag}` });
const usdt = (network: string, tag: string) => ({ config: { network, chainId: network === "ethereum" ? 1 : 11155111, provider: "https://rpc.example", token: "0x0000000000000000000000000000000000000001", decimals: 6, codeHash: "0xabc" }, seed: seed(`usdt-${tag}`), deviceKey: `device-${tag}` });
const bark = (network: string, tag: string) => ({ config: { network, provider: "https://ark.signet.2nd.dev", explorer: "https://esplora.signet.2nd.dev", serverKey: `key-${tag}`, walletId: `bark-${tag}` }, seed: seed(`bark-${tag}`), deviceKey: `device-${tag}` });
const spark = (network: string, tag: string) => ({ network, seed: seed(`spark-${tag}`), deviceKey: `device-${tag}`, createdAt: 1 });
/** Kept as they are: other wallets' records, and a retired wallet from an earlier replace. */
const untouched = {
  "fedimintWallet-testnet": { mnemonic: seed("fedimint"), deviceKey: "device-f", federations: [{ id: "f", invite: "fed11abc" }] },
  "lightningSource-testnet": { providerId: "nwc", config: {}, secrets: seed("nwc"), deviceKey: "device-n", savedAt: 1 },
  "onchainSource-testnet": { providerId: "bdk", config: { network: "signet" }, secrets: seed("bdk"), deviceKey: "device-b", savedAt: 1 },
  "arkWallet-retired-1700000000000": ark("mutinynet", "old"),
  "lightningOp-in-abc": { direction: "in", providerId: "cashu-mint", mode: "testnet", paymentHash: "abc", state: "paid" },
};

const all = async () => {
  const settings = await store(STORES.settings, "readonly");
  const [keys, values] = await Promise.all([wrap(settings.getAllKeys()), wrap(settings.getAll())]);
  return Object.fromEntries(keys.map((key, i) => [String(key), values[i]]));
};
const put = (records: Record<string, unknown>) => transact([STORES.settings], (s) => { for (const [key, value] of Object.entries(records)) s[STORES.settings].put(value, key); });
/** Every record of the profile, as values: a migration may move them, never lose or change one. */
const contents = (records: Record<string, unknown>) => Object.values(records).map((value) => JSON.stringify(value)).sort();

beforeEach(async () => {
  await openDb();
  await transact([STORES.settings], (s) => s[STORES.settings].clear());
});

it("a profile left in Mainnet: the open wallets and the parked Testnet ones each land under their network's key", async () => {
  const before = {
    arkWallet: ark("bitcoin", "main"), "arkWallet-mode-testnet": ark("mutinynet", "test"),
    usdtWallet: usdt("ethereum", "main"), "usdtWallet-mode-testnet": usdt("sepolia", "test"),
    "barkWallet-mode-testnet": bark("signet", "test"),
    "sparkWallet-mode-testnet": spark("regtest", "test"),
    ...untouched,
  };
  await put(before);

  const report = await migrateWalletNetworks();

  const after = await all();
  expect(after).toEqual({
    ...untouched,
    [walletKey("arkWallet", "mainnet")]: before.arkWallet, [walletKey("arkWallet", "testnet")]: before["arkWallet-mode-testnet"],
    [walletKey("usdtWallet", "mainnet")]: before.usdtWallet, [walletKey("usdtWallet", "testnet")]: before["usdtWallet-mode-testnet"],
    "barkWallet-mode-testnet": before["barkWallet-mode-testnet"], "sparkWallet-mode-testnet": before["sparkWallet-mode-testnet"],
  });
  expect(contents(after)).toEqual(contents(before));
  expect(report.moved.map(({ rail, network }) => `${rail}:${network}`).sort()).toEqual(["arkWallet:mainnet", "usdtWallet:mainnet"]);
});

it("a profile left in Testnet: its open test wallets move, the parked Mainnet ones stay where they are", async () => {
  const before = {
    arkWallet: ark("mutinynet", "test"), "arkWallet-mode-mainnet": ark("bitcoin", "main"),
    usdtWallet: usdt("sepolia", "test"), "usdtWallet-mode-mainnet": usdt("ethereum", "main"),
    barkWallet: bark("signet", "test"),
    sparkWallet: spark("regtest", "test"),
    ...untouched,
  };
  await put(before);

  const report = await migrateWalletNetworks();

  const after = await all();
  expect(after).toEqual({
    ...untouched,
    "arkWallet-mode-testnet": before.arkWallet, "arkWallet-mode-mainnet": before["arkWallet-mode-mainnet"],
    "usdtWallet-mode-testnet": before.usdtWallet, "usdtWallet-mode-mainnet": before["usdtWallet-mode-mainnet"],
    "barkWallet-mode-testnet": before.barkWallet, "sparkWallet-mode-testnet": before.sparkWallet,
  });
  expect(contents(after)).toEqual(contents(before));
  expect(report.moved).toHaveLength(4);
  expect(report.moved.every((m) => m.network === "testnet" && !m.retired)).toBe(true);
});

it("runs once: a second start finds nothing to move and changes nothing", async () => {
  await put({ arkWallet: ark("bitcoin", "main"), sparkWallet: spark("bitcoin", "main"), ...untouched });
  await migrateWalletNetworks();
  const once = await all();
  const again = await migrateWalletNetworks();
  expect(again).toEqual({ moved: [], unreadable: [] });
  expect(await all()).toEqual(once);
  expect(once["sparkWallet-mode-mainnet"]).toEqual(spark("bitcoin", "main"));
});

it("never overwrites: a wallet already under the network's key is kept as a retired wallet", async () => {
  const open = ark("mutinynet", "open"), parked = ark("regtest", "parked");
  await put({ arkWallet: open, "arkWallet-mode-testnet": parked });
  const report = await migrateWalletNetworks(1234);
  const after = await all();
  expect(after["arkWallet-mode-testnet"]).toEqual(open);
  expect(after["arkWallet-retired-1234-testnet"]).toEqual(parked);
  expect(Object.keys(after)).toHaveLength(2);
  expect(report.moved).toEqual([{ rail: "arkWallet", network: "testnet", key: "arkWallet-mode-testnet", retired: "arkWallet-retired-1234-testnet" }]);
});

it("leaves a record it cannot read where it is, and says so", async () => {
  await put({ usdtWallet: { seed: seed("odd") }, arkWallet: ark("bitcoin", "main") });
  const report = await migrateWalletNetworks();
  const after = await all();
  expect(after.usdtWallet).toEqual({ seed: seed("odd") });
  expect(after["arkWallet-mode-mainnet"]).toEqual(ark("bitcoin", "main"));
  expect(report.unreadable).toEqual(["usdtWallet"]);
});

it("reports keys only, never a seed", async () => {
  await put({ arkWallet: ark("bitcoin", "main"), usdtWallet: usdt("sepolia", "test"), "usdtWallet-mode-testnet": usdt("sepolia", "older") });
  const report = await migrateWalletNetworks();
  expect(JSON.stringify(report)).not.toMatch(/sealed-|device-|salt-/);
});
