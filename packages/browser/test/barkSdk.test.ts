import { beforeEach, expect, it, vi } from "vitest";
// covers: wallet.bark.create

/** The WebAssembly SDK, reduced to the calls barkSdk.ts makes. */
const bark = vi.hoisted(() => ({
  init: vi.fn(async (_options: { module_or_path: string }) => {}),
  onchain: { free: vi.fn() },
  openOnchain: vi.fn(),
  openWallet: vi.fn(),
  validate: vi.fn((address: string) => { if (address === "garbage") throw new Error("parse error"); return address.startsWith("tark1"); }),
}));
vi.mock("@secondts/bark/web", () => ({
  default: bark.init,
  OnchainWallet: { default: bark.openOnchain },
  Wallet: { openWithOnchain: bark.openWallet },
  validateArkAddress: bark.validate,
}));
vi.mock("@secondts/bark/web/bark_ffi_wasm_bg.wasm?url", () => ({ default: "/assets/bark.wasm" }));

const load = async () => (await import("../src/engine/paymentAdapters/barkSdk")).loadBarkSdk();
const params = { network: "signet" as const, mnemonic: "m", server: "https://ark.example", esplora: "https://esplora.example", database: "ghostly-bark-w1" };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  bark.openOnchain.mockResolvedValue(bark.onchain);
  bark.openWallet.mockResolvedValue({ wallet: true });
});

it("fetches the WebAssembly once, however many wallets open", async () => {
  const [a, b] = await Promise.all([load(), load()]);
  expect(a).toBe(b);
  expect(bark.init).toHaveBeenCalledExactlyOnceWith({ module_or_path: "/assets/bark.wasm" });
});

it("a failed load is tried again on the next use", async () => {
  bark.init.mockRejectedValueOnce(new Error("offline"));
  const { loadBarkSdk } = await import("../src/engine/paymentAdapters/barkSdk");
  await expect(loadBarkSdk()).rejects.toThrow("offline");
  await expect(loadBarkSdk()).resolves.toBeDefined();
  expect(bark.init).toHaveBeenCalledTimes(2);
});

it("opens the on-chain part next to the Ark wallet, on the named network, with the daemon running", async () => {
  const sdk = await load();
  expect(await sdk.open(params)).toEqual({ wallet: { wallet: true }, onchain: bark.onchain });
  const config = { serverAddress: params.server, esploraAddress: params.esplora };
  expect(bark.openOnchain).toHaveBeenCalledWith({ network: "Signet", mnemonic: "m", config, dbName: "ghostly-bark-w1-onchain" });
  expect(bark.openWallet).toHaveBeenCalledWith("Signet", "m", config, bark.onchain, { runDaemon: true, indexedDbName: "ghostly-bark-w1", createIfNotExists: true });
});

it("on Bitcoin, renews coins inside Second's free refresh window (under 288 blocks), wider than Bark's default day", async () => {
  const sdk = await load();
  await sdk.open({ ...params, network: "bitcoin" });
  const config = { serverAddress: params.server, esploraAddress: params.esplora, vtxoRefreshExpiryThreshold: 264 };
  expect(bark.openOnchain).toHaveBeenCalledWith({ network: "Bitcoin", mnemonic: "m", config, dbName: "ghostly-bark-w1-onchain" });
  expect(bark.openWallet).toHaveBeenCalledWith("Bitcoin", "m", config, bark.onchain, { runDaemon: true, indexedDbName: "ghostly-bark-w1", createIfNotExists: true });
  expect(config.vtxoRefreshExpiryThreshold).toBeLessThan(288);
});

it("frees the on-chain wallet when the Ark wallet fails to open", async () => {
  bark.openWallet.mockRejectedValueOnce(new Error("server unreachable"));
  const sdk = await load();
  await expect(sdk.open({ ...params, network: "regtest" })).rejects.toThrow("server unreachable");
  expect(bark.onchain.free).toHaveBeenCalledOnce();
});

it("an address the SDK cannot parse is not a Bark address", async () => {
  const sdk = await load();
  expect([sdk.isArkAddress("tark1abc"), sdk.isArkAddress("ark1other"), sdk.isArkAddress("garbage")]).toEqual([true, false, false]);
});
