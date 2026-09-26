import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { DEFAULT_MINTS, TEST_MINT } from "../src/shared/mints";
import type { StoredLink, StoredProof } from "../src/shared/types";
import { removalRisksFunds, walletRemoval } from "../src/shared/walletRemoval";
import { FakeBarkServer } from "./helpers/fakeBark";
import { FakeBreezNetwork } from "./helpers/fakeBreez";
import { FakeFedimintSdk } from "./helpers/fakeFedimint";
import { TEST_PHRASE, phraseLeaks } from "./helpers/phraseLeaks";
// covers: wallet.instances.remove

// Every server is faked, as in walletCreate.test.ts: these tests cover what a removal takes away and what it leaves.
const info = vi.fn(async () => ({ network: "mutinynet", signerPubkey: `02${"ab".repeat(32)}` }));
vi.mock("@arkade-os/sdk", async (original) => ({ ...await original<object>(), RestArkProvider: class { getInfo = info; } }));
const arkBalance = { value: 0 };
vi.mock("../src/engine/paymentAdapters/arkade", () => ({
  ARK_NETWORKS: ["bitcoin", "mutinynet", "signet", "regtest"],
  ArkadeAdapter: { connect: vi.fn(async (config: { provider: string; network: string }) => ({ config, address: async () => config.network === "bitcoin" ? "ark1me" : "tark1me", balance: async () => arkBalance.value, boardingAddress: async () => "tb1qme", incoming: async () => 0, recoverable: async () => 0, dispose: vi.fn() })) },
}));
vi.mock("../src/engine/paymentAdapters/usdt", () => ({
  UsdtAdapter: {
    inspect: async (config: object) => ({ ...config, decimals: 6, codeHash: "0xfixture" }),
    connect: vi.fn(async (config: object) => ({ config, address: async () => "0x00000000000000000000000000000000000000aa", balances: async () => ({ balance: "0", gasBalance: "0" }), dispose: vi.fn() })),
  },
}));
const { GhostlyNode } = await import("../src/engine/node");
const { cashuMint } = await import("../src/engine/paymentAdapters/providers/cashuMint");
const { FakeLightningProvider, FakeOnchainProvider, fakeLightning, fakeOnchain } = await import("../src/engine/paymentAdapters/providers/testing");
const { TESTNET_ARK } = await import("../src/engine/paymentAdapters/arkWallet");
const { barkTiming } = await import("../src/engine/paymentAdapters/bark");
barkTiming.serverWaitMs = 1;

const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
const proofsAt = async (mint: string) => (await wrap<StoredProof[]>((await store(STORES.proofs, "readonly")).getAll())).filter((p) => p.mint === mint);
const ecash = (mint: string, amount: number, secret: string): StoredProof => ({ mint, id: "00ad268c4d1f5826", amount, secret, C: `02${"cd".repeat(32)}` });

function engine() {
  const fedimint = new FakeFedimintSdk(), bark = new FakeBarkServer(), breez = new FakeBreezNetwork();
  const lightning = new FakeLightningProvider({ settleMs: 60_000 }), onchain = new FakeOnchainProvider();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, {
    automaticWallets: false, fedimintSdk: fedimint.sdk(),
    providers: { lightning: [cashuMint, { ...fakeLightning, create: async () => lightning }], onchain: [{ ...fakeOnchain, create: async () => onchain }] },
  });
  for (const network of ["mainnet", "testnet"] as const) {
    (node["barkWallets"][network] as unknown as { sdk: unknown }).sdk = async () => bark.sdk();
    (node["sparkWallets"][network] as unknown as { sdk: unknown }).sdk = async () => breez.sdk;
  }
  vi.spyOn(node["wallet"], "checkMint").mockImplementation(async (url: string) => ({ url, name: new URL(url).host }));
  const wallets = () => node.getState().wallet.wallets?.map((w) => w.id) ?? [];
  const started = Promise.all((["mainnet", "testnet"] as const).flatMap((n) => [node["lightnings"][n].start(), node["bitcoins"][n].start()]));
  return { node, fedimint, wallets, started };
}

/** A chat, stored and live, whose link only records what it is told. */
async function chat(node: InstanceType<typeof GhostlyNode>, stored: Omit<StoredLink, "id" | "seedB64" | "peerPubKeyZ32" | "encKeyB64" | "createdAt">) {
  const link = { setPaymentMethods: vi.fn(), setPaymentNetworks: vi.fn(), allowsPayment: () => false, paymentEnabled: () => false, supportsPayments: false };
  const full = { id: "chat", seedB64: "seed", peerPubKeyZ32: "peer", encKeyB64: "enc", createdAt: 1, ...stored } as StoredLink;
  const { db } = await import("../src/engine/db");
  await db.putLink(full);
  // The page's state is not built here: a bare link has no presence to show.
  clearTimeout(node["stateTimer"] ?? undefined);
  node["emitState"] = () => {};
  node["capsChanged"] = () => {};
  node["links"].set("chat", { stored: full, link } as never);
  const now = async () => (await db.getLinks()).find((l) => l.id === "chat")!;
  return { link, now };
}

beforeEach(async () => {
  info.mockReset(); info.mockImplementation(async () => ({ network: "mutinynet", signerPubkey: `02${"ab".repeat(32)}` }));
  arkBalance.value = 0;
  await openDb();
  await transact([STORES.settings, STORES.intents, STORES.proofs, STORES.quotes, STORES.melts, STORES.links], (s) => {
    for (const name of [STORES.settings, STORES.intents, STORES.proofs, STORES.quotes, STORES.melts, STORES.links]) s[name].clear();
  });
});

describe("removing a wallet", () => {
  it("an empty Testnet wallet goes on a plain confirm: its record and database are deleted, the Mainnet one stays, and another can be made", async () => {
    const { node, wallets, started } = engine();
    await started;
    await node.walletCreate({ type: "arkade", network: "testnet" });
    info.mockResolvedValueOnce({ network: "bitcoin", signerPubkey: `02${"cd".repeat(32)}` });
    await node.walletCreate({ type: "arkade", network: "mainnet" });
    expect(walletRemoval("arkade", "testnet", node.getState().wallet.networks?.testnet)).toMatchObject({ custody: "device", held: { empty: true, text: "0 test sats" }, backup: "phrase" });

    await node.walletRemove({ type: "arkade", network: "testnet" });
    expect(wallets()).toEqual(["arkade:mainnet"]);
    expect((await settingsKeys()).filter((k) => k.startsWith("arkWallet"))).toEqual(["arkWallet-mode-mainnet"]);
    expect(node.getState().wallet.networks?.testnet.ark).toMatchObject({ configured: false });
    expect(node.getState().wallet.offers?.find((o) => o.type === "arkade" && o.network === "testnet")).toMatchObject({ available: true, exists: false });

    await node.walletCreate({ type: "arkade", network: "testnet" });
    expect(wallets()).toEqual(["arkade:mainnet", "arkade:testnet"]);
  });

  it("a funded wallet is refused without the person's confirmation, saying how much, and removed with it; never a word of its seed in the logs", async () => {
    const { node, wallets, started } = engine();
    await started;
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    info.mockResolvedValue({ network: "bitcoin", signerPubkey: `02${"cd".repeat(32)}` });
    await node["arkWallets"].mainnet.create({ network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api", mnemonic: TEST_PHRASE });
    arkBalance.value = 25_000;
    await node["arkWallets"].mainnet.ensureReady();
    await node["refreshWallet"]();
    const removal = walletRemoval("arkade", "mainnet", node.getState().wallet.networks?.mainnet);
    expect(removal.held).toEqual({ empty: false, text: "25,000 sats" });
    expect(removalRisksFunds(removal)).toBe(true);

    await expect(node.walletRemove({ type: "arkade", network: "mainnet" })).rejects.toThrow("The Mainnet Ark wallet holds 25,000 sats. Confirm that they become unreachable without its backup to remove it.");
    expect(wallets()).toEqual(["arkade:mainnet"]);
    await node.walletRemove({ type: "arkade", network: "mainnet", acceptLoss: true });
    expect(wallets()).toEqual([]);
    expect((await settingsKeys()).filter((k) => k.startsWith("arkWallet"))).toEqual([]);
    expect(phraseLeaks(logged.join("\n"))).toEqual([]);
    vi.restoreAllMocks();
  });

  it("a wallet that is not connected counts as holding money: its balance could not be read", async () => {
    const { node, started } = engine();
    await started;
    await node.walletCreate({ type: "usdt", network: "testnet" });
    await node["usdtWallets"].testnet.lock();
    await node["refreshWallet"]();
    expect(walletRemoval("usdt", "testnet", node.getState().wallet.networks?.testnet).held).toBe("unknown");
    await expect(node.walletRemove({ type: "usdt", network: "testnet" })).rejects.toThrow("Ghostly could not read what the Testnet USDT wallet holds.");
    await node.walletRemove({ type: "usdt", network: "testnet", acceptLoss: true });
    expect(await settingsKeys()).not.toContain("usdtWallet-mode-testnet");
  });

  it("Cashu: the network's ecash and unpaid invoices go with its mints; the other network's Cashu, and its ecash, stay", async () => {
    const { node, wallets, started } = engine();
    await started;
    const real = DEFAULT_MINTS[1];
    node["settings"].mints = [];
    await node.walletCreate({ type: "cashu", network: "testnet" });
    await node.updateSettings({ settings: { mints: [TEST_MINT, real] } });
    await transact([STORES.proofs, STORES.quotes], (s) => {
      s[STORES.proofs].put(ecash(real, 500, "real-1"));
      s[STORES.proofs].put(ecash(TEST_MINT, 8, "test-1"));
      s[STORES.quotes].put({ quote: "q-real", mint: real, amount: 21, invoice: "lnbc210n1", createdAt: 1, expiresAt: null });
    });
    await node["refreshWallet"]();
    expect(wallets()).toEqual(["cashu:mainnet", "cashu:testnet", "lightning:mainnet", "lightning:testnet"]);
    expect(walletRemoval("cashu", "mainnet", node.getState().wallet.networks?.mainnet)).toMatchObject({ held: { empty: false, text: "500 sats" }, backup: "tokens" });
    expect((await node.walletExport({ network: "mainnet" })).map((t) => [t.mint, t.amount])).toEqual([[real, 500]]);

    await expect(node.walletRemove({ type: "cashu", network: "mainnet" })).rejects.toThrow("holds 500 sats");
    await expect(node.walletRemove({ type: "lightning", network: "mainnet" })).rejects.toThrow("comes with your Mainnet Cashu wallet");
    await node.walletRemove({ type: "cashu", network: "mainnet", acceptLoss: true });
    expect(wallets(), "Lightning through those mints went with them").toEqual(["cashu:testnet", "lightning:testnet"]);
    expect(node["settings"].mints).toEqual([TEST_MINT]);
    expect(await proofsAt(real)).toEqual([]);
    expect((await proofsAt(TEST_MINT)).map((p) => p.amount)).toEqual([8]);
    expect(await wrap((await store(STORES.quotes, "readonly")).get("q-real"))).toBeUndefined();
  });

  it("Cashu with a Lightning payment still in flight at its mint waits for it", async () => {
    const { node, started } = engine();
    await started;
    node["settings"].mints = [];
    await node.walletCreate({ type: "cashu", network: "testnet" });
    await transact([STORES.melts], (s) => { s[STORES.melts].put({ quote: "m-1", mint: TEST_MINT, request: "lntbs1", amount: 5, secrets: [], outlay: 6, outputs: [], createdAt: 1 }); });
    await expect(node.walletRemove({ type: "cashu", network: "testnet" })).rejects.toThrow("A Lightning payment from this wallet is still in flight");
    expect(node["settings"].mints).toEqual([TEST_MINT]);
  });

  it("a payment through the wallet that has not finished stops the removal, confirmed or not", async () => {
    const { node, started } = engine();
    await started;
    await node.walletCreate({ type: "arkade", network: "testnet" });
    await transact([STORES.intents], (s) => { s[STORES.intents].put({ review: { id: "pay-1", method: "arkade", network: "mutinynet", provider: TESTNET_ARK.provider, asset: "BTC", unit: "sat", address: "tark1you", expiresAt: Date.now() + 60_000, payee: "you", amount: 10, fee: 0, feeCap: 100, createdAt: 1, state: "submitted" }, prepared: {} }); });
    await expect(node.walletRemove({ type: "arkade", network: "testnet", acceptLoss: true })).rejects.toThrow("A payment through this wallet is not finished yet (1)");
    expect(node.getState().wallet.wallets?.map((w) => w.id)).toEqual(["arkade:testnet"]);
  });

  it("a Lightning source whose money is elsewhere is forgotten without asking about funds; Lightning through the mints takes over", async () => {
    const { node, wallets, started } = engine();
    await started;
    node["settings"].mints = [];
    await node.walletCreate({ type: "lightning", network: "testnet", providerId: "fake-lightning", values: { token: "a-secret-token" } });
    await node.walletCreate({ type: "cashu", network: "testnet" });
    expect(walletRemoval("lightning", "testnet", node.getState().wallet.networks?.testnet).custody).toBe("elsewhere");
    await node.walletRemove({ type: "lightning", network: "testnet" });
    expect(node.getState().wallet.networks?.testnet.lightning?.providerId).toBe("cashu-mint");
    expect(wallets()).toEqual(["cashu:testnet", "lightning:testnet"]);
    expect(await settingsKeys()).not.toContain("lightningSource-testnet");
  });

  it("Bark, Spark, Fedimint and on-chain each lose their record, and Fedimint its federations' databases", async () => {
    const { node, fedimint, wallets, started } = engine();
    await started;
    await node.walletCreate({ type: "bark", network: "testnet" });
    await node.walletCreate({ type: "spark", network: "testnet" });
    const federation = fedimint.federation({ name: "Regtest federation" });
    await node.walletCreate({ type: "fedimint", network: "testnet", invite: federation.invite });
    await node.walletCreate({ type: "bitcoin", network: "testnet", providerId: "fake-onchain", values: { token: "another-secret" } });
    expect(wallets()).toEqual(["bark:testnet", "spark:testnet", "bitcoin:testnet", "fedimint:testnet"]);
    for (const type of ["bark", "spark", "fedimint", "bitcoin"] as const) await node.walletRemove({ type, network: "testnet", acceptLoss: true });
    expect(wallets()).toEqual([]);
    expect((await settingsKeys()).filter((k) => /^(barkWallet|sparkWallet|fedimintWallet|onchainSource)/.test(k))).toEqual([]);
    expect(fedimint.removed).toHaveLength(1);
  });

  it("refuses what is not there", async () => {
    const { node, started } = engine();
    await started;
    await expect(node.walletRemove({ type: "arkade", network: "testnet" })).rejects.toThrow("There is no Testnet Ark wallet to remove");
    await expect(node.walletRemove({ type: "paypal" as never, network: "testnet" })).rejects.toThrow("Unknown kind of wallet");
  });
});

describe("what the chats keep about a removed wallet", () => {
  it("goes back to the default: the network off in a chat is forgotten, the other network's choice stays, and a way with no wallet left loses its switch", async () => {
    const { node, started } = engine();
    await started;
    await node.walletCreate({ type: "arkade", network: "testnet" });
    info.mockResolvedValueOnce({ network: "bitcoin", signerPubkey: `02${"cd".repeat(32)}` });
    await node.walletCreate({ type: "arkade", network: "mainnet" });
    await node.walletCreate({ type: "usdt", network: "testnet" });
    // Testnet Ark off in this chat, Mainnet on; USDT off here altogether.
    const { link, now } = await chat(node, { paymentMethods: { arkade: true, usdt: false }, paymentNetworks: { arkade: ["mainnet"], usdt: [] } });

    await node.walletRemove({ type: "arkade", network: "testnet" });
    expect((await now()).paymentNetworks, "Testnet Ark off is forgotten: made again, it is on").toEqual({ usdt: [] });
    expect((await now()).paymentMethods).toEqual({ arkade: true, usdt: false });

    await node.walletRemove({ type: "usdt", network: "testnet" });
    expect((await now()).paymentMethods, "no USDT wallet left: its switch goes").toEqual({ arkade: true });
    expect((await now()).paymentNetworks).toEqual({});
    expect(link.setPaymentMethods).toHaveBeenLastCalledWith({ arkade: true });
    expect(link.setPaymentNetworks, "the contact is told only the ways with a wallet").toHaveBeenLastCalledWith({ arkade: ["mainnet"] });
  });

  it("keeps a network that is still off after the other network's wallet goes", async () => {
    const { node, started } = engine();
    await started;
    await node.walletCreate({ type: "arkade", network: "testnet" });
    info.mockResolvedValueOnce({ network: "bitcoin", signerPubkey: `02${"cd".repeat(32)}` });
    await node.walletCreate({ type: "arkade", network: "mainnet" });
    // Mainnet off here, Testnet on: removing Testnet leaves Mainnet off.
    const { now } = await chat(node, { paymentNetworks: { arkade: ["testnet"] } });
    await node.walletRemove({ type: "arkade", network: "testnet" });
    expect((await now()).paymentNetworks).toEqual({ arkade: ["testnet"] });
  });
});
