import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import { BarkWallet } from "../src/engine/paymentAdapters/barkWallet";
import { SparkWallet } from "../src/engine/paymentAdapters/sparkWallet";
import { UsdtWallet } from "../src/engine/paymentAdapters/usdtWallet";
// covers: app.idle, wallet.ark.create, wallet.bark.create, wallet.spark.create, wallet.usdt.create, payments.chat.reconcile

/*
 * An Ark, Bark or Spark wallet reads its balance every 10 s, a USDT one every 8 s, for as long as the app runs. Each
 * read told the engine it changed, and the engine made the whole wallet view again (every review ever made read from
 * the store, every wallet's view, an engine state to the page) and checked the wallet's receipts: every few seconds
 * with nothing new. A read that says what the view already did is no news for the view (as #2280 made it for
 * Lightning cards); the receipts still waiting are checked after every read, as before.
 */

interface Polled { refresh(): Promise<void>; lock(): Promise<void> }
const money = { balance: 1_000 };

function wallets() {
  const ark = new ArkWallet("testnet", vi.fn());
  Object.assign(ark, { adapter: {
    config: { network: "regtest", provider: "http://127.0.0.1:43010" },
    address: async () => "tark1me", boardingAddress: async () => "bcrt1me", incoming: async () => 0,
    balance: async () => money.balance, expired: async () => ({ recoverable: 0, sweeping: 0 }), dispose: async () => {},
  } });
  const bark = new BarkWallet("testnet", vi.fn(), async () => { throw new Error("not opened here"); });
  Object.assign(bark, { adapter: {
    config: { network: "signet", provider: "http://127.0.0.1:43020" },
    address: async () => "tark1bark", onchainAddress: async () => "tb1bark", sync: async () => {},
    balance: async () => ({ spendableSats: money.balance, pendingInRoundSats: 0, pendingBoardSats: 0, pendingLightningSendSats: 0, claimableLightningReceiveSats: 0, pendingExitSats: 0 }),
    onchainBalance: async () => ({ totalSats: 0 }), expiry: async () => ({ soonest: null }), maintain: async () => {}, dispose: async () => {},
  } });
  const spark = new SparkWallet("testnet", vi.fn(), async () => { throw new Error("not opened here"); });
  Object.assign(spark, { adapter: {
    address: async () => "sparkrt1me", balance: async () => money.balance,
    history: async () => [{ id: "p1", direction: "in", amount: 1_000, fee: 0, status: "completed", createdAt: 1 }], close: async () => {},
  } });
  const usdt = new UsdtWallet("testnet", vi.fn());
  Object.assign(usdt, { adapter: {
    config: { network: "sepolia", chainId: 11155111, provider: "http://127.0.0.1:8545", token: "0x1111111111111111111111111111111111111111", decimals: 6 },
    address: async () => "0xme", balances: async () => ({ balance: String(money.balance), gasBalance: "0" }), dispose: async () => {},
  } });
  return { ark, bark, spark, usdt } as Record<string, Polled & { changed: ReturnType<typeof vi.fn> }>;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); money.balance = 1_000; });
afterEach(() => { vi.useRealTimers(); });

it.each(["ark", "bark", "spark", "usdt"])("%s: a balance read that finds nothing new says so; a moved balance changes the view", async (kind) => {
  const wallet = wallets()[kind];
  const changed = (wallet as unknown as { changed: ReturnType<typeof vi.fn> }).changed;
  await wallet.refresh();
  changed.mockClear();
  await wallet.refresh();
  await wallet.refresh();
  expect(changed.mock.calls, "two reads with nothing new").toEqual([[false], [false]]);
  money.balance += 21;
  changed.mockClear();
  await wallet.refresh();
  expect(changed.mock.calls).toEqual([[true]]);
  await wallet.lock();
});

it.each(["ark", "bark", "spark", "usdt"] as const)("%s: the engine checks the receipts after every read, and makes the wallet view again only when it changed", async (kind) => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false });
  const refresh = vi.spyOn(node as unknown as { refreshWallet(): Promise<void> }, "refreshWallet").mockResolvedValue();
  const desk = node["desk"] as unknown as Record<string, () => Promise<void>>;
  const receipts = vi.spyOn(desk, `reconcile${{ ark: "Ark", bark: "Bark", spark: "Spark", usdt: "Usdt" }[kind]}Receipts`).mockResolvedValue();
  const wallet = (node as unknown as Record<string, { testnet: { changed(viewChanged?: boolean): void } }>)[`${kind}Wallets`].testnet;
  wallet.changed(false);
  expect(refresh).not.toHaveBeenCalled();
  expect(receipts).toHaveBeenCalledTimes(1);
  wallet.changed(true);
  wallet.changed();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(receipts).toHaveBeenCalledTimes(3);
  await node.shutdown();
});
