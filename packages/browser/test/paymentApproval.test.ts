import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
// covers: payments.chat.review, payments.chat.reconcile

it("does not execute a saved review after its request has already settled", async () => {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  const link = { requirePaymentSupport: vi.fn().mockResolvedValue(undefined), allowsPayment: vi.fn(() => true) };
  vi.spyOn(node["links"], "get").mockReturnValue({ link } as never);
  vi.spyOn(node["desk"], "payment").mockReturnValue({ state: "settled" } as never);
  const execute = vi.spyOn(node["paymentCoordinator"], "approve");
  const id = crypto.randomUUID();
  await intentRepository.put({ review: {
    id, requestId: "request", linkId: "chat", payee: "peer", amount: 10, fee: 2, feeCap: 2,
    state: "pending", createdAt: Date.now(), expiresAt: Date.now() + 60000,
    method: "cashu", network: "cashu-test", provider: "https://testnut.cashu.space",
    address: "request", asset: "BTC", unit: "sat",
  }, prepared: {} });
  await expect(node.approvePayment({ id })).rejects.toThrow("no longer awaiting payment");
  expect(execute).not.toHaveBeenCalled();
  expect((await intentRepository.get(id))?.review.state).toBe("pending");
});
