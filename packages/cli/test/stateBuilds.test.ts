import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, PaymentView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.api

/**
 * Each engine state the CLI reads is built whole (a view of every chat, about 15-20 µs a chat on the daemon's thread).
 * A command that names a chat built it once per list it read: `send` twice, `payment list --chat` three times, `chat
 * forward` once per chat it forwards to. At 10,000 chats a `send` took 0.4-1 s. One lookup builds it once.
 */
function fake() {
  const links = Array.from({ length: 3 }, (_, i) => ({
    id: `chat${i}`, label: `Friend ${i}`, peerPubKeyZ32: `p${i}`, peerParticipationKey: `k${i}`, createdAt: i, lastMessageAt: 0, pairing: { status: "ready" },
  }) as unknown as LinkView);
  const payment = { id: "pay1", linkId: "chat0", kind: "payment", direction: "out", amount: 5, createdAt: 1, status: "done" } as unknown as PaymentView;
  const s = {
    links, groups: [{ id: "crew", name: "Crew", members: [] } as unknown as GroupView],
    settings: { nick: "Bot" }, transport: {}, transfers: {}, payments: { pay1: payment },
  } as unknown as EngineState;
  const node = {
    getState: vi.fn(() => s),
    getSettings: vi.fn(() => s.settings),
    sendMessage: vi.fn(async () => ({ messageId: "me_1" })),
    getMessage: vi.fn(async (linkId: string, id: string) => ({ linkId, id, text: "hi", sender: "me", timestamp: 1, delivery: "sent" })),
    forwardMessages: vi.fn(async () => ({})),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("a command naming a chat", () => {
  it("builds the engine state once to find it", async () => {
    const { ctx, node } = fake();
    const builds = async (method: string, params: Record<string, unknown>) => {
      node.getState.mockClear();
      await callApi(ctx, method, params).catch(() => {});
      return node.getState.mock.calls.length;
    };
    expect(await callApi(ctx, "chat.send", { chat: "Friend 1", text: "hi", wait: "none" })).toMatchObject({ chat: "chat1", messageId: "me_1" });
    expect(await builds("chat.send", { chat: "Friend 1", text: "hi", wait: "none" })).toBe(1);
    expect(await callApi(ctx, "payment.list", { chat: "Friend 0" })).toMatchObject({ payments: [{ id: "pay1" }] });
    expect(await builds("payment.list", { chat: "Friend 0" })).toBe(1);
    expect(await builds("chat.forward", { chat: "Friend 0", messages: ["me_1"], to: ["Friend 1", "Friend 2", "Crew"] })).toBe(1);
    expect(node.getMessage).toHaveBeenCalled();
  });
});

describe("a command reading a setting", () => {
  it("builds no engine state", async () => {
    const { ctx, node } = fake();
    for (const method of ["settings.get", "profile.get"]) await callApi(ctx, method, {});
    expect(node.getSettings).toHaveBeenCalledTimes(2);
    expect(node.getState).not.toHaveBeenCalled();
  });
});
