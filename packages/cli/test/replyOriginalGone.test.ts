import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { pageOf } from "./support/messagePage";
// covers: headless.replies

/**
 * A reply whose original was here and is gone (deleted on this device, or for everyone by its author: WISP 400 §
 * Delete for everyone) reads as the apps show it, "Original message deleted": not found, no text. Before, history
 * kept `found: true` and the original's text for good.
 */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "pchat", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const group = { id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {}, members: [] } as unknown as GroupView;
const row = (linkId: string, id: string, timestamp: number, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: "t " + id, sender: "peer", timestamp, via: "datalink", ...fields });
const reply = (to: string, snippet: string) => ({ replyTo: { id: "wire-" + to, snippet, from: "peer" as const, messageId: to } });

function fake(rows: StoredMessage[]) {
  const node = {
    getState: () => ({ links: [link], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: vi.fn(async (linkId: string) => rows.filter((m) => m.linkId === linkId)),
    getMessage: vi.fn(async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id)),
    messagePage: vi.fn(async ({ linkId, limit, before }: { linkId: string; limit: number; before?: string | number }) => pageOf(rows.filter((m) => m.linkId === linkId), { limit, before })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

type Page = { messages: { id: string; replyTo?: Record<string, unknown> }[] };
const quote = (page: Page, id: string) => page.messages.find((m) => m.id === id)?.replyTo;

describe("a reply whose original is gone", () => {
  // The newest page of 4: peer_kept is in it, peer_old outside it, peer_gone deleted.
  const rows = [row("chat-one", "peer_old", 1), row("chat-one", "peer_kept", 2),
    row("chat-one", "me_a", 3, { sender: "me", ...reply("peer_gone", "take this back") }),
    row("chat-one", "me_b", 4, { sender: "me", ...reply("peer_old", "older") }),
    row("chat-one", "me_c", 5, { sender: "me", ...reply("peer_kept", "kept") }),
    row("group:g1", "k:1:0", 6, { member: "k" }), row("group:g1", "mine:1:1", 7, { sender: "me", ...reply("k:0:9", "gone in the group") }),
    row("group:g1", "mine:1:2", 8, { sender: "me", ...reply("k:1:0", "still here") })];

  it("is not found and keeps none of its text, in a page, with --after and in a group; one still here is found", async () => {
    const { ctx, node } = fake(rows);
    const page = await callApi(ctx, "chat.history", { chat: "Alice", limit: 4 }) as Page;
    expect(quote(page, "me_a")).toEqual({ id: "peer_gone", snippet: "", from: "peer", found: false, deleted: true });
    expect(quote(page, "me_b")).toMatchObject({ id: "peer_old", snippet: "older", found: true });
    expect(quote(page, "me_c")).toMatchObject({ id: "peer_kept", snippet: "kept", found: true });
    // One row read for each original not in the page, never the whole history.
    expect(node.getMessages).not.toHaveBeenCalled();
    expect(node.getMessage.mock.calls.map(([, id]) => id).sort()).toEqual(["peer_gone", "peer_old"]);

    const after = await callApi(ctx, "chat.history", { chat: "Alice", after: "peer_kept" }) as Page;
    expect(quote(after, "me_a")).toMatchObject({ snippet: "", found: false, deleted: true });
    expect(quote(after, "me_b")).toMatchObject({ snippet: "older", found: true });

    // Many originals outside the page: the history read once, not a row each.
    const many = [...Array.from({ length: 40 }, (_, i) => row("chat-one", `peer_${i}`, 10 + i)),
      ...Array.from({ length: 40 }, (_, i) => row("chat-one", `me_r${i}`, 100 + i, { sender: "me", ...reply(i % 2 ? `peer_${i}` : `peer_x${i}`, "q") }))];
    const busy = fake(many);
    const long = await callApi(busy.ctx, "chat.history", { chat: "Alice", limit: 40 }) as Page;
    expect(busy.node.getMessage).not.toHaveBeenCalled();
    expect(busy.node.getMessages).toHaveBeenCalledOnce();
    expect(long.messages.filter((m) => m.replyTo?.deleted).length).toBe(20);

    const crew = await callApi(ctx, "group.history", { group: "Crew" }) as Page;
    expect(quote(crew, "mine:1:1")).toMatchObject({ snippet: "", found: false, deleted: true });
    expect(quote(crew, "mine:1:2")).toMatchObject({ snippet: "still here", found: true });
  });
});
