import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ONCHAIN_PROVIDER, type PaymentTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { FakeOnchainProvider, fakeAddress, fakeOnchain } from "../src/engine/paymentAdapters/providers/testing";
// covers: payments.chat.reconcile

/**
 * An on-chain payment sent and not confirmed yet (a low fee in a full mempool can wait hours or days). The payment poll
 * asked its Bitcoin source about it every 10 s for as long as it stayed so, 360 reads an hour, and each round also read
 * the Ark, Bark, Spark and USDT wallets again: only a Cashu payment's asks grew further apart. Now every open payment is
 * asked at 10 s for its first minute, then twice as late after each answer that changes nothing, up to 10 min.
 */
const MINUTE = 60_000, ROUND = 10_000;

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});
afterEach(async () => { vi.useRealTimers(); for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

const target = (): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address: fakeAddress(), expiresAt: Date.now() + MINUTE });

/** A Testnet engine whose Bitcoin source has broadcast one payment that sits in the mempool. */
async function setup() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const onchain = new FakeOnchainProvider();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false, providers: {
    onchain: [{ ...fakeOnchain, create: async () => onchain }],
  } });
  nodes.push(node);
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  await node.bitcoinSetSource({ providerId: "fake-onchain", values: { token: "chain-secret-token" }, network: "testnet" });
  const status = vi.spyOn(onchain, "status").mockResolvedValue({ state: "mempool", confirmations: 0 });
  const open = await node.preparePayment({ target: target(), amount: 1_000, feeCap: 1_000, payee: "someone" });
  expect(await node.approvePayment({ id: open.id })).toMatchObject({ state: "submitted" });
  const refreshes = vi.spyOn(node["usdtWallets"].testnet, "refresh");
  return { node, status, refreshes };
}

/** The poll's rounds, one every 10 s for `minutes`: the source's reads of each minute. */
async function rounds(node: GhostlyNode, asked: { mock: { calls: unknown[] } }, minutes: number): Promise<number[]> {
  const perMinute: number[] = [];
  for (let m = 0; m < minutes; m++) {
    const before = asked.mock.calls.length;
    for (let r = 0; r < MINUTE / ROUND; r++) { await node["pollPaymentStatus"](); vi.setSystemTime(Date.now() + ROUND); }
    perMinute.push(asked.mock.calls.length - before);
  }
  return perMinute;
}

it("an on-chain payment waiting in the mempool is asked about less and less, down to once in 10 min", async () => {
  const { node, status, refreshes } = await setup();
  const perMinute = await rounds(node, status, 30);
  // The first minute at 10 s, then backing off: never the flat 6 a minute of a fixed 10 s pace.
  expect(perMinute[0]).toBeLessThanOrEqual(6);
  expect(perMinute.slice(1).every((n) => n < 6), JSON.stringify(perMinute)).toBe(true);
  const last10 = perMinute.slice(20).reduce((a, b) => a + b, 0);
  expect(last10).toBeGreaterThanOrEqual(1);
  expect(last10).toBeLessThanOrEqual(2);
  // The other wallets of the network are read again with each ask, no more.
  expect(refreshes.mock.calls.length).toBeLessThanOrEqual(status.mock.calls.length);
});

it("a payment confirmed meanwhile is settled at its next ask and asked about no more", async () => {
  const { node, status } = await setup();
  await rounds(node, status, 3);
  status.mockResolvedValue({ state: "confirmed", confirmations: 1 });
  await rounds(node, status, 10);
  const asked = status.mock.calls.length;
  await rounds(node, status, 5);
  expect(status.mock.calls.length).toBe(asked);
});
