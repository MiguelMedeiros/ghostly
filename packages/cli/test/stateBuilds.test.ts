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
  const crew = { id: "crew", name: "Crew", profile: "mesh", status: "active", members: [{ key: "me", me: true }, { key: "ann", online: true }] } as unknown as GroupView;
  const s = {
    links, groups: [crew],
    settings: { nick: "Bot" }, transport: {}, transfers: {}, payments: { pay1: payment },
  } as unknown as EngineState;
  const node = {
    getState: vi.fn(() => s),
    getSettings: vi.fn(() => s.settings),
    chatView: vi.fn((id: string) => links.find((link) => link.id === id)),
    groupView: vi.fn((id: string) => s.groups.find((group) => group.id === id)),
    sendMessage: vi.fn(async () => ({ messageId: "me_1" })),
    sendGroupMessage: vi.fn(async () => ({ error: null, messageId: "gm_1" })),
    groupTaken: vi.fn(() => 1),
    setGroupTyping: vi.fn(),
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
    // By its id (as a bot names it, from an event), only that chat's view is built.
    node.chatView.mockClear();
    expect(await builds("chat.send", { chat: "chat1", text: "hi", wait: "none" })).toBe(0);
    expect(node.chatView).toHaveBeenCalledWith("chat1");
    expect(await builds("chat.forward", { chat: "Friend 0", messages: ["me_1"], to: ["Friend 1", "Friend 2", "Crew"] })).toBe(1);
    expect(node.getMessage).toHaveBeenCalled();
  });
});

describe("a write in a chat named by its id", () => {
  it("asks whether someone joined it without building every chat", async () => {
    const { ctx, node } = fake();
    const card = { kind: "task", id: "t1", status: "running", title: "Build", startedAt: 1, updatedAt: 1 };
    const sent = { linkId: "chat1", id: "me_1", text: "", sender: "me", timestamp: 1, delivery: "sent", card };
    Object.assign(node, {
      getMessage: vi.fn(async () => sent),
      getMessages: vi.fn(async () => [sent]),
      editMessage: vi.fn(async () => ({})),
      reactToMessage: vi.fn(async () => ({})),
    });
    (ctx as unknown as { hub: unknown }).hub = { onEvent: () => () => {} };
    const builds: Record<string, number> = {};
    for (const mode of ["daemon", "one-shot"] as const) {
      (ctx as { mode: string }).mode = mode;
      for (const [method, params] of [
        ["task.send", { chat: "chat1", card: { title: "Build" }, wait: "none" }],
        ["task.update", { chat: "chat1", task: "t1", card: { step: "Tests" }, wait: "none" }],
        ["usage.send", { chat: "chat1", card: { label: "Tokens", left: 10 }, wait: "none" }],
        ["chat.edit", { chat: "chat1", message: "me_1", text: "hi again", wait: "none" }],
      ] as const) {
        node.getState.mockClear();
        await callApi(ctx, method, params);
        builds[`${mode} ${method}`] = node.getState.mock.calls.length;
      }
    }
    expect(Object.entries(builds).filter(([, n]) => n > 0)).toEqual([]);
  });
});

describe("a group command naming the group by its id", () => {
  /**
   * As a bot names it, from an event's `group`: only that group's view is built. `group send` built every chat's view
   * twice (once to find the group, once to say whether anybody else is in it), 47 ms at 2,000 chats; `--wait sent` once
   * more per poll; `group typing` twice too.
   */
  it("builds no engine state", async () => {
    const { ctx, node } = fake();
    const builds = async (method: string, params: Record<string, unknown>) => {
      node.getState.mockClear();
      const answer = await callApi(ctx, method, params);
      return { answer, builds: node.getState.mock.calls.length };
    };
    expect(await builds("group.send", { group: "crew", text: "hi" })).toMatchObject({ answer: { group: "crew", messageId: "gm_1", sent: true }, builds: 0 });
    expect(await builds("group.send", { group: "group:crew", text: "hi" })).toMatchObject({ answer: { group: "crew" }, builds: 0 });
    // No edge took it at first: the wait polls, and each poll reads the group alone.
    node.groupTaken.mockReturnValueOnce(0).mockReturnValueOnce(0);
    expect(await builds("group.send", { group: "crew", text: "hi", wait: "sent" })).toMatchObject({ answer: { sent: true, edges: 1 }, builds: 0 });
    expect(await builds("group.typing", { group: "crew" })).toMatchObject({ answer: { group: "crew", typing: true, reached: 1 }, builds: 0 });
    expect(node.groupView).toHaveBeenCalledWith("crew");
    // By its name, the list is read once.
    expect(await builds("group.send", { group: "Crew", text: "hi" })).toMatchObject({ answer: { group: "crew" }, builds: 1 });
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
