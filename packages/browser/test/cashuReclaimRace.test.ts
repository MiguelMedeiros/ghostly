import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, engineText, type PaymentAdapter, type PaymentReview } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import type { CashuPrepared, CashuWallet } from "../src/engine/wallet";
import type { StoredLink, StoredPayment } from "../src/shared/types";
// covers: payments.cashu.reclaim, payments.chat.reconcile

/**
 * A reviewed Cashu payment to a contact's request, its token out and not taken, while the payer taps Take it back.
 * The mint reads ecash this wallet takes back as spent too: a status check (the poll, or the contact's result frame)
 * that reads it while the take-back is at the mint must not take that for the contact being paid, and one waiting on
 * the chat after a restart must not send the contact a token already taken back.
 */
const TAKEN_BACK = engineText("paymentTakenBack");

function stubLink(overrides: Record<string, unknown> = {}) {
  return {
    requirePaymentSupport: vi.fn(async () => {}),
    allowsPayment: vi.fn(() => true),
    paymentEnabled: vi.fn(() => true),
    isDataLinkOpen: true,
    sendPayment: vi.fn(async () => {}),
    sendPaymentRequest: vi.fn(async () => {}),
    sendPaymentResult: vi.fn(),
    stop: vi.fn(async () => {}), depart: vi.fn(),
    ...overrides,
  };
}

/** A hand-released gate: what the fake mint or the chat waits on. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

async function setup(link = stubLink()) {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false });
  nodes.push(node);
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  const chat: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
  node["links"].set(chat.id, { stored: chat, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
  const review: PaymentReview = { id: crypto.randomUUID(), linkId: chat.id, requestId: "req-1", payee: "peer", amount: 10, fee: 2, feeCap: 2, state: "submitted",
    createdAt: Date.now(), submittedAt: Date.now(), expiresAt: Date.now() + 60_000, method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "req-1", asset: "BTC", unit: "sat" } as PaymentReview;
  await intentRepository.put({ review, prepared: { mint: TEST_MINT, swap: {}, token: "cashuBtoken" } as unknown as CashuPrepared });
  // The contact's request, open, and the payment that went out for it: in the store and in the desk, as after a send.
  const request: StoredPayment = { id: "req-1", linkId: chat.id, kind: "request", direction: "in", amount: 10, unit: "sat", state: "pending", createdAt: 1, mint: TEST_MINT };
  const payment: StoredPayment = { id: review.id, linkId: chat.id, kind: "payment", direction: "out", amount: 10, unit: "sat", state: "pending", createdAt: review.createdAt,
    token: "cashuBtoken", mint: TEST_MINT, requestId: "req-1", target: review };
  await transact([STORES.payments], (s) => { s[STORES.payments].put(request); s[STORES.payments].put(payment); });
  node["desk"]["payments"].set(request.id, request);
  node["desk"]["payments"].set(payment.id, payment);
  const wallet = node["wallet"];
  // The fake mint: the ecash reads spent once a swap of it went through, whoever made that swap.
  const mint = { spent: false };
  vi.spyOn(wallet, "reviewedCashuSpent").mockImplementation(async () => mint.spent);
  return { node, events, link, review, payment, wallet, mint };
}

/** Take it back whose swap the mint has made (its inputs read spent) while its answer is held until `answer.open()`. */
function heldTakeBack(wallet: CashuWallet, mint: { spent: boolean }, outcome: "back" | "spentByContact") {
  const answer = gate();
  const redeem = vi.spyOn(wallet, "receiveToken").mockImplementation(async (_token, _kind, _memo, options) => {
    if (outcome === "spentByContact") { await answer.opened; throw new Error("Token already spent"); }
    mint.spent = true;
    await answer.opened;
    // The real wallet writes the payment's record in the same transaction as the ecash that came back.
    const record = options!.payment!(9, TEST_MINT);
    await transact([STORES.payments], (s) => { s[STORES.payments].put(record); });
    return { amount: 9, mint: TEST_MINT, fee: 0 };
  });
  return { answer, redeem };
}

const confirmed = (events: { onAttention: ReturnType<typeof vi.fn> }) => events.onAttention.mock.calls.filter(([e]) => (e as { type: string }).type === "confirmed");
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("Take it back racing a status check of the same payment", () => {
  it("a check while the take-back is at the mint leaves the request open, the payment taken back, and plays no paid sound", async () => {
    const { node, events, review, payment, wallet, mint } = await setup();
    const { answer, redeem } = heldTakeBack(wallet, mint, "back");
    const reclaim = node.reclaimPayment({ paymentId: payment.id });
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
    expect(mint.spent, "the mint has swapped the ecash: it reads spent").toBe(true);
    // The poll's round, or the contact's result frame, now.
    const check = node.reconcilePayment({ id: review.id });
    await tick();
    answer.open();
    await reclaim;
    const after = await check;
    expect(confirmed(events), "no paid sound or feedback for ecash we took back").toEqual([]);
    expect(node["desk"].payment("req-1")?.state, "the contact's request is still open").toBe("pending");
    expect(after).toMatchObject({ state: "failed", error: TAKEN_BACK });
    expect(node["desk"].payment(payment.id)).toMatchObject({ state: "reclaimed" });
    expect((await intentRepository.get(review.id))?.review).toMatchObject({ state: "failed", error: TAKEN_BACK });
  });

  it("a check after a restart waiting on the chat sends nothing once the payment was taken back, and reads taken back at once", async () => {
    const chatUp = gate();
    const link = stubLink({ requirePaymentSupport: vi.fn(() => chatUp.opened) });
    const { node, review, payment, wallet, mint } = await setup(link);
    const { answer } = heldTakeBack(wallet, mint, "back");
    answer.open();
    // The first check of this run re-sends the token, and waits for the chat to connect first.
    const check = node.reconcilePayment({ id: review.id });
    await vi.waitFor(() => expect(link.requirePaymentSupport).toHaveBeenCalledOnce());
    await node.reclaimPayment({ paymentId: payment.id });
    expect((await intentRepository.get(review.id))?.review).toMatchObject({ state: "failed", error: TAKEN_BACK });
    chatUp.open();
    const after = await check;
    expect(link.sendPayment, "the token taken back never goes to the contact").not.toHaveBeenCalled();
    expect(after).toMatchObject({ state: "failed", error: TAKEN_BACK });
    expect((await intentRepository.get(review.id))?.review, "the check's older copy does not overwrite it").toMatchObject({ state: "failed", error: TAKEN_BACK });
    expect(node["desk"].payment("req-1")?.state).toBe("pending");
  });

  it("the contact redeemed first: a check reads it paid, and Take it back afterwards is refused", async () => {
    const { node, events, review, payment, wallet, mint } = await setup();
    mint.spent = true;
    const redeem = vi.spyOn(wallet, "receiveToken");
    expect(await node.reconcilePayment({ id: review.id })).toMatchObject({ state: "settled" });
    await expect(node.reclaimPayment({ paymentId: payment.id })).rejects.toThrow("Nothing to reclaim");
    expect(redeem).not.toHaveBeenCalled();
    expect(node["desk"].payment(payment.id)?.state).toBe("settled");
    expect(node["desk"].payment("req-1")?.state).toBe("settled");
    expect((await intentRepository.get(review.id))?.review.state).toBe("settled");
    expect(confirmed(events)).toHaveLength(1);
  });

  it("the contact redeemed first while Take it back was at the mint: the check waits for it and both end paid", async () => {
    const { node, review, payment, wallet, mint } = await setup();
    mint.spent = true;
    const { answer, redeem } = heldTakeBack(wallet, mint, "spentByContact");
    const reclaim = node.reclaimPayment({ paymentId: payment.id });
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
    const check = node.reconcilePayment({ id: review.id });
    await tick();
    answer.open();
    await reclaim;
    expect(await check).toMatchObject({ state: "settled" });
    expect(node["desk"].payment(payment.id)?.state).toBe("settled");
    expect(node["desk"].payment("req-1")?.state).toBe("settled");
    expect((await intentRepository.get(review.id))?.review.state).toBe("settled");
  });
});

describe("a status check's own write", () => {
  it("does not overwrite a review that Take it back ended while the check was out", async () => {
    const answered = gate();
    const adapter: PaymentAdapter = { method: "cashu", prepare: vi.fn(), execute: vi.fn(),
      reconcile: vi.fn(async () => { await answered.opened; return { settled: false }; }) } as unknown as PaymentAdapter;
    const changed = vi.fn();
    const coordinator = new PaymentCoordinator(intentRepository, [adapter], changed);
    const review = { id: crypto.randomUUID(), linkId: "chat", payee: "peer", amount: 10, fee: 2, feeCap: 2, state: "submitted", createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "req-1", asset: "BTC", unit: "sat" } as PaymentReview;
    await intentRepository.put({ review, prepared: {} });
    const check = coordinator.reconcile(review.id);
    await vi.waitFor(() => expect(adapter.reconcile).toHaveBeenCalledOnce());
    // As `reviewTakenBack` writes it, outside the coordinator's lock.
    await intentRepository.put({ review: { ...review, state: "failed", error: TAKEN_BACK }, prepared: {} });
    answered.open();
    expect(await check).toMatchObject({ state: "failed", error: TAKEN_BACK });
    expect((await intentRepository.get(review.id))?.review).toMatchObject({ state: "failed", error: TAKEN_BACK });
    expect(changed).not.toHaveBeenCalled();
  });
});
