import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { chatViewOf } from "./support/chatView";
// covers: headless.wallets, headless.identities

/**
 * `chat pay`, `pay --chat`, `chat pay-request` and `identity withdraw` move money or take a proof back: as `service share`,
 * `group invite` and `identity share`, they name their chat by the chat's id, its contact's key or this side's label,
 * never only by what the contact chose (a prefix of the id, the name it gave itself). Before, `chat pay bob 1000` paid
 * whichever contact called itself "bob" when no chat had that label.
 */
const KEY = "y".repeat(52);
const INVOICE = "lntbs10n1qqqqqq";
function fake() {
  const links = [
    { id: "chat-real-alice", label: "Alice", peerNick: "alice", peerPubKeyZ32: "o".repeat(51) + "y", profile: "paired-chat/1", identities: { support: true, shared: [{ id: "proof-1" }], received: [] } },
    { id: "chat-mallory", label: null, peerNick: "Bob", peerPubKeyZ32: KEY, profile: "paired-chat/1", identities: { support: true, shared: [{ id: "proof-1" }], received: [] } },
  ] as unknown as LinkView[];
  const payments = {
    "req-alice": { id: "req-alice", linkId: "chat-real-alice", kind: "request", network: "testnet", amount: 10, status: "pending", direction: "in", createdAt: 1 },
    "req-mallory": { id: "req-mallory", linkId: "chat-mallory", kind: "request", network: "testnet", amount: 10, status: "pending", direction: "in", createdAt: 1 },
  };
  const node = {
    chatView: chatViewOf, getState: () => ({ links, groups: [], payments, settings: {}, transport: {}, identityProofs: [{ id: "proof-1" }], wallet: { wallets: [], networks: {} } }) as unknown as EngineState,
    sendPayment: vi.fn(async () => ({ paymentId: "pay-1" })),
    payRequest: vi.fn(async () => {}),
    walletQuoteInvoice: vi.fn(async () => ({ quote: "q", mint: "m", amount: 1, feeReserve: 0 })),
    walletPayQuote: vi.fn(async () => ({ paid: true })),
    withdrawIdentityProof: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("payments and identity withdraw name their chat", () => {
  it("by the chat's id, its contact's key or this side's label", async () => {
    const { ctx, node } = fake();
    for (const [chat, linkId, request] of [["chat-mallory", "chat-mallory", "req-mallory"], [KEY, "chat-mallory", "req-mallory"], ["alice", "chat-real-alice", "req-alice"]]) {
      expect(await callApi(ctx, "chat.pay", { chat, amount: 5 })).toEqual({ chat: linkId, paymentId: "pay-1" });
      expect(node.sendPayment).toHaveBeenLastCalledWith(expect.objectContaining({ linkId, amount: 5, network: "testnet" }));
      await callApi(ctx, "pay", { target: INVOICE, chat });
      expect(node.walletPayQuote).toHaveBeenLastCalledWith(expect.objectContaining({ linkId, invoice: INVOICE }));
      await callApi(ctx, "chat.payRequest", { chat, payment: request });
      expect(node.payRequest).toHaveBeenLastCalledWith(expect.objectContaining({ linkId, paymentId: request }));
      expect(await callApi(ctx, "identity.withdraw", { chat, id: "proof-1" })).toEqual({ chat: linkId, withdrawn: "proof-1" });
    }
  });

  it("never only by its contact's own name or a prefix of its id, and pays or withdraws nothing", async () => {
    const { ctx, node } = fake();
    const refused = { code: "bad_request", details: { chat: "chat-mallory", contact: KEY } };
    for (const chat of ["Bob", "bob", "chat-mall"]) {
      await expect(callApi(ctx, "chat.pay", { chat, amount: 5 })).rejects.toMatchObject(refused);
      await expect(callApi(ctx, "pay", { target: INVOICE, chat })).rejects.toMatchObject(refused);
      await expect(callApi(ctx, "chat.payRequest", { chat, payment: "req-mallory" })).rejects.toMatchObject(refused);
      await expect(callApi(ctx, "identity.withdraw", { chat, id: "proof-1" })).rejects.toMatchObject(refused);
    }
    expect(node.sendPayment).not.toHaveBeenCalled();
    expect(node.walletQuoteInvoice).not.toHaveBeenCalled();
    expect(node.walletPayQuote).not.toHaveBeenCalled();
    expect(node.payRequest).not.toHaveBeenCalled();
    expect(node.withdrawIdentityProof).not.toHaveBeenCalled();
  });
});
