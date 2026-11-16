import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.chat

/**
 * `message delete --everyone` whose wait ends short (no member's edge opens, the contact never confirms): the message
 * is gone here all the same, and with `--purge` out of the profile's folder too. The group's timeout said "it stays in
 * the group", which reads as if the message stayed, and neither timeout said the purge had run, so a script that saw
 * exit 4 could not tell, and its retry was refused as "No message … of yours".
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "pchat-one", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mine", role: "admin", me: true, online: true }, { key: "anakey", role: "member", me: false, online: false }] } as unknown as GroupView;
const row = (linkId: string, id: string): StoredMessage => ({ linkId, id, text: "purgecanary77", sender: "me", timestamp: 1, via: "datalink", delivery: "delivered" });

/** A node where no member's edge ever takes a frame and no contact ever confirms a removal. */
function fake(mode: "daemon" | "one-shot" = "daemon") {
  const rows = [row("chat-one", "me_1"), row("group:g1", "mine:0:3")];
  const node = {
    chatView: chatViewOf, groupView: groupViewOf, getState: () => ({ links: [link], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    getMessage: vi.fn(async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id)),
    getMessages: vi.fn(async () => []), groupMessages: vi.fn(async () => []),
    removeMessage: vi.fn(async ({ linkId, messageId }: { linkId: string; messageId: string }) => {
      rows.splice(rows.findIndex((m) => m.linkId === linkId && m.id === messageId), 1);
      return { error: null as string | null, ...(linkId.startsWith("group:") && { e: 1 }) };
    }),
    forgetQuotesOf: vi.fn(async () => {}),
    removalPending: vi.fn(() => true),
    groupTaken: vi.fn(() => 0),
  };
  const store = { compact: vi.fn(async () => {}) };
  const ctx = { runtime: { server: { node }, store, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, store };
}

async function timedOut(call: Promise<unknown>) {
  const caught = call.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(3_000);
  return caught;
}

afterEach(() => { vi.useRealTimers(); });

describe("message delete --everyone whose wait times out", () => {
  it("in a group says the message is gone here and its removal goes when a member's edge opens, and that the purge ran", async () => {
    vi.useFakeTimers();
    const { ctx, store } = fake();
    const failure = await timedOut(callApi(ctx, "chat.delete", { chat: "group:g1", message: "mine:0:3", everyone: true, wait: "sent", timeout: 2, purge: true }));
    expect(failure).toMatchObject({ code: "timeout", details: { messageId: "mine:0:3", deleted: "mine:0:3", purged: true } });
    expect((failure as Error).message).not.toContain("stays in the group");
    expect((failure as Error).message).toBe("Timed out after 2 s: the message is gone here and no member's edge took its removal yet (it goes when one opens). Its removal still goes by itself while this profile is online");
    expect(store.compact).toHaveBeenCalledOnce();
  });

  it("in a chat says the message is gone here and the contact has not confirmed, and that the purge ran", async () => {
    vi.useFakeTimers();
    const { ctx, store } = fake();
    const failure = await timedOut(callApi(ctx, "chat.delete", { chat: "Alice", message: "me_1", everyone: true, wait: "confirmed", timeout: 2, purge: true }));
    expect(failure).toMatchObject({
      code: "timeout", details: { messageId: "me_1", deleted: "me_1", purged: true },
      message: "Timed out after 2 s: the message is gone here and the contact has not confirmed yet. Its removal still goes by itself while this profile is online",
    });
    expect(store.compact).toHaveBeenCalledOnce();
  });

  it("without --purge names the deleted message and says nothing was purged", async () => {
    vi.useFakeTimers();
    for (const [chat, message, wait] of [["group:g1", "mine:0:3", "sent"], ["Alice", "me_1", "confirmed"]] as const) {
      const { ctx, store } = fake();
      const failure = await timedOut(callApi(ctx, "chat.delete", { chat, message, everyone: true, wait, timeout: 2 }));
      expect(failure).toMatchObject({ code: "timeout", details: { messageId: message, deleted: message } });
      expect((failure as { details: object }).details).not.toHaveProperty("purged");
      expect(store.compact).not.toHaveBeenCalled();
    }
  });

  it("in a one-shot names the next step, as every other timeout does", async () => {
    vi.useFakeTimers();
    const { ctx } = fake("one-shot");
    expect(await timedOut(callApi(ctx, "chat.delete", { chat: "group:g1", message: "mine:0:3", everyone: true, timeout: 2, purge: true }))).toMatchObject({
      code: "timeout", details: { deleted: "mine:0:3", purged: true },
      message: "Timed out after 2 s: the message is gone here and no member's edge took its removal yet (it goes when one opens). Its removal goes with this profile's next command, or keep it online with `ghostly daemon --detach`",
    });
  });
});
