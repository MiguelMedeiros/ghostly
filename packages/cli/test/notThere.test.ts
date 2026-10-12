import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.services, headless.identities, headless.chat

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
