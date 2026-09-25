import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentPreflightError, SPARK_PROVIDER, sparkInvoiceDetails, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bech32m } from "@scure/base";
import { SparkAdapter } from "../src/engine/paymentAdapters/spark";
import { SPARK_MAINNET_NEEDS_KEY, SparkWallet, sparkTiming } from "../src/engine/paymentAdapters/sparkWallet";
import { BreezLightning } from "../src/engine/paymentAdapters/providers/breez";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { WrongNetworkError } from "../src/engine/paymentAdapters/modeGate";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { FakeBreezNetwork, type FakeBreezWallet } from "./helpers/fakeBreez";
import { phraseLeaks, TEST_PHRASE } from "./helpers/phraseLeaks";
// covers: wallet.spark.mainnet-key, wallet.spark.create, wallet.spark.send, wallet.spark.backup, wallet.spark.lightning, payments.chat.reconcile

// The wallet draws its own phrase; a test that looks for it in storage has it draw TEST_PHRASE.
vi.mock("@scure/bip39", async (original) => { const bip39 = await original<typeof import("@scure/bip39")>(); return { ...bip39, generateMnemonic: vi.fn(bip39.generateMnemonic) }; });

let net: FakeBreezNetwork;
const sdk = () => Promise.resolve(net.sdk);
const connect = (mnemonic = generateMnemonic(wordlist)) => SparkAdapter.connect({ network: "regtest", mnemonic }, sdk);
/** The fake wallet behind an adapter: the one whose Spark address it shows. */
const fakeOf = async (adapter: SparkAdapter) => { const address = await adapter.address(); return [...net.wallets.values()].find((w) => w.sparkAddress === address)!; };
const target = (address: string, over: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "spark", network: "regtest", provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000, ...over });
const review = (t: PaymentTarget, amount: number, fee: number, feeCap = 100): PaymentReview => ({ ...t, id: crypto.randomUUID(), payee: "bob", amount, fee, feeCap, createdAt: Date.now(), state: "submitted" });
const sends = (w: FakeBreezWallet) => w.payments.filter((p) => p.paymentType === "send").length;
const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();

sparkTiming.retryMs = 60_000;
beforeEach(async () => {
  net = new FakeBreezNetwork();
  await openDb();
  await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});

describe("the Spark adapter", () => {
  it("pays another wallet's Spark address after review, Spark to Spark, and nothing leaves before the journal", async () => {
    const alice = await connect(), bob = await connect();
    const a = await fakeOf(alice), b = await fakeOf(bob);
    a.balance = 10_000;
    const address = await bob.address();
    expect(address).toMatch(/^sparkrt1/);
    expect(await bob.address(), "an address is the wallet's identity: the same every time").toBe(address);
    const t = target(address);
    const { fee, prepared } = await alice.prepare(t, 2_500, 100);
    expect(prepared).toMatchObject({ kind: "address", amount: 2_500, fee: 0 });
    expect(sends(a), "nothing leaves at review").toBe(0);
    const persist = vi.fn(async () => { expect(sends(a), "written down before anything leaves").toBe(0); });
    const result = await alice.execute(review(t, 2_500, fee), prepared, persist);
    expect(persist).toHaveBeenCalledOnce();
    expect(result).toEqual({ txid: prepared.key, settled: true });
    expect(a.sent[0].idempotencyKey, "the key made at review").toBe(prepared.key);
    expect(a.sent[0].prepareResponse.paymentMethod.type, "a Spark transfer, never Lightning").toBe("sparkAddress");
    expect(await bob.balance()).toBe(2_500);
    expect(b.payments[0]).toMatchObject({ paymentType: "receive", method: "spark", status: "completed" });
    expect((await alice.history())[0]).toMatchObject({ direction: "out", amount: 2_500, via: "spark", status: "completed" });
    expect((await bob.history())[0]).toMatchObject({ direction: "in", amount: 2_500, via: "spark" });
  });

  it("pays an invoice for exactly its amount, and the payee's own history ties the money to that invoice", async () => {
    const alice = await connect(), bob = await connect();
    (await fakeOf(alice)).balance = 5_000;
    const since = Date.now() - 1_000;
    const invoice = await bob.invoice(1_200, "lunch", Date.now() + 900_000);
    expect(invoice).toMatch(/^sparkrt1/);
    expect(invoice, "an invoice is not the wallet's address").not.toBe(await bob.address());
    await expect(alice.prepare(target(invoice), 1_000, 100), "not another amount than the invoice's").rejects.toThrow("another amount");
    const { fee, prepared } = await alice.prepare(target(invoice), 1_200, 100);
    expect(prepared.kind).toBe("invoice");
    expect(await bob.received(invoice, 1_200, since), "nothing yet").toBeUndefined();
    const { txid } = await alice.execute(review(target(invoice), 1_200, fee), prepared, async () => {});
    const receipt = await bob.received(invoice, 1_200, since);
    expect(receipt).toBeTruthy();
    expect(receipt, "one transfer, one id on both sides").toBe(txid);
    expect(await bob.received(invoice, 1_201, since), "not less than asked").toBeUndefined();
    expect(await bob.received(await bob.invoice(1_200, undefined, Date.now() + 900_000), 1_200, since), "not on another invoice").toBeUndefined();
    expect(await bob.received(invoice, 1_200, since, new Set([receipt!])), "one transfer pays one request").toBeUndefined();
    // Money to the bare address pays no request.
    net.paySparkFromOutside(await bob.address(), 1_200);
    expect(await bob.received(invoice, 1_200, since, new Set([receipt!]))).toBeUndefined();
  });

  it("refuses what is not a Spark payment of its network, a fee over the cap, more than the balance, a fee that grew, and no journal", async () => {
    const alice = await connect(), bob = await connect();
    const a = await fakeOf(alice);
    a.balance = 1_000;
    const address = await bob.address();
    const mainnet = bech32m.encode("spark", bech32m.decode(address as `${string}1${string}`, 1024).words, 1024);
    await expect(alice.prepare(target(mainnet), 100, 100)).rejects.toThrow("not a Spark address on regtest");
    await expect(alice.prepare(target(address, { network: "bitcoin" }), 100, 100)).rejects.toThrow();
    await expect(alice.prepare(target(address, { provider: "https://spark.example" }), 100, 100)).rejects.toThrow();
    await expect(alice.prepare(target(address, { method: "bark" }), 100, 100)).rejects.toThrow();
    a.sparkFee = 50;
    await expect(alice.prepare(target(address), 100, 20)).rejects.toThrow("fee exceeds your limit");
    await expect(alice.prepare(target(address), 990, 100)).rejects.toThrow("Insufficient Spark balance");
    const { fee, prepared } = await alice.prepare(target(address), 100, 100);
    a.sparkFee = 80;
    await expect(alice.execute(review(target(address), 100, fee), prepared, async () => {})).rejects.toBeInstanceOf(PaymentPreflightError);
    a.sparkFee = 50;
    await expect(alice.execute(review(target(address), 100, fee), prepared), "no durable journal, no send").rejects.toBeInstanceOf(PaymentPreflightError);
    await expect(alice.execute(review(target(address), 101, fee), prepared, async () => {}), "the review is what was prepared").rejects.toBeInstanceOf(PaymentPreflightError);
    expect(sends(a)).toBe(0);
  });

  it("an error after the send started is settled from the history; an unknown outcome is never sent again", async () => {
    const alice = await connect(), bob = await connect();
    const a = await fakeOf(alice);
    a.balance = 10_000;
    const t = target(await bob.address());
    const first = await alice.prepare(t, 700, 100);
    a.sparkSend = "throw";
    await expect(alice.execute(review(t, 700, first.fee), first.prepared, async () => {})).resolves.toMatchObject({ settled: true, txid: first.prepared.key });
    expect(sends(a)).toBe(1);

    // The SDK lost the transfer before it left: nothing in the history, so unknown; reconciling only looks.
    const second = await alice.prepare(t, 300, 100);
    a.sendPayment = async () => { throw new Error("socket closed"); };
    await expect(alice.execute(review(t, 300, second.fee), second.prepared, async () => {})).rejects.toThrow("outcome unknown");
    await expect(alice.reconcile(review(t, 300, second.fee), second.prepared)).resolves.toEqual({ settled: false });
    expect(sends(a), "reconciling only looks").toBe(1);
    expect(a.calls.filter((c) => c === "syncWallet").length, "it asks Spark before saying unknown").toBeGreaterThan(0);
  });

  it("an approval retried with the same key pays once; a pending send is pending until the history says otherwise", async () => {
    const alice = await connect(), bob = await connect();
    const a = await fakeOf(alice);
    a.balance = 10_000;
    const t = target(await bob.address());
    const { fee, prepared } = await alice.prepare(t, 400, 100);
    a.sparkSend = "pending";
    const r = review(t, 400, fee);
    await expect(alice.execute(r, prepared, async () => {})).resolves.toEqual({ txid: prepared.key, settled: false, pending: true });
    await expect(alice.execute(r, prepared, async () => {}), "found by its key: not sent again").resolves.toMatchObject({ pending: true });
    expect(sends(a)).toBe(1);
    a.settleSpark(prepared.key);
    await expect(alice.reconcile({ ...r, txid: prepared.key }, prepared)).resolves.toEqual({ txid: prepared.key, settled: true });
  });

  it("finds an invoice payment by its invoice when the SDK named the transfer otherwise", async () => {
    net.keyIsId = false;
    const alice = await connect(), bob = await connect();
    (await fakeOf(alice)).balance = 10_000;
    const invoice = await bob.invoice(250, undefined, Date.now() + 900_000);
    const { fee, prepared } = await alice.prepare(target(invoice), 250, 100);
    const r = review(target(invoice), 250, fee);
    const { txid } = await alice.execute(r, prepared, async () => {});
    expect(txid).not.toBe(prepared.key);
    await expect(alice.reconcile(r, prepared)).resolves.toEqual({ txid, settled: true });
  });

  it("through the coordinator: approved once, and a lost answer is reconciled, not paid twice", async () => {
    const alice = await connect(), bob = await connect();
    const a = await fakeOf(alice);
    a.balance = 5_000;
    const coordinator = new PaymentCoordinator(intentRepository, [alice as never]);
    const pending = await coordinator.prepare(target(await bob.address()), 1_000, 100, { payee: "bob" });
    expect(pending).toMatchObject({ method: "spark", state: "pending", fee: 0 });
    const real = a.sendPayment.bind(a);
    a.sendPayment = async () => { throw new Error("socket closed"); };
    const unknown = await coordinator.approve(pending.id);
    expect(unknown.state).toBe("unknown");
    await expect(coordinator.approve(pending.id)).rejects.toThrow("cannot be submitted again");
    expect((await coordinator.reconcile(pending.id)).state).toBe("unknown");
    expect(sends(a)).toBe(0);
    a.sendPayment = real;
    const next = await coordinator.prepare(target(await bob.invoice(1_000, undefined, Date.now() + 900_000)), 1_000, 100, { payee: "bob" });
    expect((await coordinator.approve(next.id)).state).toBe("settled");
    expect(await bob.balance()).toBe(1_000);
  });

  it("is the same wallet as the Breez Lightning source of the same seed: one SDK, one balance", async () => {
    const mnemonic = generateMnemonic(wordlist);
    const spark = await connect(mnemonic);
    const lightning = await BreezLightning.connect({ network: "regtest", mnemonic }, sdk);
    expect(net.connects, "opened once, shared").toHaveLength(1);
    (await fakeOf(spark)).balance = 4_321;
    expect((await lightning.info()).balance).toBe(4_321);
    await spark.close();
    expect((await fakeOf(spark)).disconnected, "still in use by the Lightning source").toBe(false);
    await lightning.close();
    expect([...net.wallets.values()][0].disconnected).toBe(true);
  });

  it("will not open Mainnet without a Breez API key", async () => {
    await expect(SparkAdapter.connect({ network: "bitcoin", mnemonic: generateMnemonic(wordlist) }, sdk)).rejects.toThrow("API key");
    expect(net.connects).toHaveLength(0);
    const main = await SparkAdapter.connect({ network: "bitcoin", mnemonic: generateMnemonic(wordlist), apiKey: "breez-key" }, sdk);
    expect(net.connects[0]).toMatchObject({ network: "mainnet", apiKey: "breez-key" });
    await main.close();
  });
});

describe("the Spark wallet", () => {
  const make = (network: "mainnet" | "testnet" = "testnet") => new SparkWallet(network, vi.fn(), sdk);

  it("Testnet makes a regtest wallet when asked, sealed, and each network's wallet is its own", async () => {
    const wallet = make();
    vi.mocked(generateMnemonic).mockReturnValueOnce(TEST_PHRASE);
    await wallet.start();
    await wallet.ensureReady();
    expect(wallet.configured, "opening makes nothing").toBe(false);
    expect(net.connects).toHaveLength(0);
    await wallet.ensureReady(true);
    expect(wallet.configured).toBe(true);
    expect(await wallet.backup()).toEqual({ mnemonic: TEST_PHRASE, network: "regtest", apiKey: undefined });
    expect(wallet.view).toMatchObject({ configured: true, locked: false, network: "regtest", balance: 0, history: [] });
    expect(wallet.view.address).toMatch(/^sparkrt1/);
    const saved = await wrap((await store(STORES.settings, "readonly")).get("sparkWallet-mode-testnet"));
    expect(phraseLeaks(JSON.stringify(saved)), "the phrase is sealed, never stored as text").toEqual([]);

    const request = await wallet.target(900, "rent");
    expect(request).toMatchObject({ method: "spark", network: "regtest", provider: SPARK_PROVIDER, asset: "BTC", unit: "sat" });
    expect(request.address, "a request is an invoice, not the address").not.toBe(wallet.view.address);
    expect(net.sparkInvoices.get(request.address)).toMatchObject({ amount: 900, memo: "rent" });
    expect(sparkInvoiceDetails(request.address, "regtest"), "what the contact's app reads from it").toMatchObject({ amount: 900, memo: "rent", token: false });

    // The Mainnet wallet, open beside it, has none, makes none without a key, and touches nothing of the Testnet one.
    const mainnet = make("mainnet");
    await mainnet.start();
    expect(mainnet.view).toMatchObject({ configured: false, needsKey: true, unavailable: SPARK_MAINNET_NEEDS_KEY });
    await mainnet.ensureReady(true);
    expect(mainnet.view.configured, "Mainnet makes nothing by itself").toBe(false);
    expect(await settingsKeys()).toEqual(["sparkWallet-mode-testnet"]);
    expect(wallet.view).toMatchObject({ configured: true, locked: false, network: "regtest" });
    await wallet.stop(); await mainnet.stop();
    const again = make();
    await again.start(); await again.ensureReady();
    expect((await again.backup()).mnemonic, "the same wallet, opened again").toBe(TEST_PHRASE);
    await again.stop();
  });

  it("Mainnet opens a wallet only with a Breez API key, sealed beside the phrase", async () => {
    const wallet = make("mainnet");
    await wallet.start();
    await expect(wallet.create({ network: "bitcoin" })).rejects.toThrow(SPARK_MAINNET_NEEDS_KEY);
    const wrong = await wallet.create({ network: "regtest" }).catch((e: unknown) => e);
    expect(wrong, "a regtest wallet belongs to the Testnet wallet").toBeInstanceOf(WrongNetworkError);
    expect(wrong).toMatchObject({ network: "testnet", message: "regtest is a Testnet network: this is the Mainnet Spark wallet" });
    expect(await settingsKeys()).toEqual([]);
    await wallet.create({ network: "bitcoin", apiKey: " the-breez-key " });
    expect(wallet.view).toMatchObject({ configured: true, locked: false, network: "bitcoin" });
    expect(net.connects.at(-1)).toMatchObject({ network: "mainnet", apiKey: "the-breez-key" });
    expect(await settingsKeys()).toEqual(["sparkWallet-mode-mainnet"]);
    expect(JSON.stringify(await wrap((await store(STORES.settings, "readonly")).get("sparkWallet-mode-mainnet")))).not.toContain("the-breez-key");
    expect((await wallet.backup()).apiKey).toBe("the-breez-key");
    await wallet.stop();
  });

  it("a wallet holding money or payments is never replaced; an empty one is archived, not deleted", async () => {
    const wallet = make();
    await wallet.start(); await wallet.ensureReady(true);
    const fake = await fakeOf(wallet.adapter!);
    net.paySparkFromOutside(fake.sparkAddress, 10);
    await expect(wallet.create({ network: "regtest", mnemonic: TEST_PHRASE })).rejects.toThrow("will not be replaced");
    fake.balance = 0; fake.payments.length = 0;
    await wallet.create({ network: "regtest", mnemonic: TEST_PHRASE });
    expect((await wallet.backup()).mnemonic).toBe(TEST_PHRASE);
    expect((await settingsKeys()).some((k) => k.startsWith("sparkWallet-retired-"))).toBe(true);
    await expect(wallet.create({ network: "regtest", mnemonic: "not a phrase" })).rejects.toThrow("Invalid recovery phrase");
    await wallet.stop();
  });

  it("an encrypted backup restores the phrase and the payments into a fresh profile", async () => {
    const wallet = make();
    vi.mocked(generateMnemonic).mockReturnValueOnce(TEST_PHRASE);
    await wallet.start(); await wallet.ensureReady(true);
    const address = wallet.view.address!;
    await intentRepository.put({ review: { ...review(target(address), 5, 0), state: "submitted" }, prepared: { address, kind: "address", amount: 5, fee: 0, key: crypto.randomUUID() } });
    await expect(wallet.exportBackup("short")).rejects.toThrow("12 characters");
    const file = await wallet.exportBackup("correct horse battery");
    expect(phraseLeaks(file)).toEqual([]);
    await wallet.stop();

    await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
    const fresh = make();
    await fresh.start();
    await expect(fresh.restoreBackup(file, "wrong password here")).rejects.toThrow();
    await fresh.restoreBackup(file, "correct horse battery");
    expect((await fresh.backup()).mnemonic).toBe(TEST_PHRASE);
    expect((await intentRepository.list()).map((i) => i.review.state), "an unfinished payment comes back unknown").toEqual(["unknown"]);
    await fresh.ensureReady();
    expect(fresh.view.address, "the same Spark wallet").toBe(address);
    const mainnet = make("mainnet");
    await mainnet.start();
    const wrong = await mainnet.restoreBackup(file, "correct horse battery", "a-breez-key").catch((e: unknown) => e);
    expect(wrong, "the Mainnet wallet refuses a Testnet backup").toBeInstanceOf(WrongNetworkError);
    expect(wrong).toMatchObject({ network: "testnet", message: "This backup is a Testnet Spark wallet" });
    expect(mainnet.configured).toBe(false);
    await fresh.stop(); await mainnet.stop();
  });

  it("a Spark service that does not answer leaves nothing saved and says it is connecting", async () => {
    const down = new SparkWallet("testnet", vi.fn(), async () => ({ connect: async () => { throw new Error("operators unreachable"); } }));
    await down.start();
    await down.ensureReady(true);
    expect(down.view.error).toContain("operators unreachable");
    expect(await settingsKeys()).toEqual([]);
    await down.stop();
  });
});
