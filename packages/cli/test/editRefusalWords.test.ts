import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.edit, groups.edit, headless.chat

/**
 * `edit` and `group edit` said the engine's sentence alone when it refused (a contact's message, the 101st edit, a text
 * that reads as a join notice), with nothing to run. `message delete --everyone` called one of my own messages deleted
 * already "No message … of yours", as if it were the contact's; and a 1:1 edit with the text the message already has
 * answered as an edit, where `group edit` says `unchanged: true`.
 */
const alice = { id: "chat-one", label: "Alice", peerPubKeyZ32: "pchat-one", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const crew = { id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "admin", me: true, online: true, missing: 0 }, { key: "bobkey", nick: "Bob", role: "member", me: false, online: true, missing: 0 }] } as unknown as GroupView;
const row = (fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "chat-one", id: "me_w", wireId: "W".repeat(22), text: "Working", sender: "me", timestamp: 1, via: "datalink", delivery: "delivered", ...fields });

function fake(answer: { error: string | null; refused?: boolean; missing?: boolean; messageId?: string } = { error: null, messageId: "me_w" }) {
  const rows: StoredMessage[] = [row(), row({ id: "peer_x", wireId: "X".repeat(22), sender: "peer", delivery: undefined }),
    row({ linkId: "group:g1", id: "mekey:1:0", wireId: undefined }), row({ linkId: "group:g1", id: "bobkey:1:0", wireId: undefined, sender: "peer", member: "bobkey" })];
  const node = {
    chatView: chatViewOf, groupView: groupViewOf, getState: () => ({ links: [alice], groups: [crew], settings: {}, transport: {} }) as unknown as EngineState,
    getMessage: vi.fn(async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id)),
    getMessages: vi.fn(async (linkId: string) => rows.filter((m) => m.linkId === linkId)),
    groupMessages: vi.fn(async ({ groupId }: { groupId: string }) => rows.filter((m) => m.linkId === `group:${groupId}`)),
    editMessage: vi.fn(async () => answer),
    groupTaken: vi.fn(() => 1),
    removeMessage: vi.fn(async () => ({ error: null })),
    removalPending: vi.fn(() => false),
    // My own `me_gone`, deleted for everyone before: its id stays among the chat's deleted ids.
    deletedIdsOf: vi.fn(() => ["me_gone"]),
  };
  const ctx = { runtime: { server: { node }, store: { compact: vi.fn(async () => {}) }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node, rows };
}

const refusal = (error: string, missing = false) => fake({ error, refused: true, missing });

describe("an edit the engine refused says what to run instead", () => {
  it("a contact's message: the reply that answers it", async () => {
    const { ctx } = refusal("Only your own text messages can be edited");
    await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "peer_x", text: "mine now" })).rejects.toMatchObject({
      code: "refused", message: "Only your own text messages can be edited: to answer this one, reply to it (ghostly send Alice --reply peer_x <text>)",
    });
    await expect(callApi(ctx, "group.edit", { group: "Crew", message: "bobkey:1:0", text: "mine now" })).rejects.toMatchObject({
      code: "refused", message: "Only your own text messages can be edited: to answer this one, reply to it (ghostly group send Crew --reply bobkey:1:0 <text>)",
    });
  });

  it("the edit past the most a message takes: a new message, and the old one deleted for everyone if you like", async () => {
    const { ctx } = refusal("This message was edited 100 times, the most one takes.");
    await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "one more" })).rejects.toMatchObject({
      code: "refused", message: "This message was edited 100 times, the most one takes: send the new text as a new message (ghostly send Alice <text>); ghostly message delete Alice me_w --everyone takes the old one away",
    });
    await expect(callApi(ctx, "group.edit", { group: "Crew", message: "mekey:1:0", text: "one more" })).rejects.toMatchObject({
      code: "refused", message: "This message was edited 100 times, the most one takes: send the new text as a new message (ghostly group send Crew <text>); ghostly message delete Crew mekey:1:0 --everyone takes the old one away",
    });
  });

  it("a text that reads as a join notice: change its first words", async () => {
    const { ctx } = refusal("An edit cannot read as a join notice.");
    await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "👋 Bob joined" })).rejects.toMatchObject({
      code: "refused", message: "An edit cannot read as a join notice (\"👋 … joined\"): change its first words",
    });
  });

  it("any other refusal stays in the engine's words", async () => {
    for (const error of ["An edit cannot be empty. Delete the message instead.", "This message was edited many times, the most one takes.", "Only your own text messages can be edited."]) {
      const { ctx } = refusal(error);
      await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "x" })).rejects.toMatchObject({ code: "refused", message: error });
    }
    // A message not in the chat at all is still not found, as every message id is.
    await expect(callApi(refusal("Only your own text messages can be edited", true).ctx, "chat.edit", { chat: "Alice", message: "me_typo", text: "x" })).rejects.toMatchObject({
      code: "not_found", message: 'No message "me_typo" in this chat (ghostly chat history Alice)',
    });
  });
});

describe("a 1:1 edit with the text the message already has", () => {
  it("answers unchanged: true, as group edit does; a real edit does not", async () => {
    // The engine made no edit: the edit number stays.
    const same = fake();
    same.rows[0] = row({ text: "Done", edit: { seq: 2, at: 5, history: [] } });
    expect(await callApi(same.ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "Done" })).toEqual({ chat: "chat-one", messageId: "me_w", edits: 2, confirmed: true, unchanged: true });
    // Never edited, named by its wire id: still no edit.
    const never = fake();
    expect(await callApi(never.ctx, "chat.edit", { chat: "Alice", message: "W".repeat(22), text: "Working" })).toEqual({ chat: "chat-one", messageId: "me_w", edits: 0, confirmed: true, unchanged: true });
    // An edit made: its number moved, and no flag.
    const edited = fake();
    edited.node.editMessage.mockImplementationOnce(async () => {
      edited.rows[0] = row({ text: "Done", edit: { seq: 1, at: 5, history: [{ at: 1, text: "Working" }] } });
      return { error: null, messageId: "me_w" };
    });
    expect(await callApi(edited.ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "Done" })).toEqual({ chat: "chat-one", messageId: "me_w", edits: 1, confirmed: true });
  });
});

describe("message delete --everyone on a message it cannot delete", () => {
  it("one of mine deleted already says so, not that it is someone else's", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "me_gone", everyone: true })).rejects.toMatchObject({
      code: "not_found", message: 'No message "me_gone" in this chat: it was deleted already (ghostly chat history Alice)',
    });
    // An id the chat never had: not found, and nothing about whose it was.
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "me_typo", everyone: true })).rejects.toMatchObject({
      code: "not_found", message: 'No message "me_typo" in this chat (ghostly chat history Alice)',
    });
    await expect(callApi(ctx, "chat.delete", { chat: "Crew", message: "mekey:9:9", everyone: true })).rejects.toMatchObject({
      code: "not_found", message: 'No message "mekey:9:9" in this group (ghostly group history Crew)',
    });
    expect(node.removeMessage).not.toHaveBeenCalled();
  });

  it("the contact's message says it is theirs, and what deletes it on this device", async () => {
    const { ctx, node } = fake();
    for (const message of ["peer_x", "X".repeat(22)])
      await expect(callApi(ctx, "chat.delete", { chat: "Alice", message, everyone: true })).rejects.toMatchObject({
        message: `${JSON.stringify(message)} is the contact's message: only your own messages are deleted for everyone (ghostly message delete Alice peer_x deletes it on this device)`,
      });
    await expect(callApi(ctx, "chat.delete", { chat: "Crew", message: "bobkey:1:0", everyone: true })).rejects.toMatchObject({
      message: '"bobkey:1:0" is another member\'s message: only its author deletes a group\'s message, for everyone',
    });
    expect(node.removeMessage).not.toHaveBeenCalled();
  });

  it("a contact's message is refused (exit 1) by edit and by delete --everyone alike; it was not_found (exit 3) from the delete", async () => {
    const { ctx } = refusal("Only your own text messages can be edited");
    const edit = await callApi(ctx, "chat.edit", { chat: "Alice", message: "peer_x", text: "x" }).catch((e: unknown) => e);
    const remove = await callApi(ctx, "chat.delete", { chat: "Alice", message: "peer_x", everyone: true }).catch((e: unknown) => e);
    const group = await callApi(ctx, "chat.delete", { chat: "Crew", message: "bobkey:1:0", everyone: true }).catch((e: unknown) => e);
    const groupEdit = await callApi(ctx, "group.edit", { group: "Crew", message: "bobkey:1:0", text: "x" }).catch((e: unknown) => e);
    expect([edit, remove, groupEdit, group].map((e) => (e as { code?: string }).code)).toEqual(["refused", "refused", "refused", "refused"]);
    // One of mine deleted already stays not found: gone, not someone else's.
    await expect(callApi(ctx, "chat.delete", { chat: "Alice", message: "me_gone", everyone: true })).rejects.toMatchObject({ code: "not_found" });
  });
});
