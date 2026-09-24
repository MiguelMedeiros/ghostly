import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import { UsdtWallet } from "../src/engine/paymentAdapters/usdtWallet";
import { GhostlyNode } from "../src/engine/node";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { TEST_MINT, isWorthlessMint } from "../src/shared/mints";
import { ModeChanged, ModeGate } from "../src/engine/paymentAdapters/modeGate";
import { ArkadeAdapter } from "../src/engine/paymentAdapters/arkade";
import { UsdtAdapter } from "../src/engine/paymentAdapters/usdt";
import { newDeviceKey, sealSeed } from "../src/engine/paymentAdapters/persistence";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
// covers: wallet.mode, wallet.cashu.test-sats, wallet.usdt.create, wallet.ark.recover

const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
const read = async (key: string) => wrap((await store(STORES.settings, "readonly")).get(key));

it("tells which mints are worth nothing: the public test mints and mints on this machine", () => {
  expect(isWorthlessMint(TEST_MINT)).toBe(true);
  expect(isWorthlessMint(`${TEST_MINT}/`)).toBe(true);
  for (const url of ["http://127.0.0.1:3338", "http://localhost:3338", "http://[::1]:3338"]) expect(isWorthlessMint(url), url).toBe(true);
  for (const url of ["https://mint.minibits.cash/Bitcoin", "https://21mint.me", "https://localhost.example.com", "not a url"]) expect(isWorthlessMint(url), url).toBe(false);
});

it("switching modes parks each wallet and brings it back, never replacing or retiring it", async () => {
  await openDb();
  const mainnetArk = { config: { network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api", serverKey: "k", walletId: "w-main" }, seed: { v: 1 }, deviceKey: "d" };
  const mainnetUsdt = { config: { network: "ethereum", chainId: 1, provider: "https://ethereum.publicnode.com", token: "0x", decimals: 6 }, seed: { v: 1 }, deviceKey: "d" };
  await transact([STORES.settings], (s) => { s[STORES.settings].put(mainnetArk, "arkWallet"); s[STORES.settings].put(mainnetUsdt, "usdtWallet"); });
  const ark = new ArkWallet(vi.fn()), usdt = new UsdtWallet(vi.fn());
  await ark.start(); await usdt.start();

  await ark.setMode("mainnet"); await usdt.setMode("mainnet");
  expect(await settingsKeys()).toEqual(["arkWallet", "usdtWallet"]);

  // Testnet: the Mainnet wallets are parked, and there is no Testnet wallet yet (ensureReady would make one).
  await ark.setMode("testnet"); await usdt.setMode("testnet");
  expect(await settingsKeys()).toEqual(["arkWallet-mode-mainnet", "usdtWallet-mode-mainnet"]);
  expect(ark.view).toMatchObject({ configured: false });
  expect(await read("arkWallet-mode-mainnet")).toEqual(mainnetArk);

  // A Testnet wallet appears (as `create` would store it), then Mainnet comes back exactly as it was.
  const testnetArk = { ...mainnetArk, config: { ...mainnetArk.config, network: "mutinynet", walletId: "w-test" } };
  await transact([STORES.settings], (s) => s[STORES.settings].put(testnetArk, "arkWallet"));
  const again = new ArkWallet(vi.fn());
  await again.start();
  await again.setMode("mainnet");
  expect(await read("arkWallet")).toEqual(mainnetArk);
  expect(await read("arkWallet-mode-testnet")).toEqual(testnetArk);
  await again.setMode("testnet");
  expect(await read("arkWallet")).toEqual(testnetArk);
  expect(await read("arkWallet-mode-mainnet")).toEqual(mainnetArk);
  expect((await settingsKeys()).filter((k) => k.includes("retired")), "nothing retired along the way").toEqual([]);

  // Making a wallet of the other mode's network is refused: the switch is how to get there.
  await expect(again.create({ network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api" })).rejects.toThrow("Switch the wallets to Mainnet");
});

it("the Testnet mode shows only test mints, brings the public test mint, and switches back without losing a mint", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  node["settings"].mints = ["https://mint.minibits.cash/Bitcoin", "https://21mint.me"];
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  await node.walletSetMode({ mode: "testnet" });
  expect(node["settings"].walletMode).toBe("testnet");
  expect(node["settings"].mints).toEqual(["https://mint.minibits.cash/Bitcoin", "https://21mint.me", TEST_MINT]);
  expect(node["modeMints"]()).toEqual([TEST_MINT]);
  expect(node["walletView"]).toMatchObject({ mode: "testnet" });
  await node.walletSetMode({ mode: "mainnet" });
  expect(node["modeMints"]()).toEqual(["https://mint.minibits.cash/Bitcoin", "https://21mint.me"]);
  await expect(node.walletSetMode({ mode: "regtest" as never })).rejects.toThrow("Unknown wallet mode");
});

it("the switch answers at once, even while a wallet is busy on a slow network", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  vi.spyOn(node["arkWallet"], "setMode").mockImplementation(() => new Promise(() => {}));
  const answered = await Promise.race([node.walletSetMode({ mode: "testnet" }).then(() => "answered"), new Promise((r) => setTimeout(() => r("stuck"), 300))]);
  expect(answered).toBe("answered");
  expect(node["settings"].walletMode).toBe("testnet");
  expect(node["modeMints"]()).toEqual([TEST_MINT]);
});

it("a mode switch ends the wait for a wallet of the other mode, and what arrives late is closed", async () => {
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
  // After the switch, new waits are for the new mode and go through.
  await expect(gate.within(Promise.resolve(7))).resolves.toBe(7);
  await expect(gate.within(Promise.reject(new Error("offline")))).rejects.toThrow("offline");
});

for (const kind of ["ark", "usdt"] as const) {
  it(`${kind}: switching modes does not wait for a Mainnet wallet still connecting to a slow network`, async () => {
    await openDb();
    await transact([STORES.settings], (s) => { for (const key of ["arkWallet", "usdtWallet", "arkWallet-mode-mainnet", "usdtWallet-mode-mainnet", "arkWallet-mode-testnet", "usdtWallet-mode-testnet"]) s[STORES.settings].delete(key); });
    const deviceKey = newDeviceKey();
    const seed = await sealSeed(generateMnemonic(wordlist), deviceKey);
    const stored = kind === "ark"
      ? { config: { network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api", serverKey: "k", walletId: "w-slow" }, seed, deviceKey }
      : { config: { network: "ethereum", chainId: 1, provider: "https://ethereum.publicnode.com", token: "0x", decimals: 6 }, seed, deviceKey };
    await transact([STORES.settings], (s) => s[STORES.settings].put(stored, `${kind}Wallet`));
    const slow = deferred<{ dispose: () => Promise<void> }>();
    const connect = vi.spyOn(kind === "ark" ? ArkadeAdapter : UsdtAdapter, "connect").mockImplementation(() => slow.promise as never);
    const wallet = kind === "ark" ? new ArkWallet(vi.fn()) : new UsdtWallet(vi.fn());
    try {
      await wallet.start();
      await wallet.setMode("mainnet");
      const ready = wallet.ensureReady();
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

      const switched = await Promise.race([wallet.setMode("testnet").then(() => "switched"), new Promise((r) => setTimeout(() => r("stuck"), 500))]);
      expect(switched).toBe("switched");
      expect((await settingsKeys()).filter((k) => k.includes("Wallet"))).toEqual([`${kind}Wallet-mode-mainnet`]);
      expect(await read(`${kind}Wallet-mode-mainnet`), "parked as it was").toEqual(stored);
      await ready;
      expect(wallet.view.error, "a switch is not a connection error").toBeUndefined();

      const dispose = vi.fn(async () => {});
      slow.resolve({ dispose });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      expect(wallet.adapter).toBeUndefined();
    } finally {
      connect.mockRestore();
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
    const wallet = new ArkWallet(vi.fn());
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
