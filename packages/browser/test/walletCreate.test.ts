import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import { DEFAULT_MINTS, TEST_MINT } from "../src/shared/mints";
import { FakeBarkServer } from "./helpers/fakeBark";
import { FakeBreezNetwork } from "./helpers/fakeBreez";
import { FakeFedimintSdk } from "./helpers/fakeFedimint";
// covers: wallet.instances.create, wallet.instances.networks, wallet.bark.mainnet-off, wallet.fedimint.mainnet-off, wallet.test-coins

// Every server is faked: these tests cover what one click makes, checks and saves, never a network.
const info = vi.fn(async () => ({ network: "mutinynet", signerPubkey: `02${"ab".repeat(32)}` }));
vi.mock("@arkade-os/sdk", async (original) => ({ ...await original<object>(), RestArkProvider: class { getInfo = info; } }));
vi.mock("../src/engine/paymentAdapters/arkade", () => ({
  ARK_NETWORKS: ["bitcoin", "mutinynet", "signet", "regtest"],
  ArkadeAdapter: { connect: vi.fn(async (config: { provider: string; network: string }) => ({ config, address: async () => config.network === "bitcoin" ? "ark1me" : "tark1me", balance: async () => 0, boardingAddress: async () => "tb1qme", incoming: async () => 0, recoverable: async () => 0, dispose: vi.fn() })) },
}));
const inspect = vi.fn(async (config: object) => ({ ...config, decimals: 6, codeHash: "0xfixture" }));
vi.mock("../src/engine/paymentAdapters/usdt", () => ({
  UsdtAdapter: {
    inspect: (config: object) => inspect(config),
    connect: vi.fn(async (config: object) => ({ config, address: async () => "0x00000000000000000000000000000000000000aa", balances: async () => ({ balance: "0", gasBalance: "0" }), dispose: vi.fn() })),
  },
}));
const { GhostlyNode } = await import("../src/engine/node");
const { cashuMint } = await import("../src/engine/paymentAdapters/providers/cashuMint");
const { FakeLightningProvider, FakeOnchainProvider, fakeLightning, fakeOnchain } = await import("../src/engine/paymentAdapters/providers/testing");
const { BARK_MAINNET_UNAVAILABLE, TESTNET_BARK } = await import("../src/engine/paymentAdapters/barkWallet");
const { TESTNET_ARK, DEFAULT_ARK } = await import("../src/engine/paymentAdapters/arkWallet");
const { FEDIMINT_MAINNET_UNAVAILABLE } = await import("../src/engine/paymentAdapters/fedimintWallet");
const { SPARK_MAINNET_NOT_YET, createTiming } = await import("../src/engine/paymentAdapters/walletInstances");
const { barkTiming } = await import("../src/engine/paymentAdapters/bark");
barkTiming.serverWaitMs = 1;

const settingsKeys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();

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
  // Only these mints answer; the others are down.
  const reachable = new Set<string>([TEST_MINT, DEFAULT_MINTS[1]]);
  const checkMint = vi.spyOn(node["wallet"], "checkMint").mockImplementation(async (url: string) => {
    if (!reachable.has(url)) throw new Error(`Could not reach ${new URL(url).host}. Check the address: it should be a Cashu mint.`);
    return { url, name: new URL(url).host };
  });
  const wallets = () => node.getState().wallet.wallets?.map((w) => w.id) ?? [];
  const started = Promise.all((["mainnet", "testnet"] as const).flatMap((n) => [node["lightnings"][n].start(), node["bitcoins"][n].start()]));
  return { node, fedimint, bark, breez, reachable, checkMint, wallets, started };
}

beforeEach(async () => {
  info.mockReset(); info.mockImplementation(async () => ({ network: "mutinynet", signerPubkey: `02${"ab".repeat(32)}` }));
  createTiming.timeoutMs = 60_000;
  await openDb();
  await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});

describe("one click makes a wallet of a type on a network", () => {
  it("Cashu: the network's default mints that answer, the first primary; Lightning through them comes with it", async () => {
    const { node, wallets, started } = engine();
    await started;
    node["settings"].mints = [];
    const made = await node.walletCreate({ type: "cashu", network: "testnet" });
    expect(made).toMatchObject({ id: "cashu:testnet", type: "cashu", network: "testnet", config: { mint: TEST_MINT } });
    expect(node["settings"].mints).toEqual([TEST_MINT]);
    expect(wallets()).toEqual(["cashu:testnet", "lightning:testnet"]);

    // Mainnet: two of its three mints are down; the one that answers is the wallet's, and the test mint stays Testnet's.
    const mainnet = await node.walletCreate({ type: "cashu", network: "mainnet" });
    expect(mainnet.config.mint).toBe(DEFAULT_MINTS[1]);
    expect(node["settings"].mints).toEqual([TEST_MINT, DEFAULT_MINTS[1]]);
    expect(node["networkMints"]("testnet")).toEqual([TEST_MINT]);
    await expect(node.walletCreate({ type: "cashu", network: "testnet" })).rejects.toThrow("You already have a Testnet Cashu wallet");
  });

  it("Cashu: no default mint answering is one clear failure, and no mint is added", async () => {
    const { node, reachable, wallets, started } = engine();
    await started;
    node["settings"].mints = [];
    reachable.clear();
    await expect(node.walletCreate({ type: "cashu", network: "mainnet" })).rejects.toThrow(/^Could not create the Mainnet Cashu wallet: Could not reach .*Nothing was saved; try again\.$/);
    expect(node["settings"].mints).toEqual([]);
    expect(wallets()).toEqual([]);
  });

  it("Ark: Testnet on Mutinynet and Mainnet on Bitcoin, each checked with its server and stored under its own key", async () => {
    const { node, wallets, started } = engine();
    await started;
    const testnet = await node.walletCreate({ type: "arkade", network: "testnet" });
    expect(testnet.config).toEqual({ chain: "mutinynet", provider: TESTNET_ARK.provider });
    info.mockResolvedValueOnce({ network: "bitcoin", signerPubkey: `02${"cd".repeat(32)}` });
    const mainnet = await node.walletCreate({ type: "arkade", network: "mainnet" });
    expect(mainnet.config).toEqual({ chain: "bitcoin", provider: DEFAULT_ARK.provider });
    expect(wallets()).toEqual(["arkade:mainnet", "arkade:testnet"]);
    expect(await settingsKeys()).toEqual(expect.arrayContaining(["arkWallet-mode-mainnet", "arkWallet-mode-testnet"]));
    expect(node.getState().wallet.networks?.testnet.ark).toMatchObject({ configured: true, locked: false, address: "tark1me" });
    await expect(node.walletCreate({ type: "arkade", network: "testnet" })).rejects.toThrow("You already have a Testnet Ark wallet");
  });

  it("Ark: a server on the wrong chain, or one that does not answer, makes nothing", async () => {
    const { node, wallets, started } = engine();
    await started;
    info.mockResolvedValueOnce({ network: "bitcoin", signerPubkey: `02${"ab".repeat(32)}` });
    await expect(node.walletCreate({ type: "arkade", network: "testnet" })).rejects.toThrow("Could not create the Testnet Ark wallet: That Ark provider runs on bitcoin, not mutinynet. Nothing was saved; try again.");
    info.mockRejectedValueOnce(new Error("Failed to fetch"));
    await expect(node.walletCreate({ type: "arkade", network: "testnet" })).rejects.toThrow("Failed to fetch. Nothing was saved");
    expect(wallets()).toEqual([]);
    expect((await settingsKeys()).filter((k) => k.startsWith("arkWallet"))).toEqual([]);
  });

  it("a server that never answers is given up on in time, saving nothing, and a later click works", async () => {
    const { node, wallets, started } = engine();
    await started;
    createTiming.timeoutMs = 50;
    info.mockImplementationOnce(() => new Promise(() => {}));
    await expect(node.walletCreate({ type: "arkade", network: "testnet" })).rejects.toThrow("Could not create the Testnet Ark wallet: It did not answer in time. Nothing was saved; try again.");
    expect((await settingsKeys()).filter((k) => k.startsWith("arkWallet"))).toEqual([]);
    createTiming.timeoutMs = 60_000;
    await node.walletCreate({ type: "arkade", network: "testnet" });
    expect(wallets()).toEqual(["arkade:testnet"]);
  });

  it("USDT: Sepolia for Testnet and Ethereum for Mainnet, the token checked on its chain first", async () => {
    const { node, wallets, started } = engine();
    await started;
    expect((await node.walletCreate({ type: "usdt", network: "testnet" })).config).toMatchObject({ chain: "sepolia" });
    expect((await node.walletCreate({ type: "usdt", network: "mainnet" })).config).toMatchObject({ chain: "ethereum" });
    expect(inspect.mock.calls.map(([c]) => (c as { chainId: number }).chainId)).toEqual([11155111, 1]);
    expect(wallets()).toEqual(["usdt:mainnet", "usdt:testnet"]);
    inspect.mockRejectedValueOnce(new Error("RPC unavailable"));
    await transact([STORES.settings], (s) => s[STORES.settings].delete("usdtWallet-mode-testnet"));
    await node["usdtWallets"].testnet.start();
    await expect(node.walletCreate({ type: "usdt", network: "testnet" })).rejects.toThrow("RPC unavailable. Nothing was saved");
  });

  it("Bark and Spark: Testnet in one click; Mainnet is not offered yet, and says why", async () => {
    const { node, wallets, started } = engine();
    await started;
    expect((await node.walletCreate({ type: "bark", network: "testnet" })).config).toEqual({ chain: "signet", provider: TESTNET_BARK.provider });
    expect((await node.walletCreate({ type: "spark", network: "testnet" })).config).toEqual({ chain: "regtest" });
    await expect(node.walletCreate({ type: "bark", network: "mainnet" })).rejects.toThrow(BARK_MAINNET_UNAVAILABLE);
    await expect(node.walletCreate({ type: "spark", network: "mainnet" })).rejects.toThrow(SPARK_MAINNET_NOT_YET);
    expect(wallets()).toEqual(["bark:testnet", "spark:testnet"]);
    const offers = node.getState().wallet.offers ?? [];
    expect(offers.find((o) => o.type === "bark" && o.network === "mainnet")).toMatchObject({ available: false, reason: BARK_MAINNET_UNAVAILABLE });
    expect(offers.find((o) => o.type === "spark" && o.network === "mainnet")).toMatchObject({ available: false, reason: SPARK_MAINNET_NOT_YET });
    expect(offers.find((o) => o.type === "bark" && o.network === "testnet")).toMatchObject({ available: true, exists: true });
  });

  it("Fedimint asks for its one thing, an invite, and joins only a federation of its network", async () => {
    const { node, fedimint, wallets, started } = engine();
    await started;
    const federation = fedimint.federation({ name: "Regtest federation" });
    await expect(node.walletCreate({ type: "fedimint", network: "testnet" })).rejects.toThrow("Paste the federation's invite code");
    await expect(node.walletCreate({ type: "fedimint", network: "mainnet", invite: federation.invite })).rejects.toThrow(FEDIMINT_MAINNET_UNAVAILABLE);
    const real = fedimint.federation({ network: "bitcoin" });
    await expect(node.walletCreate({ type: "fedimint", network: "testnet", invite: real.invite })).rejects.toThrow("it belongs in a Mainnet Fedimint wallet");
    expect((await node.walletCreate({ type: "fedimint", network: "testnet", invite: federation.invite })).config).toEqual({ federations: "1" });
    expect(wallets()).toEqual(["fedimint:testnet"]);
    expect(node.getState().wallet.offers?.find((o) => o.type === "fedimint" && o.network === "testnet")).toMatchObject({ available: true, needs: "invite" });
  });

  it("Lightning and on-chain ask only for their source's form, filled with the network's defaults; a source of another network is refused", async () => {
    const { node, wallets, started } = engine();
    await started;
    await node["refreshWallet"]();
    const offers = node.getState().wallet.offers ?? [];
    expect(offers.find((o) => o.type === "lightning" && o.network === "testnet")?.providers?.map((p) => p.id)).toEqual(["fake-lightning"]);
    expect(offers.find((o) => o.type === "bitcoin" && o.network === "mainnet")).toMatchObject({ available: false });
    await expect(node.walletCreate({ type: "lightning", network: "testnet", providerId: "nwc" })).rejects.toThrow("Choose a Lightning source that runs on Testnet");
    await expect(node.walletCreate({ type: "lightning", network: "testnet", providerId: "fake-lightning", values: {} })).rejects.toThrow("Enter access token");
    const ln = await node.walletCreate({ type: "lightning", network: "testnet", providerId: "fake-lightning", values: { token: "a-secret-token" } });
    expect(ln).toMatchObject({ id: "lightning:testnet", config: { providerId: "fake-lightning" } });
    const chain = await node.walletCreate({ type: "bitcoin", network: "testnet", providerId: "fake-onchain", values: { token: "another-secret" } });
    expect(chain).toMatchObject({ id: "bitcoin:testnet" });
    expect(wallets()).toEqual(["lightning:testnet", "bitcoin:testnet"]);
    expect(JSON.stringify(node.getState()), "a secret never reaches the pages").not.toMatch(/a-secret-token|another-secret/);
  });

  it("refuses what it does not know", async () => {
    const { node, started } = engine();
    await started;
    await expect(node.walletCreate({ type: "paypal" as never, network: "testnet" })).rejects.toThrow("Unknown kind of wallet");
    await expect(node.walletCreate({ type: "cashu", network: "signet" as never })).rejects.toThrow("Choose Mainnet or Testnet");
  });
});

describe("each network's wallets say which ways of paying they bring", () => {
  it("a chat is told the networks per way of paying, and told again when a wallet is made", async () => {
    const { node, started } = engine();
    await started;
    node["settings"].mints = [];
    const setPaymentNetworks = vi.fn();
    // A bare chat link: only what the announcement touches (the page's state is not built here).
    node["emitState"] = () => {};
    node["links"].set("chat", { stored: { id: "chat" }, link: { setPaymentNetworks, allowsPayment: () => false, paymentEnabled: () => false, supportsPayments: false } } as never);
    await node.walletCreate({ type: "cashu", network: "testnet" });
    expect(setPaymentNetworks).toHaveBeenLastCalledWith({ cashu: ["testnet"], lightning: ["testnet"] });
    await node.walletCreate({ type: "arkade", network: "testnet" });
    expect(setPaymentNetworks).toHaveBeenLastCalledWith({ cashu: ["testnet"], lightning: ["testnet"], arkade: ["testnet"] });
    const calls = setPaymentNetworks.mock.calls.length;
    await node["refreshWallet"]();
    expect(setPaymentNetworks, "nothing new, nothing said").toHaveBeenCalledTimes(calls);
  });
});

describe("Get test coins, pressed on a Testnet wallet", () => {
  it("never on Mainnet, and never for a wallet whose faucet Ghostly cannot ask", async () => {
    const { node, started } = engine();
    await started;
    const asked = vi.spyOn(node["wallet"], "testCoins");
    await expect(node.walletTestCoins({ type: "cashu", network: "mainnet" })).rejects.toThrow("Testnet wallets only");
    await expect(node.walletTestCoins({ type: "arkade", network: "testnet" })).rejects.toThrow("open it instead");
    expect(asked).not.toHaveBeenCalled();
  });

  it("Cashu, and Lightning through the mints: 10,000 test sats from the test mint", async () => {
    const { node, started } = engine();
    await started;
    const asked = vi.spyOn(node["wallet"], "testCoins").mockResolvedValue({ mint: TEST_MINT, amount: 10_000 });
    expect(await node.walletTestCoins({ type: "cashu", network: "testnet" })).toEqual({ amount: 10_000, unit: "test sats" });
    expect(await node.walletTestCoins({ type: "lightning", network: "testnet" })).toEqual({ amount: 10_000, unit: "test sats" });
    expect(asked.mock.calls).toEqual([[10_000, "testnet"], [10_000, "testnet"]]);
  });

  it("a faucet that refuses says why: rate limited, or what failed", async () => {
    const { node, started } = engine();
    await started;
    const asked = vi.spyOn(node["wallet"], "testCoins").mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { status: 429 }));
    await expect(node.walletTestCoins({ type: "cashu", network: "testnet" })).rejects.toThrow("Rate limited: the faucet is busy. Try again in a minute.");
    asked.mockRejectedValueOnce(new Error("testnut.cashu.space did not answer"));
    await expect(node.walletTestCoins({ type: "cashu", network: "testnet" })).rejects.toThrow("The faucet did not answer: testnut.cashu.space did not answer");
  });

  it("USDT: 1,000 TEST-USDT from the Sepolia faucet, on its way once the transaction is sent", async () => {
    const { node, started } = engine();
    await started;
    const asked = vi.spyOn(node["usdtWallets"].testnet, "getTestTokens").mockResolvedValue("0xhash");
    expect(await node.walletTestCoins({ type: "usdt", network: "testnet" })).toEqual({ amount: 1_000, unit: "TEST-USDT", pending: true });
    expect(asked).toHaveBeenCalledOnce();
  });
});
