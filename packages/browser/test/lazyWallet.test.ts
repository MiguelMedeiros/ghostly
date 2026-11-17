import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WALLET_NETWORKS, type WalletNetwork } from "@ghostly/core";
import { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import { BarkWallet } from "../src/engine/paymentAdapters/barkWallet";
import { FedimintWallet } from "../src/engine/paymentAdapters/fedimintWallet";
import { SparkWallet } from "../src/engine/paymentAdapters/sparkWallet";
import { UsdtWallet } from "../src/engine/paymentAdapters/usdtWallet";
import { lazyArkWallet, lazyBarkWallet, lazyFedimintWallet, lazySparkWallet, lazyUsdtWallet } from "../src/engine/paymentAdapters/lazyWallet";
import { GhostlyNode } from "../src/engine/node";
import { STORES, openDb, transact } from "../src/shared/idb";
// covers: wallet.instances.networks

const CLASSES = { ark: ArkWallet, bark: BarkWallet, fedimint: FedimintWallet, spark: SparkWallet, usdt: UsdtWallet };
type Kind = keyof typeof CLASSES;
const KINDS = Object.keys(CLASSES) as Kind[];
/** What each stand-in answers by itself, besides its view: what is asked of a wallet at once, and the idle reads. */
const IDLE: Record<Kind, string[]> = {
  ark: ["require", "refresh"], bark: ["require", "refresh"], spark: ["require", "refresh", "breezDatabase"], usdt: ["require", "target", "refresh"],
  fedimint: ["client", "spendState", "federation", "ready", "requestFederations", "invoiceFederation", "target", "inspectNotes", "refresh", "checkReceives"],
};
const fields = { ark: "arkWallets", bark: "barkWallets", fedimint: "fedimintWallets", spark: "sparkWallets", usdt: "usdtWallets" } as const;
const noSdk = () => undefined;
const events = () => ({ changed: vi.fn(), received: vi.fn() });
const lazy = (kind: Kind, network: WalletNetwork) => kind === "ark" ? lazyArkWallet(network, vi.fn()) : kind === "bark" ? lazyBarkWallet(network, vi.fn())
  : kind === "spark" ? lazySparkWallet(network, vi.fn()) : kind === "usdt" ? lazyUsdtWallet(network, vi.fn()) : lazyFedimintWallet(network, events(), noSdk);
const real = (kind: Kind, network: WalletNetwork) => kind === "fedimint" ? new FedimintWallet(network, events()) : new CLASSES[kind](network, vi.fn());
const arkRecord = { config: { network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api", serverKey: "k", walletId: "w-main" }, seed: { v: 1 }, deviceKey: "d" };
const fedimintRecord = { seed: { v: 1 }, deviceKey: "d", federations: [{ id: "f".repeat(64), database: "fm-1", invite: "fed11x", joinedAt: 1, name: "Test", modules: ["mint", "ln"], network: "signet" }] };
const nodeOf = () => new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: true });
/** What a call gave back, or what it threw: the same either way for the wallet and its stand-in. */
const outcome = async (call: () => unknown) => { try { return { value: await call() }; } catch (error) { return { error: (error as Error).message }; } };

beforeEach(async () => { await openDb(); await transact([STORES.settings], (s) => s[STORES.settings].clear()); });
afterEach(() => { vi.restoreAllMocks(); });

it("with no wallet saved, the engine's start and turn load none of the Ark, Bark, Fedimint, Spark and USDT classes", async () => {
  const starts = KINDS.map((kind) => vi.spyOn(CLASSES[kind].prototype, "start"));
  const node = nodeOf();
  for (const network of WALLET_NETWORKS) for (const kind of KINDS) await node[fields[kind]][network].start();
  for (const network of WALLET_NETWORKS) { node["openWallets"](network); await node["fedimintWallets"][network].ensureReady(); await node["usdtWallets"][network].ensureReady(); }
  await node["refreshNetwork"]({ method: "arkade", network: "bitcoin" } as never);
  await node["refreshWallet"]();
  for (const start of starts) expect(start).not.toHaveBeenCalled();
  for (const network of WALLET_NETWORKS) for (const kind of KINDS) expect(node[fields[kind]][network], `${kind} ${network}`).not.toBeInstanceOf(CLASSES[kind]);
  expect(node["walletView"].wallets?.filter((w) => w.type !== "cashu" && w.type !== "lightning" && w.type !== "bitcoin")).toEqual([]);
  expect(node["walletView"].networks?.mainnet.spark, "Mainnet Spark still says it needs a key").toMatchObject({ needsKey: true });
});

it("a saved wallet loads its class when the engine starts, and only that kind on that network", async () => {
  await transact([STORES.settings], (s) => { s[STORES.settings].put(arkRecord, "arkWallet-mode-mainnet"); s[STORES.settings].put(fedimintRecord, "fedimintWallet-testnet"); });
  const node = nodeOf();
  for (const network of WALLET_NETWORKS) for (const kind of KINDS) await node[fields[kind]][network].start();
  expect(node["arkWallets"].mainnet).toBeInstanceOf(ArkWallet);
  expect(node["arkWallets"].mainnet.view).toMatchObject({ configured: true, network: "bitcoin", provider: "https://arkade.computer" });
  expect(node["fedimintWallets"].testnet).toBeInstanceOf(FedimintWallet);
  expect(node["fedimintWallets"].testnet.federation("f".repeat(64))).toMatchObject({ name: "Test" });
  expect(node["fedimintOf"]("f".repeat(64)), "found on its network").toBe(node["fedimintWallets"].testnet);
  expect(node["arkWallets"].testnet).not.toBeInstanceOf(ArkWallet);
  expect(node["fedimintWallets"].mainnet).not.toBeInstanceOf(FedimintWallet);
  await node["refreshWallet"]();
  expect(node["walletView"].wallets?.map((w) => w.id).filter((id) => /^(arkade|fedimint):/.test(id))).toEqual(["arkade:mainnet", "fedimint:testnet"]);
});

for (const kind of KINDS) for (const network of WALLET_NETWORKS) {
  it(`${kind} ${network}: with none saved, it answers what the wallet itself would`, async () => {
    const stand = lazy(kind, network), wallet = real(kind, network);
    await stand.start(); await wallet.start();
    expect(stand).not.toBeInstanceOf(CLASSES[kind]);
    expect(stand.view).toEqual(wallet.view);
    expect(stand.configured).toBe(wallet.configured);
    expect(stand.network).toBe(wallet.network);
    expect("adapter" in wallet ? (stand as typeof wallet & { adapter?: unknown }).adapter : undefined).toBe((wallet as { adapter?: unknown }).adapter);
    // Every other sync answer and idle no-op: the same value or the same refusal.
    const asked = IDLE[kind];
    const call = (on: object, name: string) => () => (on as Record<string, (...a: unknown[]) => unknown>)[name]("f".repeat(64), "addr", 1);
    for (const name of asked) expect(await outcome(call(stand, name)), name).toEqual(await outcome(call(wallet, name)));
    expect(stand, "still not loaded").not.toBeInstanceOf(CLASSES[kind]);
    await wallet.stop();
  });
}

it("making one loads its class and makes it there; a spy set before stays on it", async () => {
  const made = vi.spyOn(ArkWallet.prototype, "createDefaultNow").mockResolvedValue(undefined);
  const stand = lazyArkWallet("testnet", vi.fn());
  await stand.start();
  const lock = vi.spyOn(stand, "lock");
  await stand.createDefaultNow();
  expect(made).toHaveBeenCalledOnce();
  expect(stand).toBeInstanceOf(ArkWallet);
  await stand.lock();
  expect(lock).toHaveBeenCalledOnce();
  await stand.stop();

  // The default one, asked for when it opens, loads it too.
  const ready = vi.spyOn(UsdtWallet.prototype, "ensureReady").mockResolvedValue(undefined);
  const usdt = lazyUsdtWallet("testnet", vi.fn());
  await usdt.start();
  await usdt.ensureReady();
  expect(ready, "nothing to open").not.toHaveBeenCalled();
  await usdt.ensureReady(true);
  expect(ready).toHaveBeenCalledWith(true);
  expect(usdt).toBeInstanceOf(UsdtWallet);
});
