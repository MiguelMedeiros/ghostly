import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentPreflightError, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { BarkAdapter, barkTiming, type BarkConfig } from "../src/engine/paymentAdapters/bark";
import { BARK_MAINNET_UNAVAILABLE, BarkWallet, TESTNET_BARK } from "../src/engine/paymentAdapters/barkWallet";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { FakeBarkServer } from "./helpers/fakeBark";
import { phraseLeaks, TEST_PHRASE } from "./helpers/phraseLeaks";
// covers: wallet.bark.mainnet-off, wallet.bark.create, wallet.bark.send, wallet.bark.backup, payments.chat.reconcile

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
  const make = () => new BarkWallet(vi.fn(), async () => server.sdk());

  it("is Testnet only: Mainnet says so and makes no wallet", async () => {
    const wallet = make();
    await wallet.start(); await wallet.setMode("mainnet");
    await wallet.ensureReady();
    expect(wallet.view).toMatchObject({ configured: false, unavailable: BARK_MAINNET_UNAVAILABLE });
    expect(() => wallet.require()).toThrow("not available yet");
    await expect(wallet.create({ network: "bitcoin", provider: "https://ark.second.tech", explorer: "https://mempool.second.tech/api" })).rejects.toThrow("Switch the wallets to Testnet");
    expect(await settingsKeys()).toEqual([]);
  });

  it("Testnet makes a signet wallet by itself, pins the server key, and keeps each mode's wallet apart", async () => {
    const wallet = make();
    vi.mocked(generateMnemonic).mockReturnValueOnce(TEST_PHRASE);
    await wallet.start(); await wallet.setMode("testnet");
    await wallet.ensureReady();
    expect((await wallet.backup()).mnemonic).toBe(TEST_PHRASE);
    expect(wallet.view).toMatchObject({ configured: true, locked: false, network: "signet", provider: TESTNET_BARK.provider, balance: 0 });
    expect(wallet.view.address).toMatch(/^tark1p/);
    const saved = await wrap<{ config: BarkConfig; seed: unknown; deviceKey: string }>((await store(STORES.settings, "readonly")).get("barkWallet"));
    expect(saved.config).toMatchObject({ network: "signet", serverKey: server.key });
    expect(phraseLeaks(JSON.stringify(saved)), "the phrase is sealed, never stored as text").toEqual([]);

    await wallet.setMode("mainnet");
    expect(await settingsKeys()).toEqual(["barkWallet-mode-testnet"]);
    expect(wallet.view).toMatchObject({ configured: false, unavailable: BARK_MAINNET_UNAVAILABLE });
    await wallet.setMode("testnet");
    expect(await settingsKeys()).toEqual(["barkWallet"]);
    await wallet.ensureReady();
    expect(wallet.view.address).toMatch(/^tark1p/);
    const target = await wallet.target();
    expect(target).toMatchObject({ method: "bark", network: "signet", provider: TESTNET_BARK.provider });
    expect(target.address).not.toBe(wallet.view.address);
    await wallet.stop();
  });

  it("a server that never answers leaves no wallet behind, however often it is retried", async () => {
    server.down = true;
    const before = (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("ghostly-bark-"));
    const wallet = make();
    await wallet.start(); await wallet.setMode("testnet");
    await wallet.ensureReady();
    expect(wallet.view.error).toContain("not answering");
    expect(await settingsKeys()).toEqual([]);
    const after = (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("ghostly-bark-"));
    expect(after, "the draft's databases are gone").toEqual(before);
    await wallet.stop();
  });

  it("a wallet holding money or payments is never replaced; an empty one is archived, not deleted", async () => {
    const wallet = make();
    await wallet.start(); await wallet.setMode("testnet"); await wallet.ensureReady();
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
    await wallet.start(); await wallet.setMode("testnet"); await wallet.ensureReady();
    const { mnemonic, config: original } = await wallet.backup();
    await intentRepository.put({ review: { ...review(target("tark1psrvx"), 5, 0), state: "submitted" }, prepared: { address: "tark1psrvx", amount: 5, fee: 0, after: 0 } });
    await expect(wallet.exportBackup("short")).rejects.toThrow("12 characters");
    const file = await wallet.exportBackup("correct horse battery");
    expect(mnemonic).toBe(TEST_PHRASE);
    expect(phraseLeaks(file)).toEqual([]);
    await wallet.stop();

    await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
    const restored = make();
    await restored.start(); await restored.setMode("testnet");
    await expect(restored.restoreBackup(file, "wrong password here")).rejects.toThrow();
    await restored.restoreBackup(file, "correct horse battery");
    await restored.ensureReady();
    const back = await restored.backup();
    expect(back.mnemonic).toBe(mnemonic);
    expect(back.config).toMatchObject({ network: "signet", provider, serverKey: original.serverKey });
    expect(back.config.walletId, "a new local database: the server fills it from the phrase").not.toBe(original.walletId);
    expect((await intentRepository.list()).map((i) => i.review.state), "an unfinished payment comes back as unknown, to reconcile").toEqual(["unknown"]);
    const other = make();
    await other.start(); await other.setMode("mainnet");
    await expect(other.restoreBackup(file, "correct horse battery")).rejects.toThrow("switch the wallets to it first");
    await restored.stop();
  });
});
