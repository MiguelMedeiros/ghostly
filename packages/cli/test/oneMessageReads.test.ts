import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.forward, headless.chat

/**
 * `delete` and `forward` name messages by their ids here: each is read as one row, never the whole history of the chat
 * or group (synchronous work on the daemon's one thread, about 120 ms at 10,000 messages).
 */
const link = (id: string, label: string) => ({ id, label, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } }) as unknown as LinkView;
const group = { id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {}, members: [] } as unknown as GroupView;
const row = (linkId: string, id: string, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: "t " + id, sender: "peer", timestamp: 1, via: "datalink", ...fields });

function fake() {
  const rows: StoredMessage[] = [row("chat-one", "peer_1"), row("chat-one", "peer_2"), row("group:g1", "k:0:1"), row("chat-two", "me_fwd", { sender: "me", delivery: "sent" }),
    row("chat-one", "me_1", { sender: "me", wireId: "W1", delivery: "delivered" }), row("group:g1", "mine:0:2", { sender: "me" })];
  const node = {
    getState: () => ({ links: [link("chat-one", "Alice"), link("chat-two", "Bob")], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: vi.fn(async (linkId: string) => rows.filter((m) => m.linkId === linkId)),
    groupMessages: vi.fn(async ({ groupId }: { groupId: string }) => rows.filter((m) => m.linkId === `group:${groupId}`)),
    getMessage: vi.fn(async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id)),
    deleteMessage: vi.fn(async () => {}),
    removeMessage: vi.fn(async () => ({ error: null as string | null })),
    forwardMessages: vi.fn(async ({ to, messageIds }: { to: string[]; messageIds: string[] }) => ({ results: to.map(() => ({ messageIds: ["me_fwd"], sent: messageIds, error: null })) })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  const whole = () => node.getMessages.mock.calls.length + node.groupMessages.mock.calls.length;
  return { ctx, node, whole };
}

describe("delete", () => {
  it("reads the one message it deletes; one not there is not_found and nothing is deleted", async () => {
    const { ctx, node, whole } = fake();
    expect(await callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_1" })).toEqual({ chat: "chat-one", deleted: "peer_1" });
    expect(node.deleteMessage).toHaveBeenCalledWith({ linkId: "chat-one", messageId: "peer_1" });
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "k:0:1" })).rejects.toMatchObject({ code: "not_found", message: "No message k:0:1 in this chat" });
    expect(node.deleteMessage).toHaveBeenCalledOnce();
    expect(whole()).toBe(0);
  });

  it("a group named without --everyone says it is a group and how its message is deleted, not \"No chat\"", async () => {
    const { ctx, node } = fake();
    for (const chat of ["Crew", "g1"])
      await expect(callApi(ctx, "chat.delete", { chat, message: "mine:0:2" })).rejects.toMatchObject({
        code: "not_found", message: `"${chat}" is a group, not a chat: ghostly message delete ${chat} mine:0:2 --everyone`, details: { group: "g1" },
      });
    // A name no chat and no group has stays the chat's own error.
    await expect(callApi(ctx, "chat.delete", { chat: "Nobody", message: "mine:0:2" })).rejects.toMatchObject({ code: "not_found", message: 'No chat "Nobody"' });
    expect(node.deleteMessage).not.toHaveBeenCalled();
    const { COMMANDS } = await import("../src/commands");
    expect(COMMANDS["message delete"]!.usage).toBe("message delete <chat|group> <message> [--everyone]");
  });
});

describe("delete --everyone", () => {
  it("deletes a message of mine for everyone, in a chat (by its id or the one both sides know) or a group; never the contact's", async () => {
    const { ctx, node } = fake();
    const { COMMANDS, positionals } = await import("../src/commands");
    const { parseArgs } = await import("../src/args");
    const command = COMMANDS["message delete"]!;
    const parsed = parseArgs(["Alice", "me_1", "--everyone"], command.options ?? {});
    expect(command.params!(parsed, positionals(command, parsed.positionals))).toEqual({ chat: "Alice", message: "me_1", everyone: true });
    expect(await callApi(ctx, "chat.delete", { chat: "Alice", message: "W1", everyone: true })).toEqual({ chat: "chat-one", deleted: "me_1", everyone: true });
    expect(node.removeMessage).toHaveBeenCalledWith({ linkId: "chat-one", messageId: "me_1" });
    expect(await callApi(ctx, "chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true })).toEqual({ group: "g1", deleted: "mine:0:2", everyone: true });
    expect(node.removeMessage).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "mine:0:2" });
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_1", everyone: true })).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/only your own/) });
    // What the engine refuses (a payment, say) is said as such.
    node.removeMessage.mockResolvedValueOnce({ error: "A payment, a request or a notice cannot be deleted for everyone", refused: true } as never);
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "me_1", everyone: true })).rejects.toMatchObject({ code: "refused" });
    expect(node.deleteMessage).not.toHaveBeenCalled();
  });
});

describe("forward", () => {
  it("reads the messages it forwards, from a chat or a group, and each it waits for, one row each", async () => {
    const { ctx, node, whole } = fake();
    expect(await callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1", "peer_2"], to: ["Bob"], wait: "sent", timeout: 1 }))
      .toEqual({ from: "chat-one", results: [{ to: "chat-two", kind: "chat", messageIds: ["me_fwd"], sent: ["peer_1", "peer_2"], error: null }] });
    expect(node.forwardMessages).toHaveBeenCalledWith({ linkId: "chat-one", messageIds: ["peer_1", "peer_2"], to: ["chat-two"] });
    await callApi(ctx, "chat.forward", { chat: "Crew", messages: ["k:0:1"], to: ["Bob"] });
    expect(node.getMessage).toHaveBeenCalledWith("group:g1", "k:0:1");
    expect(whole()).toBe(0);
  });

  it("one not there is not_found, before anything is forwarded; the secret guard reads the same rows", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1", "nope"], to: ["Bob"] })).rejects.toMatchObject({ code: "not_found", message: "No message nope in this chat" });
    await expect(callApi(ctx, "chat.forward", { chat: "Crew", messages: ["peer_1"], to: ["Bob"] })).rejects.toMatchObject({ code: "not_found", message: "No message peer_1 in this group" });
    node.getMessage.mockResolvedValueOnce(row("chat-one", "peer_1", { text: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" }));
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Bob"] })).rejects.toMatchObject({ code: "confirm", details: { messageId: "peer_1" } });
    expect(node.forwardMessages).not.toHaveBeenCalled();
  });
});
