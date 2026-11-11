import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaymentReview } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import type { PaymentLink } from "../src/engine/payments";
import type { StoredPayment } from "../src/shared/types";
// covers: payments.chat.reconcile

/**
 * A chat's Cashu payment whose contact is online and does not redeem it (its mint swap keeps failing). The payment poll
 * reconciled each one every 10 s for as long as the app ran: two checkstates at the mint and the same token sent again
 * each time, 12 mint calls a minute for every such payment, forever. Now each is asked at 10 s while new, then twice as
 * late up to 10 min, once a round; its token goes again only when the chat's link opened again since it went.
 */
const PAYMENTS = 5, MINUTE = 60_000, ROUND = 10_000;

const nodes: GhostlyNode[] = [];
afterEach(async () => { vi.useRealTimers(); for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });
beforeEach(async () => {
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});

async function setup() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false });
  nodes.push(node);
  const wallet = node["wallet"];
  vi.spyOn(wallet, "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  // Each ask of the mint whether the ecash sent is spent is one checkstate: never, the contact does not redeem.
  const checkstates = vi.spyOn(wallet, "reviewedCashuSpent").mockResolvedValue(false);
  // The contact is online: every frame goes.
  const sendPayment = vi.fn(async () => {});
  const link = { supportsPayments: true, requirePaymentSupport: async () => {}, sendPayment, sendPaymentResult: vi.fn() } as unknown as PaymentLink;
  const host = node["desk"]["host"];
  vi.spyOn(host, "getLink").mockReturnValue(link);
  vi.spyOn(host, "storeMessage").mockResolvedValue();
  for (let i = 0; i < PAYMENTS; i++) {
    const now = Date.now(), id = crypto.randomUUID();
    const review = { id, linkId: "chat", payee: "peer", amount: 10, fee: 0, feeCap: 2, state: "submitted", createdAt: now, submittedAt: now, expiresAt: now + MINUTE,
      method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "request", asset: "BTC", unit: "sat" } as PaymentReview;
    const token = `cashuBtoken${i}`;
    await intentRepository.put({ review, prepared: { mint: TEST_MINT, swap: {}, token } });
    const payment: StoredPayment = { id, linkId: "chat", kind: "payment", direction: "out", amount: 10, unit: "sat", state: "pending", createdAt: now, mint: TEST_MINT, token, target: review };
    await transact([STORES.payments], (s) => { s[STORES.payments].put(payment); });
  }
  return { node, checkstates, sendPayment };
}

/** The poll's rounds, one every 10 s for `minutes`: the checkstates of each minute. */
async function rounds(node: GhostlyNode, checkstates: { mock: { calls: unknown[] } }, minutes: number): Promise<number[]> {
  const perMinute: number[] = [];
  for (let m = 0; m < minutes; m++) {
    const before = checkstates.mock.calls.length;
    for (let r = 0; r < MINUTE / ROUND; r++) { await node["pollPaymentStatus"](); vi.setSystemTime(Date.now() + ROUND); }
    perMinute.push(checkstates.mock.calls.length - before);
  }
  return perMinute;
}

it("five payments a contact online does not redeem are asked about less and less, down to one ask in 10 min each", async () => {
  const { node, checkstates, sendPayment } = await setup();
  const perMinute = await rounds(node, checkstates, 30);
  // The first minute at 10 s, then backing off: never the flat 60 a minute of a fixed 10 s pace with two asks a round.
  expect(perMinute[0]).toBeLessThanOrEqual(PAYMENTS * 6);
  expect(Math.max(...perMinute.slice(1))).toBeLessThan(PAYMENTS * 6);
  // In the last 10 min, each is asked about once or twice: its pace reached the cap.
  const last10 = perMinute.slice(20).reduce((a, b) => a + b, 0);
  expect(last10).toBeGreaterThanOrEqual(PAYMENTS);
  expect(last10).toBeLessThanOrEqual(PAYMENTS * 2);
  // Each token went once: the contact is online and the link never closed.
  expect(sendPayment).toHaveBeenCalledTimes(PAYMENTS);
});

it("the link opening again sends each token once more", async () => {
  const { node, checkstates, sendPayment } = await setup();
  await rounds(node, checkstates, 2);
  expect(sendPayment).toHaveBeenCalledTimes(PAYMENTS);
  // The chat's link opened again: what was in flight on the old one goes once on the new.
  await node["desk"].replay("chat");
  expect(sendPayment).toHaveBeenCalledTimes(PAYMENTS * 2);
  await rounds(node, checkstates, 10);
  expect(sendPayment).toHaveBeenCalledTimes(PAYMENTS * 2);
});
