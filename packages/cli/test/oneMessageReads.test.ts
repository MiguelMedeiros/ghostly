import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.forward, headless.chat

/**
 * `delete` and `forward` name messages by their ids here: each is read as one row, never the whole history of the chat
 * or group (synchronous work on the daemon's one thread, about 120 ms at 10,000 messages).
 */
const link = (id: string, label: string) => ({ id, label, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } }) as unknown as LinkView;
const group = { id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mine", role: "admin", me: true, online: true }, { key: "anakey", role: "member", me: false, online: true }] } as unknown as GroupView;
const row = (linkId: string, id: string, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: "t " + id, sender: "peer", timestamp: 1, via: "datalink", ...fields });

function fake() {
  const rows: StoredMessage[] = [row("chat-one", "peer_1"), row("chat-one", "peer_2"), row("group:g1", "k:0:1"), row("chat-two", "me_fwd", { sender: "me", delivery: "sent" }),
    row("chat-one", "me_1", { sender: "me", wireId: "W1", delivery: "delivered" }), row("group:g1", "mine:0:2", { sender: "me" })];
  const node = {
    chatView: chatViewOf, groupView: groupViewOf, getState: () => ({ links: [link("chat-one", "Alice"), link("chat-two", "Bob")], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: vi.fn(async (linkId: string) => rows.filter((m) => m.linkId === linkId)),
    groupMessages: vi.fn(async ({ groupId }: { groupId: string }) => rows.filter((m) => m.linkId === `group:${groupId}`)),
    getMessage: vi.fn(async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id)),
    deleteMessage: vi.fn(() => ({ everyone: false })),
    removeMessage: vi.fn(async ({ linkId }: { linkId: string }) => ({ error: null as string | null, ...(linkId.startsWith("group:") && { e: 1 }) })),
    removalPending: vi.fn(() => true),
    groupTaken: vi.fn(() => 0),
    messageDetails: vi.fn(async ({ linkId, messageId }: { linkId: string; messageId: string }) => {
      const message = rows.find((m) => m.linkId === linkId && m.id === messageId);
      return message ? { message: { id: message.id }, ...(linkId.startsWith("group:") && { group: { id: linkId.slice(6) } }) } : null;
    }),
    forwardMessages: vi.fn(async ({ to, messageIds }: { to: string[]; messageIds: string[] }) => ({ results: to.map(() => ({ messageIds: ["me_fwd"], sent: messageIds, error: null })) })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  const whole = () => node.getMessages.mock.calls.length + node.groupMessages.mock.calls.length;
  return { ctx, node, whole };
}

describe("delete", () => {
  it("reads the one message it deletes; one not there is not_found and nothing is deleted", async () => {
    const { ctx, node, whole } = fake();
    expect(await callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_1" })).toEqual({ chat: "chat-one", messageId: "peer_1", deleted: "peer_1", everyone: false });
    expect(node.deleteMessage).toHaveBeenCalledWith({ linkId: "chat-one", messageId: "peer_1" });
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "k:0:1" })).rejects.toMatchObject({ code: "not_found", message: 'No message "k:0:1" in this chat (ghostly chat history Alice)' });
    expect(node.deleteMessage).toHaveBeenCalledOnce();
    expect(whole()).toBe(0);
  });

  it("a waiting text of mine the outbox already handed to the link is deleted for everyone, and the answer says so", async () => {
    const { ctx, node } = fake();
    node.deleteMessage.mockReturnValueOnce({ everyone: true });
    expect(await callApi(ctx, "chat.delete", { chat: "Alice", message: "me_1" })).toEqual({ chat: "chat-one", messageId: "me_1", deleted: "me_1", everyone: true });
    expect(node.removeMessage).not.toHaveBeenCalled();
  });

  it("a group named without --everyone says it is a group and how its message is deleted, not \"No chat\"", async () => {
    const { ctx, node } = fake();
    for (const chat of ["Crew", "g1"])
      await expect(callApi(ctx, "chat.delete", { chat, message: "mine:0:2" })).rejects.toMatchObject({
        code: "not_found", message: `"${chat}" is a group, not a chat: ghostly message delete ${chat} mine:0:2 --everyone`, details: { group: "g1" },
      });
    // A name no chat and no group has stays the chat's own error.
    await expect(callApi(ctx, "chat.delete", { chat: "Nobody", message: "mine:0:2" })).rejects.toMatchObject({ code: "not_found", message: 'No chat "Nobody" (ghostly chat list)' });
    expect(node.deleteMessage).not.toHaveBeenCalled();
    const { COMMANDS } = await import("../src/commands");
    expect(COMMANDS["message delete"]!.usage).toBe("message delete <chat|group> <message> [--everyone [--wait none|confirmed|sent] [--timeout s]]");
  });
});

describe("message details", () => {
  it("reads a group's message too, by its name, its id or group:<id>; it said No chat", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.details", { chat: "Alice", message: "peer_1" })).toEqual({ message: { id: "peer_1" } });
    expect(node.messageDetails).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_1" });
    for (const chat of ["Crew", "g1", "group:g1"]) {
      expect(await callApi(ctx, "chat.details", { chat, message: "k:0:1" })).toEqual({ message: { id: "k:0:1" }, group: { id: "g1" } });
      expect(node.messageDetails).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "k:0:1" });
    }
    await expect(callApi(ctx, "chat.details", { chat: "Crew", message: "nope" })).rejects.toMatchObject({ code: "not_found", message: 'No message "nope" in this group (ghostly group history Crew)' });
    await expect(callApi(ctx, "chat.details", { chat: "Alice", message: "nope" })).rejects.toMatchObject({ code: "not_found", message: 'No message "nope" in this chat (ghostly chat history Alice)' });
    await expect(callApi(ctx, "chat.details", { chat: "Nobody", message: "x" })).rejects.toMatchObject({ code: "not_found" });
    const { COMMANDS } = await import("../src/commands");
    expect(COMMANDS["message details"]!.usage).toBe("message details <chat|group> <message>");
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
    expect(await callApi(ctx, "chat.delete", { chat: "Alice", message: "W1", everyone: true })).toEqual({ chat: "chat-one", messageId: "me_1", deleted: "me_1", everyone: true, confirmed: false });
    expect(node.removeMessage).toHaveBeenCalledWith({ linkId: "chat-one", messageId: "me_1" });
    expect(await callApi(ctx, "chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true })).toEqual({ group: "g1", messageId: "mine:0:2", deleted: "mine:0:2", everyone: true, sent: false, edges: 0 });
    expect(node.removeMessage).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "mine:0:2" });
    // A group has no receipts to wait for: refused before anything is deleted.
    node.removeMessage.mockClear();
    await expect(callApi(ctx, "chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true, wait: "confirmed" })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.removeMessage).not.toHaveBeenCalled();
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_1", everyone: true })).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/only your own/) });
    // What the engine refuses (a payment, say) is said as such.
    node.removeMessage.mockResolvedValueOnce({ error: "A payment, a request or a notice cannot be deleted for everyone", refused: true } as never);
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "me_1", everyone: true })).rejects.toMatchObject({ code: "refused" });
    expect(node.deleteMessage).not.toHaveBeenCalled();
  });
});

describe("delete --everyone in a group waits for an edge, as group react does", () => {
  /** My group message `mine:0:2` deleted for everyone, its removal numbered 3; `took` says how many edges took it at each look. */
  function inGroup(mode: "one-shot" | "daemon", took: () => number) {
    const { ctx, node } = fake();
    node.removeMessage.mockResolvedValue({ error: null, e: 3 });
    node.groupTaken.mockImplementation(took);
    return { ctx: { ...ctx, mode } as ApiContext, node };
  }

  it("a one-shot stays until an edge took the removal, and says how many did", async () => {
    let looks = 0;
    const { ctx, node } = inGroup("one-shot", () => (++looks > 2 ? 1 : 0));
    expect(await callApi(ctx, "chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true })).toEqual({ group: "g1", messageId: "mine:0:2", deleted: "mine:0:2", everyone: true, sent: true, edges: 1 });
    expect(node.groupTaken).toHaveBeenLastCalledWith({ groupId: "g1", messageId: "mine:0:2", edit: 3 });
    expect(looks).toBe(3);
  });

  it("a one-shot no edge took in time: a timeout (exit 4) that says it stays in the group and goes with a later command", async () => {
    const { ctx } = inGroup("one-shot", () => 0);
    await expect(callApi(ctx, "chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true, timeout: 1 })).rejects.toMatchObject({
      code: "timeout", message: expect.stringMatching(/no member's edge took it yet .*next command/), details: { messageId: "mine:0:2", edits: 3 },
    });
  });

  it("a daemon answers at once (it goes on saying it), unless asked to wait; a chat takes no --wait sent", async () => {
    const { ctx, node } = inGroup("daemon", () => 0);
    expect(await callApi(ctx, "chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true })).toMatchObject({ sent: false, edges: 0 });
    expect(node.groupTaken).toHaveBeenCalledTimes(1);
    await expect(callApi(ctx, "chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true, wait: "sent", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    node.removeMessage.mockClear();
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "me_1", everyone: true, wait: "sent" })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.removeMessage).not.toHaveBeenCalled();
  });

  it("a one-shot starts the groups' sessions for it: the edge it waits for is a group's (a plain delete stays on this device)", async () => {
    const { chatOnly } = await import("../src/main");
    expect(chatOnly("chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true })).toBe(false);
    expect(chatOnly("chat.delete", { chat: "Alice", message: "peer_1", everyone: false })).toBe(true);
  });

  it("takes --wait sent", async () => {
    const { COMMANDS, positionals } = await import("../src/commands");
    const { parseArgs } = await import("../src/args");
    const command = COMMANDS["message delete"]!;
    const parsed = parseArgs(["Crew", "mine:0:2", "--everyone", "--wait", "sent", "--timeout", "5"], command.options ?? {});
    expect(command.params!(parsed, positionals(command, parsed.positionals))).toEqual({ chat: "Crew", message: "mine:0:2", everyone: true, wait: "sent", timeout: 5 });
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
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1", "nope"], to: ["Bob"] })).rejects.toMatchObject({ code: "not_found", message: 'No message "nope" in this chat (ghostly chat history Alice)' });
    await expect(callApi(ctx, "chat.forward", { chat: "Crew", messages: ["peer_1"], to: ["Bob"] })).rejects.toMatchObject({ code: "not_found", message: 'No message "peer_1" in this group (ghostly group history Crew)' });
    node.getMessage.mockResolvedValueOnce(row("chat-one", "peer_1", { text: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" }));
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Bob"] })).rejects.toMatchObject({ code: "confirm", details: { messageId: "peer_1" } });
    expect(node.forwardMessages).not.toHaveBeenCalled();
  });

  it("an id named twice is read once, and more than 30 messages or 5 chats are refused before any is read", async () => {
    const { ctx, node } = fake();
    // One id 50,000 times was read and guarded 50,000 times (a minute of the daemon's thread) for the one message the
    // engine then forwarded.
    await callApi(ctx, "chat.forward", { chat: "Alice", messages: Array(50_000).fill("peer_1").concat("peer_2"), to: ["Bob", "Bob", "chat-two"] });
    expect(node.getMessage).toHaveBeenCalledTimes(2);
    expect(node.forwardMessages).toHaveBeenCalledWith({ linkId: "chat-one", messageIds: ["peer_1", "peer_2"], to: ["chat-two"] });
    node.getMessage.mockClear();
    const many = Array.from({ length: 31 }, (_, i) => `peer_${i}`);
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: many, to: ["Bob"] })).rejects.toMatchObject({ code: "bad_request", message: "Forward at most 30 messages at once, not 31" });
    // The same chat or group by two names is one of the 5.
    const state = node.getState();
    node.getState = () => ({ ...state, links: [...state.links, ...["Cy", "Di", "Ed", "Flo"].map((name, i) => link(`chat-${i + 3}`, name))] });
    await callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Bob", "chat-two", "Crew", "group:g1", "Cy", "Di", "Ed"] });
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Bob", "Crew", "Cy", "Di", "Ed", "Flo", "nobody"] })).rejects.toMatchObject({ code: "bad_request", message: "Forward to at most 5 chats and groups at once" });
    expect(node.getMessage).toHaveBeenCalledOnce();
    expect(node.forwardMessages).toHaveBeenCalledTimes(2);
  });
});

describe("forward to a group waits for an edge, as group send does", () => {
  /** A forward of `peer_1` to Crew, its new message `mine:0:9`; `took` says how many edges took it at each look. */
  function toGroup(mode: "one-shot" | "daemon", took: () => number) {
    const { ctx, node } = fake();
    node.forwardMessages.mockImplementation(async ({ to, messageIds }) => ({ results: to.map((t) => ({ messageIds: [t.startsWith("group:") ? "mine:0:9" : "me_fwd"], sent: messageIds, error: null })) }));
    node.groupTaken.mockImplementation(took);
    return { ctx: { ...ctx, mode } as ApiContext, node };
  }

  it("a one-shot stays until an edge took it, and says how many did; a chat beside it is not waited for", async () => {
    let looks = 0;
    const { ctx, node } = toGroup("one-shot", () => (++looks > 2 ? 1 : 0));
    expect(await callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Crew", "Bob"] })).toEqual({ from: "chat-one", results: [
      { to: "g1", kind: "group", messageIds: ["mine:0:9"], sent: ["peer_1"], error: null, edges: 1 },
      { to: "chat-two", kind: "chat", messageIds: ["me_fwd"], sent: ["peer_1"], error: null },
    ] });
    expect(node.groupTaken).toHaveBeenLastCalledWith({ groupId: "g1", messageId: "mine:0:9" });
    expect(looks).toBe(3);
  });

  it("a one-shot no edge took in time: a timeout (exit 4) that says it stays in the group; --wait none answers at once", async () => {
    await expect(callApi(toGroup("one-shot", () => 0).ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Crew"], timeout: 1 })).rejects.toMatchObject({
      code: "timeout", message: expect.stringMatching(/no member's edge took it yet .*next command/), details: { messageId: "mine:0:9" },
    });
    expect(await callApi(toGroup("one-shot", () => 0).ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Crew"], wait: "none" }))
      .toMatchObject({ results: [{ to: "g1", edges: 0 }] });
  });

  it("a daemon answers at once with how many took it so far", async () => {
    const { ctx, node } = toGroup("daemon", () => 2);
    expect(await callApi(ctx, "chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Crew"] })).toMatchObject({ results: [{ to: "g1", edges: 2 }] });
    expect(node.groupTaken).toHaveBeenCalledOnce();
  });

  it("a one-shot starts the groups' sessions for a forward and a pin: the edge they go over is a group's", async () => {
    const { chatOnly } = await import("../src/main");
    expect(chatOnly("chat.forward", { chat: "Alice", messages: ["peer_1"], to: ["Crew"] })).toBe(false);
    expect(chatOnly("chat.pin", { chat: "Crew", message: "k:0:1" })).toBe(false);
    expect(chatOnly("chat.react", { chat: "Alice", message: "peer_1", emoji: "👍" })).toBe(true);
  });

  it("a one-shot starts the groups' sessions for a group's file named with its group: it travels over the group's edges", async () => {
    const { chatOnly, oneChatOnly } = await import("../src/main");
    const file = "group-g1-in-AAAAAAAAAAAAAAAA";
    expect(chatOnly("file.wait", { chat: "Crew", file })).toBe(false);
    expect(chatOnly("file.save", { chat: "Crew", file, wait: true })).toBe(false);
    expect(chatOnly("file.action", { chat: "Crew", file, action: "accept" })).toBe(false);
    expect(chatOnly("file.action", { chat: "Crew", file, action: "request" })).toBe(false);
    // As without its group (no chat named), and the other 1:1 chats stay unstarted.
    expect(chatOnly("file.wait", { file })).toBe(false);
    expect(oneChatOnly("file.wait", { chat: "Crew", file })).toBe(true);
    // A 1:1 chat's file needs no group.
    expect(chatOnly("file.wait", { chat: "Alice", file: "chat-one-in-AAAAAAAAAAAAAAAA" })).toBe(true);
    expect(chatOnly("file.action", { chat: "Alice", file: "chat-one-in-AAAAAAAAAAAAAAAA", action: "accept" })).toBe(true);
  });
});
