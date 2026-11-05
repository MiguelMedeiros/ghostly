import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.group-admin, headless.identities

/**
 * `group invite` and `identity share` last: the one invited reads the group from then on, and the one shown a proof keeps
 * it. So, as `service share`, `call auto --from` and `listen --from`, they name their chat by the chat's id, its
 * contact's key or this side's label, never only by what the contact chose (a prefix of the id, the name it gave
 * itself). Before, `group invite crew alice` invited whichever contact called itself "alice" when no chat had that label.
 */
const KEY = "y".repeat(52);
function fake() {
  const links = [
    { id: "chat-real-alice", label: "Alice", peerNick: "alice", peerPubKeyZ32: "o".repeat(51) + "y", profile: "paired-chat/1" },
    { id: "chat-mallory", label: null, peerNick: "Bob", peerPubKeyZ32: KEY, profile: "paired-chat/1" },
  ] as unknown as LinkView[];
  const groups = [{ id: "grp-crew", name: "Crew", profile: "group/1", status: "active", isAdmin: true, canSend: true, members: [], lastMessageAt: null }];
  const node = {
    getState: () => ({ links, groups, settings: {}, transport: {}, identityProofs: [{ id: "proof-1" }] }) as unknown as EngineState,
    inviteToGroup: vi.fn(async () => {}),
    shareIdentityProof: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("group invite and identity share name their chat", () => {
  it("by the chat's id, its contact's key or this side's label", async () => {
    const { ctx, node } = fake();
    for (const [chat, linkId] of [["chat-mallory", "chat-mallory"], [KEY, "chat-mallory"], ["alice", "chat-real-alice"]]) {
      await callApi(ctx, "group.invite", { group: "Crew", chat });
      expect(node.inviteToGroup).toHaveBeenLastCalledWith({ groupId: "grp-crew", linkId });
      expect(await callApi(ctx, "identity.share", { chat, id: "proof-1" })).toEqual({ chat: linkId, shared: "proof-1" });
    }
  });

  it("never only by its contact's own name or a prefix of its id, and invites or shares nothing", async () => {
    const { ctx, node } = fake();
    for (const chat of ["Bob", "chat-mall"]) {
      await expect(callApi(ctx, "group.invite", { group: "Crew", chat })).rejects.toMatchObject({ code: "bad_request", details: { chat: "chat-mallory", contact: KEY } });
      await expect(callApi(ctx, "identity.share", { chat, id: "proof-1" })).rejects.toMatchObject({ code: "bad_request", details: { chat: "chat-mallory", contact: KEY } });
    }
    expect(node.inviteToGroup).not.toHaveBeenCalled();
    expect(node.shareIdentityProof).not.toHaveBeenCalled();
  });
});
