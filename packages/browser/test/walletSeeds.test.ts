import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { PaymentReview } from "@ghostly/core";
import { ArkWallet, DEFAULT_ARK } from "../src/engine/paymentAdapters/arkWallet";
import { UsdtWallet, DEFAULT_USDT } from "../src/engine/paymentAdapters/usdtWallet";
import { BarkWallet, TESTNET_BARK } from "../src/engine/paymentAdapters/barkWallet";
import { ArkadeAdapter } from "../src/engine/paymentAdapters/arkade";
import { UsdtAdapter } from "../src/engine/paymentAdapters/usdt";
import { encodeBackup } from "../src/engine/paymentAdapters/backup";
import { intentRepository, sealSeed } from "../src/engine/paymentAdapters/persistence";
import type { SavedIntent } from "../src/engine/paymentAdapters/coordinator";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { FakeBarkServer } from "./helpers/fakeBark";
import { phraseLeaks, TEST_PHRASE } from "./helpers/phraseLeaks";
// covers: wallet.ready, wallet.mode, wallet.usdt.create, wallet.usdt.backup, wallet.ark.create, wallet.ark.backup, wallet.bark.backup

/**
 * The seed handling of the Ark, USDT and Bark wallets: locked wallets, wrong passwords, restores, and the
 * rule that a phrase never reaches a view or a log. Ark and USDT providers are faked (no network); Bark
 * runs on the in-memory SDK of helpers/fakeBark.ts.
 */
const fx = vi.hoisted(() => ({
  funds: new Map<string, number>(),
  /** Reads the fake Ark adapter fails, as an explorer that is down would. */
  arkFails: new Set<string>(),
  usdtBalancesFail: false,
  codeHash: "0xfixture",
  info: { network: "bitcoin", signerPubkey: `02${"ab".repeat(32)}` },
  adapters: [] as { mnemonic: string; dispose: ReturnType<typeof import("vitest").vi.fn> }[],
}));
// The wallets draw their own phrase; a test that looks for it in a file has them draw TEST_PHRASE.
vi.mock("@scure/bip39", async (original) => { const bip39 = await original<typeof import("@scure/bip39")>(); return { ...bip39, generateMnemonic: vi.fn(bip39.generateMnemonic) }; });
vi.mock("@arkade-os/sdk", async (original) => ({ ...(await original<object>()), RestArkProvider: class { getInfo = async () => fx.info; } }));
vi.mock("../src/engine/paymentAdapters/arkade", () => ({
  ARK_NETWORKS: ["bitcoin", "mutinynet", "signet", "regtest"],
  ArkadeAdapter: {
    connect: vi.fn(async (config: object, mnemonic: string) => {
      const read = <T>(what: string, value: T) => async () => { if (fx.arkFails.has(what)) throw new Error(`${what} unavailable`); return value; };
      const adapter = { config, mnemonic, address: read("address", `ark1${mnemonic.split(" ")[0]}`), boardingAddress: read("boarding address", "bc1qboarding"), balance: async () => { if (fx.arkFails.has("balance")) throw new Error("balance unavailable"); return fx.funds.get(mnemonic) ?? 0; }, incoming: read("incoming", 0), recoverable: read("recoverable", 0), requestAddress: async () => "ark1request", recover: async () => "f".repeat(64), dispose: vi.fn() };
      fx.adapters.push(adapter);
      return adapter;
    }),
  },
}));
vi.mock("../src/engine/paymentAdapters/backup", async (original) => ({ ...(await original<object>()), snapshotArkDatabase: async () => ({ version: 3, stores: [] }), restoreArkDatabase: async () => {} }));
vi.mock("../src/engine/paymentAdapters/usdt", () => ({
  UsdtAdapter: {
    inspect: vi.fn(async (config: object) => ({ ...config, decimals: 6, codeHash: fx.codeHash })),
    connect: vi.fn(async (config: object, mnemonic: string) => {
      const adapter = { config, mnemonic, address: async () => "0x00000000000000000000000000000000000000aa", balances: async () => { if (fx.usdtBalancesFail) throw new Error("rpc down"); return { balance: "0", gasBalance: String(fx.funds.get(mnemonic) ?? 0) }; }, target: vi.fn(async () => ({ method: "usdt" })), mintTestTokens: vi.fn(async () => "0xhash"), dispose: vi.fn() };
      fx.adapters.push(adapter);
      return adapter;
    }),
  },
}));

const connected = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
const PASSWORD = "an older wallet password";
const CHOSEN = "a chosen backup password";

/** Everything written to the console, as text. */
const logged: string[] = [];
const leaks = (phrase: string, ...views: unknown[]) => [...logged, ...views.map((v) => JSON.stringify(v))].filter((text) => text.includes(phrase));

beforeEach(async () => {
  fx.funds.clear(); fx.arkFails.clear(); fx.usdtBalancesFail = false; fx.codeHash = "0xfixture"; fx.info = { network: "bitcoin", signerPubkey: `02${"ab".repeat(32)}` }; fx.adapters.length = 0;
  vi.clearAllMocks();
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  // PBKDF2 with fewer rounds: sealing is exercised for real, at a fraction of the cost.
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});
afterEach(() => { vi.restoreAllMocks(); });

/** A backup file as `exportBackup` writes it, around whatever payload a test needs. */
const backupFile = async (format: string, payload: string, password = CHOSEN) => JSON.stringify({ format, version: 1, vault: await sealSeed(payload, password) });
const deferred = () => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; };

describe("the USDT wallet's seed", () => {
  const CONFIG = { network: "ethereum", chainId: 1, provider: DEFAULT_USDT.provider, token: DEFAULT_USDT.token, decimals: 6, codeHash: "0xfixture" };
  const intent = (over: Partial<PaymentReview> = {}): SavedIntent => ({ review: { id: crypto.randomUUID(), payee: "bob", method: "usdt", network: "ethereum", chainId: 1, token: DEFAULT_USDT.token.toLowerCase(), provider: DEFAULT_USDT.provider, asset: "USDT", unit: "token-base", address: "0xbob", expiresAt: 0, createdAt: 0, amount: 1, fee: 0, feeCap: 0, state: "settled", ...over } as PaymentReview, prepared: {} });

  it("a wallet sealed with a password waits for it, refuses a wrong one, and its phrase shows nowhere", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start();
    await wallet.create({ ...DEFAULT_USDT, password: PASSWORD });
    const mnemonic = connected(UsdtAdapter.connect);
    await wallet.stop();

    const reopened = new UsdtWallet(() => {}); await reopened.start(); await reopened.ensureReady();
    expect(reopened.view).toMatchObject({ configured: true, locked: true, automatic: false });
    expect(() => reopened.require()).toThrow("Unlock your USDT wallet or wait for it to connect");
    await expect(reopened.unlock()).rejects.toThrow("Enter the USDT wallet password");
    await expect(reopened.unlock("not the password")).rejects.toThrow("Could not unlock the wallet");
    await expect(reopened.reveal("not the password")).rejects.toThrow("Could not unlock the wallet");
    await expect(reopened.exportBackup("not the password")).rejects.toThrow("Could not unlock the wallet");
    expect(reopened.view.locked).toBe(true);
    await reopened.unlock(PASSWORD);
    await reopened.unlock(PASSWORD);
    expect(UsdtAdapter.connect, "opening an open wallet does nothing").toHaveBeenCalledTimes(2);
    expect(await reopened.reveal(PASSWORD)).toBe(mnemonic);
    expect(await reopened.getTestTokens()).toBe("0xhash");
    expect(leaks(mnemonic, reopened.view, await settingsKeys(), await wrap((await store(STORES.settings, "readonly")).getAll()))).toEqual([]);
    await reopened.stop();
  });

  it("with no wallet there is nothing to open, reveal or back up", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start();
    await expect(wallet.unlock("whatever password")).rejects.toThrow("Create a USDT wallet first");
    await expect(wallet.reveal()).rejects.toThrow("No USDT wallet");
    await expect(wallet.exportBackup(CHOSEN)).rejects.toThrow("No USDT wallet to back up");
    expect(() => wallet.target()).toThrow("Unlock your USDT wallet");
  });

  it("a phrase that is not BIP39, or a network of the other mode, makes no wallet", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start();
    await expect(wallet.create({ ...DEFAULT_USDT, mnemonic: "one two three" })).rejects.toThrow("Invalid recovery phrase");
    await expect(wallet.create({ network: "sepolia", provider: "https://rpc.example", token: "0x" })).rejects.toThrow("Switch the wallets to Testnet to use a test network");
    expect(await settingsKeys()).toEqual([]);
  });

  it("an unreachable RPC is said, and a balance that cannot be read is marked stale", async () => {
    vi.mocked(UsdtAdapter.connect).mockRejectedValueOnce(new Error("offline"));
    const wallet = new UsdtWallet(() => {}); await wallet.start(); await wallet.ensureReady();
    expect(wallet.view).toMatchObject({ configured: false, error: "Connecting to Ethereum… offline" });
    await wallet.ensureReady();
    expect(wallet.view.locked).toBe(false);
    fx.usdtBalancesFail = true;
    await wallet.refresh();
    expect(wallet.view.error).toBe("RPC unavailable. Balance may be stale.");
    await wallet.stop();
  });

  it("a lock while the wallet opens wins: what arrives late is closed, not used", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start(); await wallet.ensureReady();
    await wallet.lock();
    const gate = deferred();
    const connect = vi.mocked(UsdtAdapter.connect).getMockImplementation()!;
    vi.mocked(UsdtAdapter.connect).mockImplementationOnce(async (...args) => { await gate.wait; return connect(...args); });
    const unlocking = wallet.unlock();
    await vi.waitFor(() => expect(UsdtAdapter.connect).toHaveBeenCalledTimes(2));
    await wallet.lock();
    gate.release();
    await unlocking;
    expect(wallet.adapter).toBeUndefined();
    expect(wallet.view.locked).toBe(true);
    expect(fx.adapters.at(-1)!.dispose).toHaveBeenCalled();
    await wallet.stop();
  });

  it("a lock while a wallet is being made keeps the new wallet, closed", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start();
    const gate = deferred();
    const connect = vi.mocked(UsdtAdapter.connect).getMockImplementation()!;
    vi.mocked(UsdtAdapter.connect).mockImplementationOnce(async (...args) => { await gate.wait; return connect(...args); });
    const creating = wallet.create({ ...DEFAULT_USDT });
    await vi.waitFor(() => expect(UsdtAdapter.connect).toHaveBeenCalledOnce());
    await wallet.lock();
    gate.release();
    await creating;
    expect(await settingsKeys()).toEqual(["usdtWallet"]);
    expect(wallet.view).toMatchObject({ configured: true, locked: true, automatic: true });
    expect(fx.adapters.at(-1)!.dispose).toHaveBeenCalled();
  });

  it("a replacement that fails to connect leaves the old wallet in place, and it opens again", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start(); await wallet.ensureReady();
    const first = connected(UsdtAdapter.connect);
    vi.mocked(UsdtAdapter.connect).mockRejectedValueOnce(new Error("rpc refused"));
    await expect(wallet.create({ ...DEFAULT_USDT })).rejects.toThrow("rpc refused");
    await vi.waitFor(() => expect(wallet.view.locked).toBe(false));
    expect(connected(UsdtAdapter.connect)).toBe(first);
    expect(await settingsKeys()).toEqual(["usdtWallet"]);
    await wallet.stop();
  });

  it("a backup restores only a matching, valid wallet of this mode, and unfinished payments come back unknown", async () => {
    const mnemonic = generateMnemonic(wordlist);
    const payload = (over: object = {}) => JSON.stringify({ format: "ghostly-usdt", version: 1, config: CONFIG, mnemonic, intents: [], ...over });
    const wallet = new UsdtWallet(() => {}); await wallet.start();
    await expect(wallet.restoreBackup("x".repeat(16 * 1024 * 1024 + 1), CHOSEN)).rejects.toThrow("Backup is too large");
    await expect(wallet.restoreBackup(JSON.stringify({ format: "ghostly-ark-encrypted", version: 1 }), CHOSEN)).rejects.toThrow("Unsupported USDT backup");
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload()), "not the password")).rejects.toThrow("Could not unlock");
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload({ mnemonic: "one two three" })), CHOSEN)).rejects.toThrow("Invalid USDT backup");
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload({ intents: "none" })), CHOSEN)).rejects.toThrow("Invalid USDT backup");
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload({ config: { ...CONFIG, network: "sepolia", chainId: 11155111 } })), CHOSEN)).rejects.toThrow("This backup is a Testnet wallet: switch the wallets to it first");
    fx.codeHash = "0xother";
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload()), CHOSEN), "the token contract changed").rejects.toThrow("Backup token or network mismatch");
    fx.codeHash = "0xfixture";
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload({ intents: [intent({ chainId: 11155111 })] })), CHOSEN)).rejects.toThrow("Backup token or network mismatch");
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload({ intents: [intent({ method: "arkade" })] })), CHOSEN)).rejects.toThrow("Backup token or network mismatch");
    expect(await settingsKeys()).toEqual([]);

    const unfinished = intent({ state: "pending" }), done = intent({ state: "settled" });
    await wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload({ intents: [unfinished, done] })), CHOSEN);
    expect(wallet.view).toMatchObject({ configured: true, locked: true, automatic: true, network: "ethereum" });
    expect(Object.fromEntries((await intentRepository.list()).map((i) => [i.review.id, i.review.state]))).toEqual({ [unfinished.review.id]: "unknown", [done.review.id]: "settled" });
    await wallet.ensureReady();
    expect(connected(UsdtAdapter.connect)).toBe(mnemonic);
    expect(leaks(mnemonic, wallet.view)).toEqual([]);

    // Now it has payments: another restore must not replace it.
    await expect(wallet.restoreBackup(await backupFile("ghostly-usdt-encrypted", payload()), CHOSEN)).rejects.toThrow("Restore into a fresh profile or an unused wallet");
    await wallet.stop();
  });

  it("two first starts at once make one wallet, not two", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start();
    await Promise.all([wallet.ensureReady(), wallet.ensureReady(), wallet.ensureReady()]);
    expect(UsdtAdapter.connect).toHaveBeenCalledOnce();
    expect(await settingsKeys()).toEqual(["usdtWallet"]);
    await wallet.stop();
  });

  it("its backup file is sealed with the chosen password, carries its payments, and restores the same phrase", async () => {
    vi.mocked(generateMnemonic).mockReturnValueOnce(TEST_PHRASE);
    const wallet = new UsdtWallet(() => {}); await wallet.start(); await wallet.ensureReady();
    const mnemonic = connected(UsdtAdapter.connect);
    expect(mnemonic).toBe(TEST_PHRASE);
    const paid = intent();
    await intentRepository.put(paid);
    await intentRepository.put(intent({ method: "arkade", network: "bitcoin" }));
    await expect(wallet.exportBackup("short")).rejects.toThrow("Use at least 12 characters for the backup password");
    const file = await wallet.exportBackup(CHOSEN);
    expect(phraseLeaks(file)).toEqual([]);
    expect(JSON.parse(file)).toMatchObject({ format: "ghostly-usdt-encrypted", version: 1 });
    await wallet.stop();

    await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
    const restored = new UsdtWallet(() => {}); await restored.start();
    await restored.restoreBackup(file, CHOSEN);
    expect((await intentRepository.list()).map((i) => i.review.id), "only its own payments").toEqual([paid.review.id]);
    await restored.ensureReady();
    expect(connected(UsdtAdapter.connect)).toBe(mnemonic);
    expect(leaks(mnemonic, restored.view)).toEqual([]);
    await restored.stop();
  });

  it("a restore over an unused wallet archives it, and the archived seed is still there", async () => {
    const wallet = new UsdtWallet(() => {}); await wallet.start(); await wallet.ensureReady();
    const file = await backupFile("ghostly-usdt-encrypted", JSON.stringify({ format: "ghostly-usdt", version: 1, config: CONFIG, mnemonic: generateMnemonic(wordlist), intents: [] }));
    await wallet.restoreBackup(file, CHOSEN);
    const keys = await settingsKeys();
    expect(keys).toContain("usdtWallet");
    expect(keys.filter((k) => k.startsWith("usdtWallet-retired-"))).toHaveLength(1);
  });
});

describe("the Ark wallet's seed", () => {
  const CONFIG = { network: "bitcoin", provider: DEFAULT_ARK.provider, explorer: DEFAULT_ARK.explorer, serverKey: fx.info.signerPubkey, walletId: "w-old" };
  const intent = (over: Partial<PaymentReview> = {}): SavedIntent => ({ review: { id: crypto.randomUUID(), payee: "bob", method: "arkade", network: "bitcoin", provider: DEFAULT_ARK.provider, asset: "BTC", unit: "sat", address: "ark1bob", expiresAt: 0, createdAt: 0, amount: 1, fee: 0, feeCap: 0, state: "settled", ...over } as PaymentReview, prepared: {} });

  it("a wallet sealed with a password waits for it and refuses a wrong one", async () => {
    const wallet = new ArkWallet(() => {}); await wallet.start();
    await expect(wallet.unlock()).rejects.toThrow("Create or restore an Ark wallet first");
    await expect(wallet.backup()).rejects.toThrow("No Ark wallet to back up");
    await wallet.create({ ...DEFAULT_ARK, password: PASSWORD });
    const mnemonic = connected(ArkadeAdapter.connect);
    await wallet.stop();

    const reopened = new ArkWallet(() => {}); await reopened.start(); await reopened.ensureReady();
    expect(reopened.view).toMatchObject({ locked: true, automatic: false });
    expect(() => reopened.require()).toThrow("Unlock your Ark wallet or wait for it to connect");
    await expect(reopened.unlock()).rejects.toThrow("Enter the Ark wallet password");
    await expect(reopened.unlock("not the password")).rejects.toThrow("Could not unlock the wallet");
    await expect(reopened.backup("not the password")).rejects.toThrow("Could not unlock the wallet");
    await reopened.unlock(PASSWORD);
    await reopened.unlock(PASSWORD);
    expect(ArkadeAdapter.connect).toHaveBeenCalledTimes(2);
    expect((await reopened.backup(PASSWORD)).mnemonic).toBe(mnemonic);
    expect(leaks(mnemonic, reopened.view)).toEqual([]);
    await reopened.stop();
  });

  it("refuses an unknown network, and a provider that runs on another one, without saving anything", async () => {
    const wallet = new ArkWallet(() => {}); await wallet.start();
    await expect(wallet.create({ ...DEFAULT_ARK, network: "litecoin" as never })).rejects.toThrow("Unsupported Ark network");
    fx.info = { ...fx.info, network: "mutinynet" };
    await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow("That Ark provider runs on mutinynet, not bitcoin");
    await expect(wallet.create({ ...DEFAULT_ARK, mnemonic: "one two three" })).rejects.toThrow("Invalid recovery phrase");
    expect(await settingsKeys()).toEqual([]);
    expect(ArkadeAdapter.connect).not.toHaveBeenCalled();
  });

  it("shows what it could read and says what it could not, logging no phrase", async () => {
    const wallet = new ArkWallet(() => {}); await wallet.start(); await wallet.ensureReady();
    const mnemonic = connected(ArkadeAdapter.connect);
    fx.arkFails.add("balance").add("incoming");
    await wallet.refresh();
    expect(wallet.view).toMatchObject({ locked: false, address: `ark1${mnemonic.split(" ")[0]}`, error: "Could not read the balance, incoming from the Ark provider. Last values may be stale." });
    expect(logged.some((line) => line.startsWith("Ark balance:"))).toBe(true);
    expect(leaks(mnemonic, wallet.view)).toEqual([]);
    await expect(wallet.target()).resolves.toMatchObject({ method: "arkade", network: "bitcoin", provider: DEFAULT_ARK.provider, asset: "BTC", unit: "sat", address: "ark1request" });
    await expect(wallet.recover()).resolves.toBe("f".repeat(64));
    await wallet.stop();
  });

  it("a replacement that fails to connect leaves the old wallet in place, and it opens again", async () => {
    const wallet = new ArkWallet(() => {}); await wallet.start(); await wallet.ensureReady();
    const first = connected(ArkadeAdapter.connect);
    vi.mocked(ArkadeAdapter.connect).mockRejectedValueOnce(new Error("provider refused"));
    await expect(wallet.create({ ...DEFAULT_ARK })).rejects.toThrow("provider refused");
    await vi.waitFor(() => expect(wallet.view.locked).toBe(false));
    expect(connected(ArkadeAdapter.connect)).toBe(first);
    await wallet.stop();
  });

  it("a profile whose only wallet is parked for this mode takes it back", async () => {
    const parked = { config: CONFIG, seed: await sealSeed(generateMnemonic(wordlist), "device key 0123456789"), deviceKey: "device key 0123456789" };
    await transact([STORES.settings], (s) => s[STORES.settings].put(parked, "arkWallet-mode-mainnet"));
    const wallet = new ArkWallet(() => {}); await wallet.start();
    await wallet.setMode("mainnet");
    expect(await settingsKeys()).toEqual(["arkWallet"]);
    expect(wallet.view).toMatchObject({ configured: true, locked: true, automatic: true, network: "bitcoin" });
  });

  it("a backup restores only a valid wallet of this mode whose payments match it", async () => {
    const mnemonic = generateMnemonic(wordlist);
    const payload = (over: object = {}) => encodeBackup({ format: "ghostly-ark", version: 1, sdk: "0.4.74", createdAt: 0, mnemonic, config: CONFIG, database: { version: 3, stores: [] }, intents: [], ...over });
    const wallet = new ArkWallet(() => {}); await wallet.start();
    await expect(wallet.restoreBackup("x".repeat(16 * 1024 * 1024 + 1), CHOSEN)).rejects.toThrow("Ark backup is too large");
    await expect(wallet.restoreBackup(JSON.stringify({ format: "ghostly-ark-encrypted", version: 2 }), CHOSEN)).rejects.toThrow("Unsupported Ark backup");
    await expect(wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload()), "not the password")).rejects.toThrow("Could not unlock");
    await expect(wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload({ sdk: "0.5.0" })), CHOSEN), "another SDK's database").rejects.toThrow("Invalid Ark backup payload");
    await expect(wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload({ mnemonic: "one two" })), CHOSEN)).rejects.toThrow("Invalid Ark backup payload");
    await expect(wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload({ config: { ...CONFIG, network: "litecoin" } })), CHOSEN)).rejects.toThrow("Unsupported Ark network in backup");
    await expect(wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload({ config: { ...CONFIG, network: "mutinynet" } })), CHOSEN)).rejects.toThrow("This backup is a Testnet wallet: switch the wallets to it first");
    await expect(wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload({ intents: [intent({ provider: "https://other.example" })] })), CHOSEN)).rejects.toThrow("Backup intents do not match its wallet");
    expect(await settingsKeys()).toEqual([]);

    await wallet.ensureReady();
    const unfinished = intent({ state: "submitted" }), failed = intent({ state: "failed" });
    await wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload({ intents: [unfinished, failed] })), CHOSEN);
    expect((await settingsKeys()).filter((k) => k.startsWith("arkWallet-retired-")), "the unused wallet is archived").toHaveLength(1);
    expect(Object.fromEntries((await intentRepository.list()).map((i) => [i.review.id, i.review.state]))).toEqual({ [unfinished.review.id]: "unknown", [failed.review.id]: "failed" });
    expect(wallet.view).toMatchObject({ configured: true, locked: true, automatic: true });
    await expect(wallet.restoreBackup(await backupFile("ghostly-ark-encrypted", payload()), CHOSEN)).rejects.toThrow("Restore into a fresh profile or an unused wallet");
    await wallet.stop();
  });
});

describe("the Bark wallet's seed", () => {
  let server: FakeBarkServer;
  beforeEach(() => { server = new FakeBarkServer(); });
  const make = () => new BarkWallet(vi.fn(), async () => server.sdk());
  const CONFIG = { network: "signet", provider: TESTNET_BARK.provider, explorer: TESTNET_BARK.explorer, serverKey: `02${"ab".repeat(32)}`, walletId: "w-old" };

  it("boards on-chain coins and shows no phrase in its view or logs, even when a read fails", async () => {
    const wallet = make(); await wallet.start(); await wallet.setMode("testnet"); await wallet.ensureReady();
    const { mnemonic, config } = await wallet.backup();
    const handle = server.wallets.get(`ghostly-bark-${config.walletId}`)!;
    handle.onchain = 5_000;
    await expect(wallet.board()).resolves.toBe("b".repeat(64));
    expect(wallet.view.balance).toBe(5_000);
    handle.sync = async () => { throw new Error("server hiccup"); };
    await wallet.refresh();
    expect(wallet.view.error).toBe("Could not read the sync from the Bark server. Last values may be stale.");
    expect(logged.some((line) => line.includes("server hiccup"))).toBe(true);
    expect(leaks(mnemonic, wallet.view)).toEqual([]);
    await wallet.stop();
  });

  it("a backup restores only a valid wallet whose payments match it, and archives the unused wallet it replaces", async () => {
    const mnemonic = generateMnemonic(wordlist);
    const payload = (over: object = {}) => JSON.stringify({ format: "ghostly-bark", version: 1, mnemonic, config: CONFIG, intents: [], ...over });
    const wallet = make(); await wallet.start(); await wallet.setMode("testnet");
    await expect(wallet.restoreBackup("x".repeat(16 * 1024 * 1024 + 1), CHOSEN)).rejects.toThrow("Bark backup is too large");
    await expect(wallet.restoreBackup(JSON.stringify({ format: "ghostly-usdt-encrypted", version: 1 }), CHOSEN)).rejects.toThrow("Unsupported Bark backup");
    await expect(wallet.restoreBackup(await backupFile("ghostly-bark-encrypted", payload({ version: 2 })), CHOSEN)).rejects.toThrow("Invalid Bark backup");
    await expect(wallet.restoreBackup(await backupFile("ghostly-bark-encrypted", payload({ config: { ...CONFIG, network: "liquid" } })), CHOSEN)).rejects.toThrow("Unsupported Bark network in backup");
    const theirs = { review: { id: "x", payee: "bob", method: "bark", network: "signet", provider: "https://other.example", asset: "BTC", unit: "sat", address: "tark1p", expiresAt: 0, createdAt: 0, amount: 1, fee: 0, feeCap: 0, state: "settled" } as PaymentReview, prepared: {} };
    await expect(wallet.restoreBackup(await backupFile("ghostly-bark-encrypted", payload({ intents: [theirs] })), CHOSEN)).rejects.toThrow("Backup payments do not match its wallet");
    expect(await settingsKeys()).toEqual([]);

    await wallet.ensureReady();
    await wallet.restoreBackup(await backupFile("ghostly-bark-encrypted", payload()), CHOSEN);
    expect((await settingsKeys()).filter((k) => k.startsWith("barkWallet-retired-"))).toHaveLength(1);
    expect(wallet.view).toMatchObject({ configured: true, locked: true, network: "signet" });
    const restored = await wallet.backup();
    expect(restored.mnemonic).toBe(mnemonic);
    expect(restored.config.walletId, "a fresh local database").not.toBe("w-old");
    expect(leaks(mnemonic, wallet.view)).toEqual([]);
  });
});
