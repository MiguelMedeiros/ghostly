import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import { UsdtWallet } from "../src/engine/paymentAdapters/usdtWallet";
import { GhostlyNode } from "../src/engine/node";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { TEST_MINT, isWorthlessMint } from "../src/shared/mints";
import { ModeChanged, ModeGate, WrongNetworkError } from "../src/engine/paymentAdapters/modeGate";
import { ArkadeAdapter } from "../src/engine/paymentAdapters/arkade";
import { UsdtAdapter } from "../src/engine/paymentAdapters/usdt";
import { newDeviceKey, sealSeed } from "../src/engine/paymentAdapters/persistence";
import { migrateWalletNetworks } from "../src/engine/paymentAdapters/walletNetworks";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
// covers: wallet.mode, wallet.cashu.test-sats, wallet.usdt.create, wallet.ark.recover, wallet.instances.migration

const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
const read = async (key: string) => wrap((await store(STORES.settings, "readonly")).get(key));
const clearSettings = () => transact([STORES.settings], (s) => s[STORES.settings].clear());
const arkRecord = (network: string, walletId: string) => ({ config: { network, provider: network === "bitcoin" ? "https://arkade.computer" : "https://mutinynet.arkade.sh", explorer: "https://mempool.space/api", serverKey: "k", walletId }, seed: { v: 1 }, deviceKey: "d" });
const usdtRecord = (network: string) => ({ config: { network, chainId: network === "ethereum" ? 1 : 11155111, provider: "https://rpc.example", token: "0x", decimals: 6 }, seed: { v: 1 }, deviceKey: "d" });

beforeEach(async () => { await openDb(); await clearSettings(); });

it("tells which mints are worth nothing: the public test mints and mints on this machine", () => {
  expect(isWorthlessMint(TEST_MINT)).toBe(true);
  expect(isWorthlessMint(`${TEST_MINT}/`)).toBe(true);
  for (const url of ["http://127.0.0.1:3338", "http://localhost:3338", "http://[::1]:3338"]) expect(isWorthlessMint(url), url).toBe(true);
  for (const url of ["https://mint.minibits.cash/Bitcoin", "https://21mint.me", "https://localhost.example.com", "not a url"]) expect(isWorthlessMint(url), url).toBe(false);
});

it("each network's wallet lives under its own key, and neither ever touches the other's", async () => {
  const mainnetArk = arkRecord("bitcoin", "w-main"), testnetArk = arkRecord("mutinynet", "w-test");
  await transact([STORES.settings], (s) => { s[STORES.settings].put(mainnetArk, "arkWallet-mode-mainnet"); s[STORES.settings].put(testnetArk, "arkWallet-mode-testnet"); s[STORES.settings].put(usdtRecord("ethereum"), "usdtWallet-mode-mainnet"); });
  const arks = { mainnet: new ArkWallet("mainnet", vi.fn()), testnet: new ArkWallet("testnet", vi.fn()) };
  const usdts = { mainnet: new UsdtWallet("mainnet", vi.fn()), testnet: new UsdtWallet("testnet", vi.fn()) };
  for (const wallet of [...Object.values(arks), ...Object.values(usdts)]) await wallet.start();

  expect(arks.mainnet.view).toMatchObject({ configured: true, network: "bitcoin" });
  expect(arks.testnet.view).toMatchObject({ configured: true, network: "mutinynet" });
  expect(usdts.mainnet.view).toMatchObject({ configured: true, network: "ethereum" });
  expect(usdts.testnet.view, "a network with no wallet has none: nothing is made by itself").toMatchObject({ configured: false });
  await usdts.testnet.ensureReady();
  expect(usdts.testnet.configured).toBe(false);

  // Making a wallet of the other network's chain is refused before anything is asked or saved, saying where it belongs.
  const refused = await arks.testnet.create({ network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api" }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(WrongNetworkError);
  expect(refused).toMatchObject({ network: "mainnet", message: expect.stringContaining("this is the Testnet Ark wallet") });
  await expect(usdts.mainnet.create({ network: "sepolia", provider: "https://rpc.example", token: "0x" })).rejects.toBeInstanceOf(WrongNetworkError);
  expect(await settingsKeys()).toEqual(["arkWallet-mode-mainnet", "arkWallet-mode-testnet", "usdtWallet-mode-mainnet"]);
  expect(await read("arkWallet-mode-mainnet")).toEqual(mainnetArk);
  expect(await read("arkWallet-mode-testnet")).toEqual(testnetArk);
});

it("after the migration, a profile left in either mode opens every wallet it had, each on its network", async () => {
  for (const mode of ["mainnet", "testnet"] as const) {
    await clearSettings();
    const open = mode === "mainnet" ? arkRecord("bitcoin", "w-open") : arkRecord("mutinynet", "w-open");
    const parked = mode === "mainnet" ? arkRecord("mutinynet", "w-parked") : arkRecord("bitcoin", "w-parked");
    const other = mode === "mainnet" ? "testnet" : "mainnet";
    await transact([STORES.settings], (s) => { s[STORES.settings].put(open, "arkWallet"); s[STORES.settings].put(parked, `arkWallet-mode-${other}`); });
    await migrateWalletNetworks();
    const wallets = { mainnet: new ArkWallet("mainnet", vi.fn()), testnet: new ArkWallet("testnet", vi.fn()) };
    for (const wallet of Object.values(wallets)) await wallet.start();
    expect(wallets[mode].view, `${mode}: the wallet that was open`).toMatchObject({ configured: true, provider: open.config.provider });
    expect(wallets[other].view, `${mode}: the wallet that was parked`).toMatchObject({ configured: true, provider: parked.config.provider });
    expect(await read(`arkWallet-mode-${mode}`)).toEqual(open);
    expect(await read(`arkWallet-mode-${other}`)).toEqual(parked);
  }
});

it("a call naming no network acts on Mainnet; nothing is made, added, parked or closed for it", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: true });
  node["settings"].mints = ["https://mint.minibits.cash/Bitcoin", "https://21mint.me", TEST_MINT];
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  const lock = vi.spyOn(node["arkWallets"].mainnet, "lock");
  const made = vi.spyOn(node["arkWallets"].testnet, "createDefaultNow");
  expect(node["net"]()).toBe("mainnet");
  expect(node["net"]("testnet")).toBe("testnet");
  expect(node["networkMints"]()).toEqual(["https://mint.minibits.cash/Bitcoin", "https://21mint.me"]);
  expect(node["networkMints"]("testnet"), "Testnet's mints are still Testnet's").toEqual([TEST_MINT]);
  await node["refreshWallet"]();
  expect(node["walletView"]).not.toHaveProperty("mode");
  expect(node["walletView"]).not.toHaveProperty("waitingTestSats");
  expect(lock, "no wallet is closed").not.toHaveBeenCalled();
  expect(made, "no wallet is made").not.toHaveBeenCalled();
  expect((node as unknown as Record<string, unknown>).walletSetMode, "the old switch is gone").toBeUndefined();
});

it("a gate's switch ends the wait for a wallet of the other mode, and what arrives late is closed", async () => {
  const gate = new ModeGate();
  const late = deferred<{ dispose: () => void }>();
  const waiting = gate.within(late.promise, (a) => a.dispose());
  gate.switching("mainnet"); // Already the mode: nothing ends.
  const ok = deferred<string>();
  const same = gate.within(ok.promise);
  ok.resolve("same mode");
  await expect(same).resolves.toBe("same mode");
  gate.switching("testnet");
  await expect(waiting).rejects.toBeInstanceOf(ModeChanged);
  const dispose = vi.fn();
  late.resolve({ dispose });
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  await expect(gate.within(Promise.resolve(7))).resolves.toBe(7);
  await expect(gate.within(Promise.reject(new Error("offline")))).rejects.toThrow("offline");
});

it("cutting a gate short ends the waits under way and every one until it resumes; closing it ends every later one", async () => {
  const gate = new ModeGate();
  const late = deferred<{ dispose: () => void }>();
  const waiting = gate.within(late.promise, (a) => a.dispose());
  gate.interrupt();
  await expect(waiting).rejects.toBeInstanceOf(ModeChanged);
  const dispose = vi.fn();
  late.resolve({ dispose });
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  // A creation still sealing its seed when it was cut short does not wait on its server afterwards either.
  await expect(gate.within(Promise.resolve("still cut"))).rejects.toBeInstanceOf(ModeChanged);
  gate.resume();
  await expect(gate.within(Promise.resolve("after"))).resolves.toBe("after");
  gate.close();
  await expect(gate.within(Promise.resolve("closed"))).rejects.toBeInstanceOf(ModeChanged);
});

for (const kind of ["ark", "usdt"] as const) {
  it(`${kind}: a Mainnet wallet stuck connecting to a slow network never holds up the Testnet one, and stopping ends its wait`, async () => {
    const deviceKey = newDeviceKey();
    const seed = await sealSeed(generateMnemonic(wordlist), deviceKey);
    const mainnet = kind === "ark" ? { ...arkRecord("bitcoin", "w-slow"), seed, deviceKey } : { ...usdtRecord("ethereum"), seed, deviceKey };
    const testnet = kind === "ark" ? { ...arkRecord("mutinynet", "w-quick"), seed, deviceKey } : { ...usdtRecord("sepolia"), seed, deviceKey };
    await transact([STORES.settings], (s) => { s[STORES.settings].put(mainnet, `${kind}Wallet-mode-mainnet`); s[STORES.settings].put(testnet, `${kind}Wallet-mode-testnet`); });
    const slow = deferred<{ dispose: () => Promise<void> }>();
    const quick = kind === "ark"
      ? { config: testnet.config, address: async () => "tark1me", boardingAddress: async () => "tb1pme", balance: async () => 0, incoming: async () => 0, recoverable: async () => 0, dispose: async () => {} }
      : { config: testnet.config, address: async () => "0xme", balances: async () => ({ balance: "0", gasBalance: "0" }), dispose: async () => {} };
    const connect = vi.spyOn(kind === "ark" ? ArkadeAdapter : UsdtAdapter, "connect")
      .mockImplementation(((config: { network: string }) => config.network === (kind === "ark" ? "bitcoin" : "ethereum") ? slow.promise : Promise.resolve(quick)) as never);
    const wallets = kind === "ark" ? [new ArkWallet("mainnet", vi.fn()), new ArkWallet("testnet", vi.fn())] : [new UsdtWallet("mainnet", vi.fn()), new UsdtWallet("testnet", vi.fn())];
    try {
      for (const wallet of wallets) await wallet.start();
      const stuck = wallets[0].ensureReady();
      await wallets[1].ensureReady();
      expect(wallets[1].adapter, "the Testnet wallet opened").toBe(quick);
      expect(wallets[0].adapter).toBeUndefined();

      await wallets[0].stop();
      await stuck;
      expect(wallets[0].view.error, "stopping is not a connection error").toBeUndefined();
      const dispose = vi.fn(async () => {});
      slow.resolve({ dispose });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      expect(wallets[0].adapter).toBeUndefined();
      expect(await read(`${kind}Wallet-mode-mainnet`), "kept as it was").toEqual(mainnet);
    } finally {
      connect.mockRestore();
      await wallets[1].stop();
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

it("ark: coins of an expired batch show as recoverable, and Recover brings them back into the balance", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const state = { balance: 100, recoverable: 300 };
    const recover = vi.fn(async () => { state.balance += state.recoverable - 4; state.recoverable = 0; return "txid"; });
    const adapter = {
      config: { network: "regtest", provider: "http://127.0.0.1:43010" },
      address: async () => "tark1me", boardingAddress: async () => "bcrt1me", incoming: async () => 0,
      balance: async () => state.balance, recoverable: async () => state.recoverable, recover, dispose: async () => {},
    };
    const wallet = new ArkWallet("testnet", vi.fn());
    wallet.adapter = adapter as never;
    await wallet.refresh();
    expect(wallet.view).toMatchObject({ balance: 100, recoverable: 300 });
    await expect(wallet.recover()).resolves.toBe("txid");
    expect(recover).toHaveBeenCalledOnce();
    expect(wallet.view, "the batch costs a few sats").toMatchObject({ balance: 396, recoverable: 0 });
    // A provider that cannot tell keeps the last value, and says the numbers may be stale.
    adapter.recoverable = async () => { throw new Error("offline"); };
    await wallet.refresh();
    expect(wallet.view).toMatchObject({ recoverable: 0 });
    expect(wallet.view.error).toContain("recoverable");
    await wallet.lock();
  } finally {
    vi.useRealTimers();
  }
});
