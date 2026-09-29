import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentPreflightError, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { BarkAdapter, barkTiming, type BarkConfig } from "../src/engine/paymentAdapters/bark";
import { BarkWallet, MAINNET_BARK, SECOND_TERMS, TESTNET_BARK, readableBarkError } from "../src/engine/paymentAdapters/barkWallet";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { WrongNetworkError } from "../src/engine/paymentAdapters/modeGate";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { FakeBarkServer } from "./helpers/fakeBark";
import { phraseLeaks, TEST_PHRASE } from "./helpers/phraseLeaks";
// covers: wallet.bark.mainnet, wallet.bark.create, wallet.bark.send, wallet.bark.backup, payments.chat.reconcile

// The wallet draws its own phrase; a test that looks for it in storage has it draw TEST_PHRASE.
vi.mock("@scure/bip39", async (original) => { const bip39 = await original<typeof import("@scure/bip39")>(); return { ...bip39, generateMnemonic: vi.fn(bip39.generateMnemonic) }; });

const provider = "https://ark.signet.2nd.dev", explorer = "https://esplora.signet.2nd.dev";
let server: FakeBarkServer;
const config = (walletId = crypto.randomUUID()): BarkConfig => ({ network: "signet", provider, explorer, serverKey: server.key, walletId });
const connect = (c = config()) => BarkAdapter.connect(c, generateMnemonic(wordlist), { sdk: server.sdk() });
const target = (address: string, over: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "bark", network: "signet", provider, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000, ...over });
const review = (t: PaymentTarget, amount: number, fee: number, feeCap = 100): PaymentReview => ({ ...t, id: crypto.randomUUID(), payee: "bob", amount, fee, feeCap, createdAt: Date.now(), state: "submitted" });
const walletOf = (c: BarkConfig) => server.wallets.get(`ghostly-bark-${c.walletId}`)!;
const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();

barkTiming.serverWaitMs = 1;
beforeEach(async () => {
  server = new FakeBarkServer();
  await openDb();
  await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});

describe("the Bark adapter", () => {
  it("pays a Bark address of the same server after review, and the payee's own history proves it", async () => {
    const aliceConfig = config(), alice = await connect(aliceConfig), bob = await connect();
    walletOf(aliceConfig).fund(10_000);
    const address = await bob.requestAddress();
    expect(address, "a request address is never the one on the wallet page").not.toBe(await bob.address());
    const t = target(address);
    const { fee, prepared } = await alice.prepare(t, 2_500, 100);
    expect(server.sent, "nothing leaves at review").toBe(0);
    const persist = vi.fn(async () => { expect(server.sent, "written down before anything leaves").toBe(0); });
    const result = await alice.execute(review(t, 2_500, fee), prepared, persist);
    expect(persist).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ settled: true });
    expect(result.txid).toMatch(/^[a-f0-9]{64}$/);
    expect((await bob.balance()).spendableSats).toBe(2_500);
    const since = Date.now() - 1_000;
    const receipt = await bob.received(address, 2_500, since);
    expect(receipt).toBeTruthy();
    expect(await bob.received(address, 2_501, since), "not less than asked").toBeUndefined();
    expect(await bob.received(await bob.requestAddress(), 2_500, since), "not on another address").toBeUndefined();
    expect(await bob.received(address, 2_500, since, new Set([receipt!])), "one receive pays one request").toBeUndefined();
  });

  it("refuses what Bark cannot pay: an Arkade address, another server's address, another network or provider", async () => {
    const aliceConfig = config(), alice = await connect(aliceConfig);
    walletOf(aliceConfig).fund(10_000);
    await expect(alice.prepare(target("tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94"), 100, 100)).rejects.toThrow("Bark cannot pay an Arkade address");
    await expect(alice.prepare(target("tark1potherserver0x1"), 100, 100)).rejects.toThrow("another Ark server");
    const bob = await connect();
    const address = await bob.requestAddress();
    await expect(alice.prepare(target(address, { provider: "https://other.example" }), 100, 100)).rejects.toThrow("does not match this wallet");
    await expect(alice.prepare(target(address, { network: "regtest" }), 100, 100)).rejects.toThrow("does not match this wallet");
    await expect(alice.prepare(target(address, { method: "arkade" }), 100, 100)).rejects.toThrow("does not match this wallet");
    expect(server.sent).toBe(0);
  });

  it("never pays across networks: a Mainnet wallet refuses a test address, a test wallet a Mainnet one", async () => {
    const main = new FakeBarkServer("03" + "cd".repeat(32), "bitcoin", "main");
    const mainConfig: BarkConfig = { network: "bitcoin", provider: MAINNET_BARK.provider, explorer: MAINNET_BARK.explorer, serverKey: main.key, walletId: crypto.randomUUID() };
    const real = await BarkAdapter.connect(mainConfig, generateMnemonic(wordlist), { sdk: main.sdk() });
    main.wallets.get(`ghostly-bark-${mainConfig.walletId}`)!.fund(10_000);
    const mainTarget = (address: string, over: Partial<PaymentTarget> = {}) => target(address, { network: "bitcoin", provider: MAINNET_BARK.provider, ...over });
    expect(await real.address()).toMatch(/^ark1p/);
    await expect(real.prepare(mainTarget("tark1pmainx1"), 100, 100)).rejects.toThrow("test network Bark address");
    await expect(real.prepare(mainTarget(await real.requestAddress(), { network: "signet" }), 100, 100)).rejects.toThrow("does not match this wallet");

    const testConfig = config(), test = await connect(testConfig);
    walletOf(testConfig).fund(10_000);
    await expect(test.prepare(target("ark1psrvx1"), 100, 100)).rejects.toThrow("Mainnet Bark address");
    await expect(test.prepare(target(await test.requestAddress(), { network: "bitcoin" }), 100, 100)).rejects.toThrow("does not match this wallet");
    expect(main.sent + server.sent).toBe(0);
    await real.dispose(); await test.dispose();
  });

  it("refuses a fee over the cap, more than the balance, and a fee that grew after the review", async () => {
    const aliceConfig = config(), alice = await connect(aliceConfig), bob = await connect();
    walletOf(aliceConfig).fund(1_000);
    const t = target(await bob.requestAddress());
    server.fee = 50;
    await expect(alice.prepare(t, 100, 20)).rejects.toThrow("fee exceeds your limit");
    await expect(alice.prepare(t, 990, 100)).rejects.toThrow("Insufficient Bark balance");
    const { fee, prepared } = await alice.prepare(t, 100, 100);
    server.fee = 80;
    await expect(alice.execute(review(t, 100, fee), prepared, async () => {})).rejects.toBeInstanceOf(PaymentPreflightError);
    await expect(alice.execute(review(t, 100, fee), prepared), "no durable journal, no send").rejects.toBeInstanceOf(PaymentPreflightError);
    expect(server.sent).toBe(0);
  });

  it("an error after the send started is settled from the history; an unknown outcome is never sent again", async () => {
    const aliceConfig = config(), alice = await connect(aliceConfig), bob = await connect();
    walletOf(aliceConfig).fund(10_000);
    const t = target(await bob.requestAddress());
    const first = await alice.prepare(t, 700, 100);
    server.nextSend = "throw-after";
    await expect(alice.execute(review(t, 700, first.fee), first.prepared, async () => {})).resolves.toMatchObject({ settled: true });
    expect(server.sent).toBe(1);

    const t2 = target(await bob.requestAddress());
    const second = await alice.prepare(t2, 300, 100);
    server.nextSend = "throw-before";
    await expect(alice.execute(review(t2, 300, second.fee), second.prepared, async () => {})).rejects.toThrow("outcome unknown");
    await expect(alice.reconcile(review(t2, 300, second.fee), second.prepared)).resolves.toEqual({ settled: false });
    await expect(alice.reconcile(review(t2, 300, second.fee), second.prepared)).resolves.toEqual({ settled: false });
    expect(server.sent, "reconciling only looks").toBe(1);
  });

  it("will not open against a server whose key or network changed", async () => {
    const c = config();
    await connect(c);
    server.key = "03" + "cd".repeat(32);
    await expect(connect(c)).rejects.toThrow("server network or key changed");
    expect(walletOf(c).freed, "the refused wallet is released").toBe(true);
    await expect(BarkAdapter.connect({ ...c, network: "bitcoin" }, generateMnemonic(wordlist), { sdk: server.sdk() })).rejects.toThrow();
  });

  it("a wallet closed while a sync is still running is freed once the sync ends, not under it", async () => {
    const c = config();
    const adapter = await connect(c);
    const wallet = walletOf(c);
    let finish!: () => void;
    wallet.sync = () => new Promise<void>((resolve) => { finish = resolve; });
    const syncing = adapter.sync();
    await adapter.dispose();
    // Freed now, the SDK would throw "attempted to take ownership of Rust value while it was borrowed".
    expect(wallet.freed).toBe(false);
    // Closed: a read that comes after it (a refresh already under way) is refused instead of reaching a freed wallet.
    await expect(adapter.balance()).rejects.toThrow("closed");
    finish();
    await syncing;
    expect(wallet.freed).toBe(true);
    await adapter.dispose();
  });

  it("waits for a wallet opened again to reach its server, and tells a silent server from a changed one", async () => {
    const c = config();
    await connect(c);
    await expect(connect(c), "reopened: arkInfo is empty until the server is reached").resolves.toBeInstanceOf(BarkAdapter);
    server.down = true;
    await expect(connect(c)).rejects.toThrow("not answering");
  });

  it("through the coordinator: approved once, and a lost answer is reconciled, not paid twice", async () => {
    const aliceConfig = config(), alice = await connect(aliceConfig), bob = await connect();
    walletOf(aliceConfig).fund(5_000);
    const coordinator = new PaymentCoordinator(intentRepository, [alice as never]);
    const t = target(await bob.requestAddress());
    const pending = await coordinator.prepare(t, 1_000, 100, { payee: "bob" });
    expect(pending).toMatchObject({ method: "bark", state: "pending", fee: 0 });
    server.nextSend = "throw-before";
    const unknown = await coordinator.approve(pending.id);
    expect(unknown.state).toBe("unknown");
    await expect(coordinator.approve(pending.id)).rejects.toThrow("cannot be submitted again");
    expect((await coordinator.reconcile(pending.id)).state).toBe("unknown");
    expect(server.sent).toBe(0);

    const next = await coordinator.prepare(target(await bob.requestAddress()), 1_000, 100, { payee: "bob" });
    expect((await coordinator.approve(next.id)).state).toBe("settled");
    expect((await bob.balance()).spendableSats).toBe(1_000);
  });
});

describe("the Bark wallet", () => {
  const make = (network: "mainnet" | "testnet" = "testnet") => new BarkWallet(network, vi.fn(), async () => server.sdk());

  const barkDatabases = async () => (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("ghostly-bark-")).sort();

  it("Mainnet makes a Bitcoin wallet on Second's server in one click: key pinned, terms and coin expiry shown", async () => {
    const main = new FakeBarkServer("03" + "cd".repeat(32), "bitcoin", "main");
    const wallet = new BarkWallet("mainnet", vi.fn(), async () => main.sdk());
    await wallet.start();
    await wallet.ensureReady();
    expect(wallet.configured, "opening makes nothing").toBe(false);
    await wallet.createDefaultNow();
    expect(wallet.view).toMatchObject({ configured: true, locked: false, network: "bitcoin", provider: MAINNET_BARK.provider, terms: SECOND_TERMS, balance: 0, expiry: { lifetime: 4032 } });
    expect(wallet.view.address).toMatch(/^ark1p/);
    expect(wallet.view.error).toBeUndefined();
    const saved = await wrap<{ config: BarkConfig }>((await store(STORES.settings, "readonly")).get("barkWallet-mode-mainnet"));
    expect(saved.config).toMatchObject({ network: "bitcoin", provider: MAINNET_BARK.provider, explorer: MAINNET_BARK.explorer, serverKey: main.key });
    expect(await wallet.target()).toMatchObject({ method: "bark", network: "bitcoin", provider: MAINNET_BARK.provider });
    await expect(wallet.createDefaultNow()).rejects.toThrow("already a Mainnet Bark wallet");

    // Coins: how long until the first one expires, read from the wallet and the chain tip.
    const coins = [...main.wallets.values()][0];
    coins.fund(20_000); coins.firstExpiry = main.tip + 300;
    await wallet.refresh();
    expect(wallet.view).toMatchObject({ balance: 20_000, expiry: { blocksLeft: 300, lifetime: 4032 } });
    await wallet.stop();
  });

  it("an SDK failure reads as its own words, without the WebAssembly's quoted values and stack", async () => {
    const raw = "Failed to create chain source: error sending request: JsValue(TypeError: Failed to fetch TypeError: Failed to fetch at __wbg_fetch_9dad (http://localhost/assets/bark_ffi_wasm.js:1:21609) at http://localhost/assets/bark_ffi_wasm_bg.wasm:wasm-function[3134]:0x339313)";
    expect((readableBarkError(new Error(raw)) as Error).message).toBe("Failed to create chain source: error sending request");
    expect((readableBarkError(raw) as Error).message).toBe("Failed to create chain source: error sending request");
    expect((readableBarkError(new Error("x".repeat(500))) as Error).message).toHaveLength(240);
    const wrong = new WrongNetworkError("mainnet", "Bitcoin is a Mainnet network");
    expect(readableBarkError(wrong), "short errors and their kind are kept").toBe(wrong);
    // Through a creation: the server's chain source refuses, and what the person reads is short.
    const main = new FakeBarkServer("03" + "cd".repeat(32), "bitcoin", "main");
    const sdk = main.sdk();
    const failing = new BarkWallet("mainnet", vi.fn(), async () => ({ ...sdk, open: async () => { throw new Error(raw); } }));
    await failing.start();
    await expect(failing.createDefaultNow()).rejects.toThrow(/^Failed to create chain source: error sending request$/);
  });

  it("networks never mix: Mainnet refuses a test server or backup, Testnet refuses Bitcoin, and nothing is half made", async () => {
    const before = await barkDatabases();
    // Something at the Mainnet address that answers as signet: refused before anything is saved.
    const impostor = new FakeBarkServer("03" + "ef".repeat(32), "signet", "fake");
    const mainnet = new BarkWallet("mainnet", vi.fn(), async () => impostor.sdk());
    await mainnet.start();
    await expect(mainnet.createDefaultNow()).rejects.toThrow("does not run on bitcoin");
    const signet = await mainnet.create({ ...TESTNET_BARK }).catch((e: unknown) => e);
    expect(signet).toBeInstanceOf(WrongNetworkError);
    expect(signet).toMatchObject({ network: "testnet", message: "signet is a Testnet network: this is the Mainnet Bark wallet" });

    const main = new FakeBarkServer("03" + "cd".repeat(32), "bitcoin", "main");
    const testnet = new BarkWallet("testnet", vi.fn(), async () => main.sdk());
    await testnet.start();
    const wrong = await testnet.create({ ...MAINNET_BARK }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(WrongNetworkError);
    expect(wrong).toMatchObject({ network: "mainnet", message: "Bitcoin is a Mainnet network: this is the Testnet Bark wallet" });
    await expect(testnet.createDefaultNow(), "a Bitcoin server at the signet address").rejects.toThrow("does not run on signet");

    // The Mainnet server down: nothing saved, no database left, and it can be tried again.
    main.down = true;
    const down = new BarkWallet("mainnet", vi.fn(), async () => main.sdk());
    await down.start();
    await expect(down.createDefaultNow()).rejects.toThrow("not answering");
    expect(await settingsKeys()).toEqual([]);
    expect(await barkDatabases(), "the drafts' databases are gone").toEqual(before);
    main.down = false;
    await down.createDefaultNow();
    expect(down.view).toMatchObject({ configured: true, network: "bitcoin" });
    await down.stop();
  });

  it("Testnet makes a signet wallet when asked, pins the server key, and each network's wallet is its own", async () => {
    const wallet = make();
    vi.mocked(generateMnemonic).mockReturnValueOnce(TEST_PHRASE);
    await wallet.start();
    await wallet.ensureReady();
    expect(wallet.configured, "opening makes nothing").toBe(false);
    expect(await settingsKeys()).toEqual([]);
    await wallet.ensureReady(true);
    expect(wallet.configured).toBe(true);
    expect((await wallet.backup()).mnemonic).toBe(TEST_PHRASE);
    expect(wallet.view).toMatchObject({ configured: true, locked: false, network: "signet", provider: TESTNET_BARK.provider, balance: 0 });
    expect(wallet.view.address).toMatch(/^tark1p/);
    const saved = await wrap<{ config: BarkConfig; seed: unknown; deviceKey: string }>((await store(STORES.settings, "readonly")).get("barkWallet-mode-testnet"));
    expect(saved.config).toMatchObject({ network: "signet", serverKey: server.key });
    expect(phraseLeaks(JSON.stringify(saved)), "the phrase is sealed, never stored as text").toEqual([]);

    // The Mainnet wallet, open beside it, has none and touches nothing of the Testnet one.
    const mainnet = make("mainnet");
    await mainnet.start(); await mainnet.ensureReady();
    expect(mainnet.view).toMatchObject({ configured: false });
    expect(await settingsKeys()).toEqual(["barkWallet-mode-testnet"]);
    expect(wallet.view).toMatchObject({ configured: true, locked: false, network: "signet" });
    const address = wallet.view.address;
    expect(address).toMatch(/^tark1p/);
    const target = await wallet.target();
    expect(target).toMatchObject({ method: "bark", network: "signet", provider: TESTNET_BARK.provider });
    expect(target.address).not.toBe(address);
    await wallet.stop(); await mainnet.stop();

    // Opened again (a restart), the Testnet wallet is the same one, under its own key.
    const again = make();
    await again.start(); await again.ensureReady();
    expect((await again.backup()).config).toEqual(saved.config);
    expect(again.view.address).toMatch(/^tark1p/);
    await again.stop();
  });

  it("a server that never answers leaves no wallet behind, however often it is retried", async () => {
    server.down = true;
    const before = (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("ghostly-bark-"));
    const wallet = make();
    await wallet.start();
    await wallet.ensureReady(true);
    expect(wallet.view.error).toContain("not answering");
    expect(await settingsKeys()).toEqual([]);
    const after = (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("ghostly-bark-"));
    expect(after, "the draft's databases are gone").toEqual(before);
    await wallet.stop();
  });

  it("a wallet holding money or payments is never replaced; an empty one is archived, not deleted", async () => {
    const wallet = make();
    await wallet.start(); await wallet.ensureReady(true);
    const first = (await wallet.backup()).config;
    walletOf(first).fund(10);
    await wallet.refresh();
    await expect(wallet.create({ ...TESTNET_BARK, network: "regtest", provider: "http://127.0.0.1:44135", explorer: "http://127.0.0.1:44102" })).rejects.toThrow("will not be replaced");
    walletOf(first).spendable = 0;
    server.network = "regtest";
    await wallet.create({ network: "regtest", provider: "http://127.0.0.1:44135", explorer: "http://127.0.0.1:44102" });
    expect(wallet.view).toMatchObject({ network: "regtest", locked: false });
    expect((await settingsKeys()).some((k) => k.startsWith("barkWallet-retired-"))).toBe(true);
    await wallet.stop();
  });

  it("an encrypted backup restores the phrase, the server and the payments into a fresh profile", async () => {
    const wallet = make();
    vi.mocked(generateMnemonic).mockReturnValueOnce(TEST_PHRASE);
    await wallet.start(); await wallet.ensureReady(true);
    const { mnemonic, config: original } = await wallet.backup();
    await intentRepository.put({ review: { ...review(target("tark1psrvx"), 5, 0), state: "submitted" }, prepared: { address: "tark1psrvx", amount: 5, fee: 0, after: 0 } });
    await expect(wallet.exportBackup("short")).rejects.toThrow("12 characters");
    const file = await wallet.exportBackup("correct horse battery");
    expect(mnemonic).toBe(TEST_PHRASE);
    expect(phraseLeaks(file)).toEqual([]);
    await wallet.stop();

    await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
    const restored = make();
    await restored.start();
    await expect(restored.restoreBackup(file, "wrong password here")).rejects.toThrow();
    await restored.restoreBackup(file, "correct horse battery");
    await restored.ensureReady();
    const back = await restored.backup();
    expect(back.mnemonic).toBe(mnemonic);
    expect(back.config).toMatchObject({ network: "signet", provider, serverKey: original.serverKey });
    expect(back.config.walletId, "a new local database: the server fills it from the phrase").not.toBe(original.walletId);
    expect((await intentRepository.list()).map((i) => i.review.state), "an unfinished payment comes back as unknown, to reconcile").toEqual(["unknown"]);
    const other = make("mainnet");
    await other.start();
    const wrong = await other.restoreBackup(file, "correct horse battery").catch((e: unknown) => e);
    expect(wrong, "the Mainnet wallet refuses a Testnet backup").toBeInstanceOf(WrongNetworkError);
    expect(wrong).toMatchObject({ network: "testnet", message: "This backup is a Testnet Bark wallet" });
    expect(other.configured).toBe(false);
    await restored.stop();
  });
});
