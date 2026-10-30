import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaymentReview } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
// covers: wallet.cashu.mint.manage, wallet.instances.networks

/**
 * A start refreshed the wallets' view once for every wallet that said it changed while it opened (11 times in the
 * first 3 s), each refresh reading the whole Cashu proofs store once per network and every payment review ever made:
 * with 5,000 proofs a start read the store 27-29 times, 7 of them before the chat list could show. Refreshes asked
 * for while one runs now share one more run after it, and a refresh reads the proofs once for both networks.
 */
const PROOFS = 500;
const REVIEWS = 200;

function review(): PaymentReview {
  return { id: crypto.randomUUID(), linkId: "chat", payee: "peer", amount: 10, fee: 2, feeCap: 2, state: "settled", createdAt: Date.now(),
    expiresAt: Date.now() + 60_000, method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "request", asset: "BTC", unit: "sat" } as PaymentReview;
}

/** Whole-store reads of the proofs and the reviews while `work` runs. */
async function wholeReads(work: () => Promise<unknown>): Promise<{ proofs: number; intents: number }> {
  const counts = { proofs: 0, intents: 0 };
  const getAll = IDBObjectStore.prototype.getAll;
  const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
    if (this.name === STORES.proofs) counts.proofs++;
    if (this.name === STORES.intents && args[0] === undefined) counts.intents++;
    return getAll.apply(this, args);
  });
  try { await work(); return counts; } finally { spy.mockRestore(); }
}

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
beforeEach(async () => {
  await transact([STORES.settings, STORES.proofs, STORES.intents], (s) => {
    s[STORES.settings].clear(); s[STORES.proofs].clear(); s[STORES.intents].clear();
    for (let i = 0; i < PROOFS; i++) s[STORES.proofs].put({ mint: TEST_MINT, id: "00ad268c4d1f5826", amount: 1, secret: `secret-${i}`, C: "02" + "ab".repeat(32) });
    for (let i = 0; i < REVIEWS; i++) s[STORES.intents].put({ review: review(), prepared: {} });
  });
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [TEST_MINT], mintsInitialized: true });
  // Nothing leaves the process: the mint, the providers and the wallets' SDKs are refused.
  vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
});
afterEach(async () => { await node?.shutdown(); node = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("a start reads the proofs and the payment reviews a few times, not once per wallet that opened", async () => {
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, nativeTransports: {} });
  const started = node;
  const reads = await wholeReads(async () => {
    await started.start();
    // The wallets that open after the start say so within the first seconds.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  });
  console.log(`START READS: proofs ${reads.proofs}, reviews ${reads.intents}`);
  // The balance still comes from the proofs, and the Cashu Lightning source shows the same.
  expect(started.getState().wallet.networks?.testnet.balance).toBe(PROOFS);
  expect(started.getState().wallet.networks?.testnet.lightning.balance).toBe(PROOFS);
  // The Cashu Lightning source's balance, read as its cards open, read the whole proofs store 4-5 more times: it is
  // the wallets' last view now.
  expect(reads.proofs, "whole reads of the proofs store").toBeLessThanOrEqual(3);
  expect(reads.intents, "whole reads of the payment reviews").toBeLessThanOrEqual(3);
}, 20_000);

it("refreshes asked for while one runs share one more run, which sees what changed meanwhile", async () => {
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  const engine = node as unknown as { settings: object; refreshWallet(): Promise<void>; refreshWalletNow(): Promise<void> };
  // The saved settings with the test mint, as a start reads them, without the wallets a start opens.
  engine.settings = { ...engine.settings, ...await db.getSettings() };
  await engine.refreshWallet();
  expect(node.getState().wallet.networks?.testnet.balance).toBe(PROOFS);
  const runs = vi.spyOn(engine, "refreshWalletNow");
  const first = engine.refreshWallet();
  // Written after the first run began: the callers after it wait for a view that has it.
  await transact([STORES.proofs], (s) => { s[STORES.proofs].put({ mint: TEST_MINT, id: "00ad268c4d1f5826", amount: 21, secret: "late", C: "02" + "cd".repeat(32) }); });
  const later = [engine.refreshWallet(), engine.refreshWallet(), engine.refreshWallet()];
  await Promise.all([first, ...later]);
  expect(runs).toHaveBeenCalledTimes(2);
  expect(node.getState().wallet.networks?.testnet.balance).toBe(PROOFS + 21);
});
