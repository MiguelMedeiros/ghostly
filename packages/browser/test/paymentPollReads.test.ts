import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ONCHAIN_PROVIDER, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { cashuMint } from "../src/engine/paymentAdapters/providers/cashuMint";
import { FakeLightningProvider, FakeOnchainProvider, fakeAddress, fakeLightning, fakeOnchain } from "../src/engine/paymentAdapters/providers/testing";
// covers: payments.chat.reconcile

/**
 * The payment poll runs every 10 s for as long as the app does, and wants only the reviews whose outcome is still
 * open (submitted, unknown): it reads those, not every review the profile ever made. On real IndexedDB semantics.
 */
const SETTLED = 1_000;

function review(overrides: Partial<PaymentReview> = {}): PaymentReview {
  return { id: crypto.randomUUID(), linkId: "chat", payee: "peer", amount: 10, fee: 2, feeCap: 2, state: "settled", createdAt: Date.now(),
    expiresAt: Date.now() + 60_000, method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "request", asset: "BTC", unit: "sat", ...overrides } as PaymentReview;
}
const bitcoinTarget = (): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address: fakeAddress(), expiresAt: Date.now() + 60_000 });

/** A Testnet engine with the fake on-chain wallet as its Bitcoin source: its answer to a broadcast never comes. */
async function engine() {
  const onchain = new FakeOnchainProvider({ behaviour: "hang" });
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false, providers: {
    lightning: [cashuMint, { ...fakeLightning, create: async () => new FakeLightningProvider({ settleMs: 60_000 }) }],
    onchain: [{ ...fakeOnchain, create: async () => onchain }],
  } });
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  nodes.push(node);
  await node.bitcoinSetSource({ providerId: "fake-onchain", values: { token: "chain-secret-token" }, network: "testnet" });
  return node;
}

/** How many review rows a call reads: a whole-store read counts every row, a cursor one per step, a `get` its row. */
async function reads(work: () => Promise<unknown>): Promise<number> {
  let read = 0;
  const spies = [];
  const onIntents = (source: IDBObjectStore | IDBIndex) => ("objectStore" in source ? source.objectStore : source).name === STORES.intents;
  for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype]) {
    const getAll = proto.getAll;
    spies.push(vi.spyOn(proto, "getAll").mockImplementation(function (this: IDBObjectStore & IDBIndex, ...args: Parameters<IDBObjectStore["getAll"]>) {
      const request = getAll.apply(this, args);
      if (onIntents(this)) request.addEventListener("success", () => { read += (request.result as unknown[]).length; });
      return request;
    }));
    const openCursor = proto.openCursor;
    spies.push(vi.spyOn(proto, "openCursor").mockImplementation(function (this: IDBObjectStore & IDBIndex, ...args: Parameters<IDBObjectStore["openCursor"]>) {
      const request = openCursor.apply(this, args);
      if (onIntents(this)) request.addEventListener("success", () => { if (request.result) read++; });
      return request;
    }));
    const get = proto.get;
    spies.push(vi.spyOn(proto, "get").mockImplementation(function (this: IDBObjectStore & IDBIndex, ...args: Parameters<IDBObjectStore["get"]>) {
      const request = get.apply(this, args);
      if (onIntents(this)) request.addEventListener("success", () => { if (request.result) read++; });
      return request;
    }));
  }
  try { await work(); return read; } finally { for (const spy of spies) spy.mockRestore(); }
}

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => {
    s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear();
    for (let i = 0; i < SETTLED; i++) s[STORES.intents].put({ review: review(), prepared: {} });
  });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

it("a round of the payment poll reads the one review still open, not the 1,000 settled ones", async () => {
  const node = await engine();
  const open = await node.preparePayment({ target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "someone" });
  expect(await node.approvePayment({ id: open.id })).toMatchObject({ state: "unknown" });
  await node["refreshWallet"]();
  // The poll's own reads: what reconciling one payment reads and writes is that payment's.
  const reconcile = vi.spyOn(node, "reconcilePayment").mockImplementation(async () => open);

  const read = await reads(() => node["pollPaymentStatus"]());
  expect(reconcile.mock.calls.map(([p]) => p.id)).toEqual([open.id]);
  expect(read, "the poll reads the open review").toBe(1);

  // Once it settled, the next rounds have nothing to ask about.
  reconcile.mockRestore();
  await node["pollPaymentStatus"]();
  expect((await intentRepository.get(open.id))?.review.state).toBe("settled");
  const again = vi.spyOn(node, "reconcilePayment");
  expect(await reads(() => node["pollPaymentStatus"]())).toBeLessThanOrEqual(1);
  expect(await reads(() => node["pollPaymentStatus"]())).toBe(0);
  expect(again).not.toHaveBeenCalled();
});

// The stale-review sweep runs every minute for as long as the app does: it wants the pending reviews (an Approve may
// still send them), not every review ever made with its prepared swap.
it("a minute's stale-review sweep reads the pending reviews, not the 1,000 settled ones", async () => {
  const node = await engine();
  await node.dropStaleReviews();
  const pending = await node.preparePayment({ target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "someone" });

  expect(await reads(() => node.dropStaleReviews()), "the sweep reads the pending review").toBe(1);
  // Past its expiry it is cancelled, and the next sweeps have nothing to look at.
  expect((await node.dropStaleReviews(pending.expiresAt + 1)).map((r) => r.id)).toEqual([pending.id]);
  expect(await reads(() => node.dropStaleReviews(pending.expiresAt + 1))).toBe(0);
});

it("a pending review left by an earlier run is swept by the first round", async () => {
  const left = review({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, state: "pending", expiresAt: Date.now() - 1 });
  await intentRepository.put({ review: left, prepared: {} });
  const node = await engine();
  expect((await node.dropStaleReviews()).map((r) => r.id)).toEqual([left.id]);
});

it("a review left open by an earlier run is found by the first round", async () => {
  const left = review({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, state: "unknown" });
  await intentRepository.put({ review: left, prepared: {} });
  const node = await engine();
  const reconcile = vi.spyOn(node, "reconcilePayment").mockImplementation(async () => left);
  await node["pollPaymentStatus"]();
  expect(reconcile.mock.calls.map(([p]) => p.id)).toEqual([left.id]);
});

it("a review a wallet's restore wrote itself is polled from the next wallet change on", async () => {
  const node = await engine();
  const reconcile = vi.spyOn(node, "reconcilePayment").mockImplementation(async (p) => review({ id: p.id }));
  await node["pollPaymentStatus"]();
  expect(reconcile).not.toHaveBeenCalled();

  // As a wallet's backup restores its payments: straight into the store, each open one as unknown.
  const restored = review({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, state: "unknown" });
  await transact([STORES.intents], (s) => { s[STORES.intents].add({ review: restored, prepared: {} }); });
  await node["refreshWallet"]();
  await node["pollPaymentStatus"]();
  expect(reconcile.mock.calls.map(([p]) => p.id)).toEqual([restored.id]);
});
