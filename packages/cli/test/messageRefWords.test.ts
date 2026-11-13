import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { chatViewOf } from "./support/chatView";
// covers: headless.chat, headless.groups, headless.files

/**
 * A message or a file id that is not there is said one way on every command that takes one, as a chat ref is: quoted as
 * given, in this chat or this group, with where its ids are. It came in five shapes, and `group send --reply` said "chat".
 */
const alice = { id: "chat-one", label: "Alice", peerPubKeyZ32: "pchat-one", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const team = { id: "g1", name: "team", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, status: "active", lastMessageAt: 0, invited: [], memberLinks: {}, members: [] } as unknown as GroupView;
const mine: StoredMessage = { linkId: "chat-one", id: "me_1", text: "hi", sender: "me", timestamp: 1, via: "datalink", delivery: "delivered" };

function fake() {
  const where = (linkId: string) => (linkId.startsWith("group:") ? "group" : "chat");
  const node = {
    chatView: chatViewOf, getState: () => ({ links: [alice], groups: [team], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessage: vi.fn(async (linkId: string, id: string) => (linkId === mine.linkId && id === mine.id ? mine : undefined)),
    getMessages: vi.fn(async (linkId: string) => (linkId === mine.linkId ? [mine] : [])),
    groupMessages: vi.fn(async () => []),
    messageDetails: vi.fn(async () => null),
    react: vi.fn(async ({ linkId }: { linkId: string }) => ({ error: `That message is not in this ${where(linkId)}, or takes no reaction` })),
    pinMessage: vi.fn(async ({ linkId }: { linkId: string }) => ({ error: `That message is not in this ${where(linkId)}, or cannot be pinned` })),
    saveMessage: vi.fn(async () => ({ error: "That message is not in this chat" })),
    editMessage: vi.fn(async () => ({ error: "Only your own text messages can be edited", refused: true })),
    sendMessage: vi.fn(async () => ({ error: "That message is not in this chat, or cannot be replied to", refused: true })),
    sendGroupMessage: vi.fn(async () => ({ error: "That message is not in this chat, or cannot be replied to" })),
    chatUnconfirmed: vi.fn(() => ({ reactions: [], pin: null })),
    setTyping: vi.fn(),
    messagePage: vi.fn(async ({ before }: { before?: string }) => { throw new Error(`No message ${before}`); }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return ctx;
}

const inChat = 'No message "nomsg" in this chat';
const chatNext = "(ghostly chat history Alice)";
const groupNext = "(ghostly group history group:team)";

describe("a message id that is not there", () => {
  it("is said one way in a chat, quoted, with where the ids are", async () => {
    const ctx = fake();
    const said = { code: "not_found", message: `${inChat} ${chatNext}` };
    for (const [method, params] of [
      ["chat.details", { chat: "Alice", message: "nomsg" }],
      ["chat.retry", { chat: "Alice", message: "nomsg" }],
      ["chat.delete", { chat: "Alice", message: "nomsg" }],
      ["chat.forward", { chat: "Alice", messages: ["nomsg"], to: ["Alice"] }],
      ["saved.add", { chat: "Alice", message: "nomsg" }],
      ["chat.edit", { chat: "Alice", message: "nomsg", text: "x" }],
      ["chat.history", { chat: "Alice", before: "nomsg" }],
    ] as const) await expect(callApi(ctx, method, params), method).rejects.toMatchObject(said);
  });

  it("keeps the other reason, and whose message it had to be", async () => {
    const ctx = fake();
    await expect(callApi(ctx, "chat.react", { chat: "Alice", message: "nomsg", emoji: "👍" })).rejects.toMatchObject({ code: "not_found", message: `${inChat}, or it takes no reaction ${chatNext}` });
    await expect(callApi(ctx, "chat.pin", { chat: "Alice", message: "nomsg" })).rejects.toMatchObject({ code: "not_found", message: `${inChat}, or it cannot be pinned ${chatNext}` });
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "hi", reply: "nomsg" })).rejects.toMatchObject({ code: "not_found", message: `${inChat}, or it cannot be replied to ${chatNext}` });
    await expect(callApi(ctx, "button.press", { chat: "Alice", message: "nomsg", button: "yes" })).rejects.toMatchObject({ code: "not_found", message: `No message "nomsg" from someone else in this chat ${chatNext}` });
    await expect(callApi(ctx, "chat.retry", { chat: "Alice", message: "me_1x" })).rejects.toMatchObject({ code: "not_found", message: `No message "me_1x" in this chat ${chatNext}` });
  });

  it("says group in a group, group send --reply too", async () => {
    const ctx = fake();
    await expect(callApi(ctx, "group.send", { group: "group:team", text: "hi", reply: "nomsg", wait: "none" })).rejects.toMatchObject({ code: "not_found", message: `No message "nomsg" in this group, or it cannot be replied to ${groupNext}` });
    await expect(callApi(ctx, "group.react", { group: "group:team", message: "nomsg", emoji: "👍", wait: "none" })).rejects.toMatchObject({ code: "not_found", message: `No message "nomsg" in this group, or it takes no reaction ${groupNext}` });
    await expect(callApi(ctx, "chat.details", { chat: "group:team", message: "nomsg" })).rejects.toMatchObject({ code: "not_found", message: `No message "nomsg" in this group ${groupNext}` });
  });
});

describe("a file id that is not there", () => {
  it("is quoted, with where the files are listed", async () => {
    const ctx = fake();
    await expect(callApi(ctx, "file.action", { file: "nofile", action: "cancel" })).rejects.toMatchObject({ code: "not_found", message: 'No file "nofile" (ghostly file list <chat|group>)' });
    for (const method of ["file.action", "file.save"])
      await expect(callApi(ctx, method, { chat: "Alice", file: "nofile" }), method).rejects.toMatchObject({ code: "not_found", message: 'No file "nofile" in this chat (ghostly file list Alice)' });
    await expect(callApi(ctx, "file.action", { chat: "Alice", file: "group-g1-in-x" })).rejects.toMatchObject({ code: "not_found", message: 'No file "group-g1-in-x" in this chat (ghostly file list Alice)' });
  });
});
