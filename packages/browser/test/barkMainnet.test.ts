import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentTarget } from "@ghostly/core";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { FakeBarkServer } from "./helpers/fakeBark";
// covers: wallet.bark.mainnet, payments.mainnet-confirm, wallet.instances.remove

// Bark on Mainnet through the engine, against a mocked Bitcoin server: nothing here reaches Second's servers or moves money.
const { GhostlyNode } = await import("../src/engine/node");
const { MAINNET_BARK, TESTNET_BARK } = await import("../src/engine/paymentAdapters/barkWallet");
const { REAL_MONEY_UNCONFIRMED } = await import("../src/engine/paymentAdapters/walletInstances");
const { intentRepository } = await import("../src/engine/paymentAdapters/persistence");
const { barkTiming } = await import("../src/engine/paymentAdapters/bark");
barkTiming.serverWaitMs = 1;

const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
const barkDatabases = async () => (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n.startsWith("ghostly-bark-")).sort();

function engine() {
  // Second's Bitcoin server and its signet one, each with its own key; a Bitcoin server issues ark1p… addresses.
  const main = new FakeBarkServer("03" + "cd".repeat(32), "bitcoin", "main"), signet = new FakeBarkServer();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  (node["barkWallets"].mainnet as unknown as { sdk: unknown }).sdk = async () => main.sdk();
  (node["barkWallets"].testnet as unknown as { sdk: unknown }).sdk = async () => signet.sdk();
  const wallets = () => node.getState().wallet.wallets?.map((w) => w.id) ?? [];
  const offer = (network: "mainnet" | "testnet") => node.getState().wallet.offers?.find((o) => o.type === "bark" && o.network === network);
  return { node, main, signet, wallets, offer };
}
/** The Bark wallets' timers and daemons end with the test. */
const stop = (node: InstanceType<typeof GhostlyNode>) => Promise.all((["mainnet", "testnet"] as const).map((n) => node["barkWallets"][n].stop()));
const funded = (server: FakeBarkServer, sats: number) => { const wallet = [...server.wallets.values()].at(-1)!; wallet.fund(sats); return wallet; };
const barkTarget = (address: string, over: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "bark", network: "bitcoin", provider: MAINNET_BARK.provider, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000, ...over });

beforeEach(async () => {
  await openDb();
  await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});

describe("a Mainnet Bark wallet", () => {
  it("New offers it and makes it in one click on Second's Bitcoin server, checked first; a server that does not answer leaves nothing", async () => {
    const { node, main, wallets, offer } = engine();
    await node["refreshWallet"]();
    expect(offer("mainnet")).toMatchObject({ available: true, exists: false });
    expect(offer("mainnet")?.reason).toBeUndefined();

    main.down = true;
    await expect(node.walletCreate({ type: "bark", network: "mainnet" })).rejects.toThrow("not answering");
    expect(wallets()).toEqual([]);
    expect(await settingsKeys()).toEqual([]);
    expect(await barkDatabases()).toEqual([]);
    expect(offer("mainnet")).toMatchObject({ available: true, exists: false });

    main.down = false;
    expect((await node.walletCreate({ type: "bark", network: "mainnet" })).config).toEqual({ chain: "bitcoin", provider: MAINNET_BARK.provider });
    expect((await node.walletCreate({ type: "bark", network: "testnet" })).config).toEqual({ chain: "signet", provider: TESTNET_BARK.provider });
    expect(wallets()).toEqual(["bark:mainnet", "bark:testnet"]);
    expect(offer("mainnet")).toMatchObject({ available: true, exists: true });
    await expect(node.walletCreate({ type: "bark", network: "mainnet" })).rejects.toThrow("already have a Mainnet Bark wallet");
    expect(node.getState().wallet.networks?.mainnet.bark).toMatchObject({ network: "bitcoin", terms: "https://second.tech/terms" });
    await stop(node);
  });

  it("pays only once the person confirmed real money, and never with a test card or to a test address", async () => {
    const { node, main, signet } = engine();
    await node.walletCreate({ type: "bark", network: "mainnet" });
    await node.walletCreate({ type: "bark", network: "testnet" });
    funded(main, 20_000); funded(signet, 20_000);
    // A payee on the same Bitcoin server.
    const payee = await main.sdk().open({ network: "bitcoin", mnemonic: "payee", server: MAINNET_BARK.provider, esplora: MAINNET_BARK.explorer, database: "ghostly-bark-payee" });
    const address = (await payee.wallet.newAddressWithIndex()).address;
    expect(address).toMatch(/^ark1p/);

    await expect(node.preparePayment({ target: barkTarget(address), amount: 1_000, feeCap: 100, payee: address, network: "testnet" })).rejects.toThrow(/Testnet|Mainnet/);
    await expect(node.preparePayment({ target: barkTarget("tark1psrvtestx1"), amount: 1_000, feeCap: 100, payee: "x" })).rejects.toThrow("test network Bark address");
    await expect(node.preparePayment({ target: barkTarget(address, { network: "signet", provider: TESTNET_BARK.provider }), amount: 1_000, feeCap: 100, payee: address })).rejects.toThrow("Mainnet Bark address");

    const review = await node.preparePayment({ target: barkTarget(address), amount: 1_000, feeCap: 100, payee: address });
    await expect(node.approvePayment({ id: review.id })).rejects.toThrow(REAL_MONEY_UNCONFIRMED);
    expect((await intentRepository.get(review.id))?.review.state).toBe("pending");
    expect(main.sent).toBe(0);
    expect((await node.approvePayment({ id: review.id, confirmedReal: true })).state).toBe("settled");
    expect(main.sent).toBe(1);
    expect(signet.sent).toBe(0);
    await stop(node);
  });

  it("is not removed while it holds money unless the person accepts the loss, nor at all while a payment is unfinished", async () => {
    const { node, main, wallets } = engine();
    await node.walletCreate({ type: "bark", network: "mainnet" });
    funded(main, 20_000);
    await node["barkWallets"].mainnet.refresh();
    await node["refreshWallet"]();
    await expect(node.walletRemove({ type: "bark", network: "mainnet" })).rejects.toThrow("The Mainnet Bark wallet holds 20,000 sats");
    await transact([STORES.intents], (s) => { s[STORES.intents].put({ review: { id: "pay-1", method: "bark", network: "bitcoin", provider: MAINNET_BARK.provider, asset: "BTC", unit: "sat", address: "ark1pyou", expiresAt: Date.now() + 60_000, payee: "you", amount: 10, fee: 0, feeCap: 100, createdAt: 1, state: "submitted" }, prepared: {} }); });
    await node["refreshWallet"]();
    await expect(node.walletRemove({ type: "bark", network: "mainnet", acceptLoss: true })).rejects.toThrow("A payment through this wallet is not finished yet (1)");
    expect(wallets()).toEqual(["bark:mainnet"]);

    await transact([STORES.intents], (s) => { s[STORES.intents].clear(); });
    await node["refreshWallet"]();
    await node.walletRemove({ type: "bark", network: "mainnet", acceptLoss: true });
    expect(wallets()).toEqual([]);
    expect((await settingsKeys()).filter((k) => k.startsWith("barkWallet"))).toEqual([]);
    await stop(node);
  });
});
