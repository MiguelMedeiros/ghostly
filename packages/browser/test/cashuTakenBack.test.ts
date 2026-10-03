import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineText, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { CashuWallet, type CashuPrepared } from "../src/engine/wallet";
import { CashuAdapter } from "../src/engine/paymentAdapters/cashu";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { STORES, transact } from "../src/shared/idb";
import type { StoredPayment } from "../src/shared/types";
// covers: payments.chat.reconcile, payments.cashu.reclaim

/**
 * A reviewed Cashu payment whose ecash was taken back (Take it back, or a contact's refusal). The mint reads that ecash
 * spent, because this wallet redeemed it: the review took that for the contact being paid and ended "settled", and a
 * request whose review reads paid could never be reviewed again ("This request already has a payment").
 */
const MINT = "https://mint.example";
const target: PaymentTarget = { method: "cashu", network: "bitcoin", provider: MINT, asset: "BTC", unit: "sat", address: "req-1", expiresAt: Date.now() + 3_600_000 };
const context = { payee: "alice", linkId: "chat-1", requestId: "req-1" };
const prepared = { mint: MINT, swap: {}, token: "cashuBtoken" } as unknown as CashuPrepared;

function setup() {
  const wallet = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() });
  const publish = vi.fn(async () => {});
  const adapter = new CashuAdapter(wallet, publish);
  // The mint's word on the ecash sent: spent, whoever redeemed it.
  vi.spyOn(wallet, "reviewedCashuSpent").mockResolvedValue(true);
  vi.spyOn(wallet, "prepareReviewedCashu").mockResolvedValue({ fee: 2, prepared });
  return { wallet, adapter, publish, coordinator: new PaymentCoordinator(intentRepository, [adapter]) };
}

/** The review as it stands once its token went out, and the payment the chat shows for it. */
async function sent(coordinator: PaymentCoordinator, state: StoredPayment["state"]): Promise<PaymentReview> {
  const review = await coordinator.prepare(target, 40, 10, context);
  await intentRepository.put({ review: { ...review, state: "submitted", submittedAt: Date.now() }, prepared });
  const payment: StoredPayment = { id: review.id, linkId: "chat-1", kind: "payment", direction: "out", amount: 40, unit: "sat", state, createdAt: review.createdAt, mint: MINT, requestId: "req-1", target: review };
  await transact([STORES.payments], (s) => { s[STORES.payments].put(payment); });
  return review;
}

beforeEach(async () => {
  await transact([STORES.intents, STORES.payments], (s) => { s[STORES.intents].clear(); s[STORES.payments].clear(); });
});

describe("a reviewed Cashu payment whose ecash was taken back", () => {
  it("ends failed, not paid, and its token is not offered to the contact again", async () => {
    const { coordinator, publish } = setup();
    const review = await sent(coordinator, "reclaimed");
    expect(await coordinator.reconcile(review.id)).toMatchObject({ state: "failed", error: engineText("paymentTakenBack") });
    expect(publish).not.toHaveBeenCalled();
  });

  it("leaves its request free to be reviewed and paid again", async () => {
    const { coordinator } = setup();
    const review = await sent(coordinator, "reclaimed");
    await coordinator.reconcile(review.id);
    await expect(coordinator.prepare(target, 40, 10, context)).resolves.toMatchObject({ state: "pending", requestId: "req-1" });
  });

  it("still settles when the contact is the one who took the ecash", async () => {
    const { coordinator } = setup();
    const review = await sent(coordinator, "pending");
    expect(await coordinator.reconcile(review.id)).toMatchObject({ state: "settled" });
    await expect(coordinator.prepare(target, 40, 10, context)).rejects.toThrow(engineText("requestHasPayment"));
  });
});
