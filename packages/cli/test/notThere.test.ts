import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.services, headless.identities, headless.chat, headless.wallets

/**
 * A command that names a service, an identity proof, a draft or a message that is not there says so (`not_found`,
 * exit 3) and asks the engine for nothing. Before, each answered as done: `service share nope <chat>` read
 * `"shared": true`, with a contact, for a service that did not exist.
 */
function fake() {
  const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "pchat-one", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" },
    identities: { support: true, shared: [{ id: "proof-1", provider: "github", subject: "ana", status: "accepted", at: 1 }], received: [] } } as unknown as LinkView;
  const rows: StoredMessage[] = [{ linkId: "chat-one", id: "me_1", text: "hi", sender: "me", timestamp: 1, via: "datalink", delivery: "failed" }];
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {},
      services: [{ id: "svc-1", name: "Notes", target: "http://127.0.0.1:8080", enabled: true, sharedWith: [], requests: 0 }],
      identityProofs: [{ id: "proof-1", provider: "github", subject: "ana", verified: true, issuedAt: 1, expiresAt: 2, sharedWith: [] }] }) as unknown as EngineState,
    getMessage: vi.fn(async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id)),
    removeService: vi.fn(), setServiceEnabled: vi.fn(), setServiceShared: vi.fn(),
    removeIdentityProof: vi.fn(async () => {}), withdrawIdentityProof: vi.fn(async () => {}), cancelIdentityProof: vi.fn(),
    retryMessage: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("a service that is not there", () => {
  it("is not_found for enable, remove and share, and the engine is not asked", async () => {
    const { ctx, node } = fake();
    const gone = { code: "not_found", message: 'No service "nope" (ghostly service list)' };
    await expect(callApi(ctx, "service.enable", { service: "nope" })).rejects.toMatchObject(gone);
    await expect(callApi(ctx, "service.remove", { service: "nope" })).rejects.toMatchObject(gone);
    await expect(callApi(ctx, "service.share", { service: "nope", chat: "Alice" })).rejects.toMatchObject(gone);
    expect(node.setServiceEnabled).not.toHaveBeenCalled();
    expect(node.removeService).not.toHaveBeenCalled();
    expect(node.setServiceShared).not.toHaveBeenCalled();
  });

  it("one that is there is enabled, shared and removed as before", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "service.enable", { service: "svc-1", off: true })).toEqual({ service: "svc-1", enabled: false });
    expect(node.setServiceEnabled).toHaveBeenCalledWith({ serviceId: "svc-1", enabled: false });
    expect(await callApi(ctx, "service.share", { service: "svc-1", chat: "Alice" })).toEqual({ service: "svc-1", chat: "chat-one", shared: true });
    expect(node.setServiceShared).toHaveBeenCalledWith({ serviceId: "svc-1", peerPubKeyZ32: "pchat-one", shared: true });
    expect(await callApi(ctx, "service.remove", { service: "svc-1" })).toEqual({ removed: "svc-1" });
    expect(node.removeService).toHaveBeenCalledWith({ serviceId: "svc-1" });
  });
});

describe("an identity proof or a draft that is not there", () => {
  it("is not_found for remove, withdraw and cancel, and the engine is not asked", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "identity.remove", { id: "nope" })).rejects.toMatchObject({ code: "not_found", message: 'No identity proof "nope" (ghostly identity list)' });
    await expect(callApi(ctx, "identity.withdraw", { chat: "Alice", id: "nope" })).rejects.toMatchObject({ code: "not_found", message: 'No identity proof "nope" shared in this chat (ghostly identity contact chat-one)' });
    await expect(callApi(ctx, "identity.cancel", { draft: "nope" })).rejects.toMatchObject({ code: "not_found", message: "No such draft here: it is kept by the daemon that made it, for an hour" });
    expect(node.removeIdentityProof).not.toHaveBeenCalled();
    expect(node.withdrawIdentityProof).not.toHaveBeenCalled();
    expect(node.cancelIdentityProof).not.toHaveBeenCalled();
  });

  it("a proof that is there is withdrawn from its chat and removed as before", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "identity.withdraw", { chat: "Alice", id: "proof-1" })).toEqual({ chat: "chat-one", withdrawn: "proof-1" });
    expect(node.withdrawIdentityProof).toHaveBeenCalledWith({ linkId: "chat-one", id: "proof-1" });
    expect(await callApi(ctx, "identity.remove", { id: "proof-1" })).toEqual({ removed: "proof-1" });
    expect(node.removeIdentityProof).toHaveBeenCalledWith({ id: "proof-1" });
  });
});

describe("a message that is not there", () => {
  it("is not_found for retry, read as one row; one that is there is retried", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "chat.retry", { chat: "Alice", message: "nope" })).rejects.toMatchObject({ code: "not_found", message: "No message nope in this chat" });
    expect(node.retryMessage).not.toHaveBeenCalled();
    expect(await callApi(ctx, "chat.retry", { chat: "Alice", message: "me_1" })).toEqual({ chat: "chat-one", messageId: "me_1" });
    expect(node.retryMessage).toHaveBeenCalledWith({ linkId: "chat-one", messageId: "me_1" });
  });
});

/**
 * Payments, identities and Lightning cards named by an id that is not there are `not_found` (exit 3) too, naming the
 * list to look in, and the engine is not asked. Before, the engine's error came back as `engine` (exit 1): "Unknown
 * payment request", "Nothing to reclaim", "That identity is no longer in your profile", "Unknown identity" and "That
 * Lightning card is gone".
 */
function wallets() {
  const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "pchat-one", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" },
    identities: { support: true, shared: [], received: [{ id: "theirs-1", provider: "github", subject: "bob", status: "verified" }] } } as unknown as LinkView;
  const payment = (id: string, fields: Record<string, unknown>) => ({ id, linkId: "chat-one", amount: 21, unit: "sat", state: "pending", createdAt: 1, ...fields });
  const node = {
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {},
      identityProofs: [{ id: "proof-1", provider: "github", subject: "ana", verified: true, issuedAt: 1, expiresAt: 2, sharedWith: [] }],
      payments: { "req-in": payment("req-in", { kind: "request", direction: "in" }), "req-out": payment("req-out", { kind: "request", direction: "out" }), "pay-out": payment("pay-out", { kind: "payment", direction: "out" }) },
      wallet: { networks: { testnet: { lightnings: [{ card: "card-1", name: "Mine", receive: true }] }, mainnet: { lightnings: [] } } } }) as unknown as EngineState,
    checkPayment: vi.fn(async () => {}), reclaimPayment: vi.fn(async () => {}),
    shareIdentityProof: vi.fn(async () => {}), recheckIdentityProof: vi.fn(async () => {}),
    lightningSetReceive: vi.fn(async () => {}), lightningRename: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("a payment, an identity or a Lightning card that is not there", () => {
  it("is not_found for payment check and reclaim, and the engine is not asked", async () => {
    const { ctx, node } = wallets();
    const noRequest = (id: string) => ({ code: "not_found", message: `No request "${id}" from the contact in this chat (ghostly payment list --chat chat-one)` });
    await expect(callApi(ctx, "payment.check", { chat: "Alice", payment: "nopeNOPE1234" })).rejects.toMatchObject(noRequest("nopeNOPE1234"));
    // A request of mine, or a payment, is not one to check either: the engine would say "Unknown payment request".
    await expect(callApi(ctx, "payment.check", { chat: "Alice", payment: "req-out" })).rejects.toMatchObject(noRequest("req-out"));
    await expect(callApi(ctx, "payment.check", { chat: "Alice", payment: "pay-out" })).rejects.toMatchObject(noRequest("pay-out"));
    await expect(callApi(ctx, "payment.reclaim", { payment: "nopeNOPE1234" })).rejects.toMatchObject({ code: "not_found", message: 'No payment "nopeNOPE1234" (ghostly payment list)' });
    expect(node.checkPayment).not.toHaveBeenCalled();
    expect(node.reclaimPayment).not.toHaveBeenCalled();
    expect(await callApi(ctx, "payment.check", { chat: "Alice", payment: "req-in" })).toEqual({ chat: "chat-one", paymentId: "req-in" });
    expect(node.checkPayment).toHaveBeenCalledWith({ linkId: "chat-one", paymentId: "req-in" });
    expect(await callApi(ctx, "payment.reclaim", { payment: "pay-out" })).toMatchObject({ id: "pay-out" });
    expect(node.reclaimPayment).toHaveBeenCalledWith({ paymentId: "pay-out" });
  });

  it("is not_found for identity share and recheck, and the engine is not asked", async () => {
    const { ctx, node } = wallets();
    await expect(callApi(ctx, "identity.share", { chat: "Alice", id: "nopeNOPE1234" })).rejects.toMatchObject({ code: "not_found", message: 'No identity proof "nopeNOPE1234" (ghostly identity list)' });
    await expect(callApi(ctx, "identity.recheck", { chat: "Alice", id: "nopeNOPE1234" })).rejects.toMatchObject({ code: "not_found", message: 'No identity "nopeNOPE1234" from the contact in this chat (ghostly identity contact chat-one)' });
    expect(node.shareIdentityProof).not.toHaveBeenCalled();
    expect(node.recheckIdentityProof).not.toHaveBeenCalled();
    expect(await callApi(ctx, "identity.share", { chat: "Alice", id: "proof-1" })).toEqual({ chat: "chat-one", shared: "proof-1" });
    expect(node.shareIdentityProof).toHaveBeenCalledWith({ linkId: "chat-one", id: "proof-1" });
    expect(await callApi(ctx, "identity.recheck", { chat: "Alice", id: "theirs-1" })).toMatchObject({ chat: "chat-one" });
    expect(node.recheckIdentityProof).toHaveBeenCalledWith({ linkId: "chat-one", id: "theirs-1" });
  });

  it("is not_found for lightning default and rename, on the network asked for, and the engine is not asked", async () => {
    const { ctx, node } = wallets();
    const gone = (card: string, n: string) => ({ code: "not_found", message: `No Lightning card "${card}" on ${n} (ghostly wallet list)` });
    await expect(callApi(ctx, "lightning.default", { card: "nopeNOPE1234" })).rejects.toMatchObject(gone("nopeNOPE1234", "testnet"));
    await expect(callApi(ctx, "lightning.rename", { card: "nopeNOPE1234", name: "x" })).rejects.toMatchObject(gone("nopeNOPE1234", "testnet"));
    await expect(callApi(ctx, "lightning.default", { card: "card-1", network: "mainnet" })).rejects.toMatchObject(gone("card-1", "mainnet"));
    expect(node.lightningSetReceive).not.toHaveBeenCalled();
    expect(node.lightningRename).not.toHaveBeenCalled();
    expect(await callApi(ctx, "lightning.default", { card: "card-1" })).toEqual({ network: "testnet", receive: "card-1" });
    expect(await callApi(ctx, "lightning.rename", { card: "card-1", name: "Work" })).toEqual({ network: "testnet", card: "card-1", name: "Work" });
    expect(node.lightningRename).toHaveBeenCalledWith({ network: "testnet", card: "card-1", name: "Work" });
  });
});
