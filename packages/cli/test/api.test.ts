import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, Settings, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, findChat, mentionsFor, redactSettings, type ApiContext } from "../src/api";
import type { GhostlyEvent } from "../src/events";
// covers: headless.api, headless.engine-passthrough, headless.secret-guard, headless.typing

/** The API over a fake engine: what it checks before the engine is asked, and what it makes of the answers. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", ...fields }) as unknown as LinkView;
const group: GroupView = {
  id: "g1", name: "Crew", createdAt: 1, profile: "community", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [
    { key: "mekey", role: "admin", me: true, online: true, missing: 0 },
    { key: "abcd1234zz", role: "member", me: false, online: true, missing: 0, nick: "Ana" },
    { key: "abce9999yy", role: "member", me: false, online: true, missing: 0, nick: "Bo" },
  ],
} as unknown as GroupView;

function fake(messages: StoredMessage[] = []) {
  const listeners = new Set<(e: GhostlyEvent) => void>();
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" }), link("chat-two", { peerNick: "Bob" })], groups: [group], settings: { online: true, nick: "Bot", relays: ["r"], holdStorage: { s3: { accessKeyId: "AK", secretAccessKey: "SK" } }, avatar: "data:x" } as unknown as Settings, transport: { protocol: "p", relays: [] } }) as unknown as EngineState,
    getMessages: vi.fn(async () => messages),
    sendMessage: vi.fn(async () => ({ error: null, messageId: "me_1" })),
    sendGroupMessage: vi.fn(async () => ({ error: null })),
    walletCreate: vi.fn(async () => ({ id: "w" })),
    payRequest: vi.fn(async () => undefined),
    storeMessage: vi.fn(),
    updateSettings: vi.fn(async () => undefined),
    setTyping: vi.fn(),
  };
  const ctx = {
    runtime: { server: { node }, paths: { name: "default" } },
    hub: { onEvent: (l: (e: GhostlyEvent) => void) => { listeners.add(l); return () => listeners.delete(l); }, onState: () => () => {}, lastSeq: 0, replay: () => [] },
    mode: "daemon", version: "test",
  } as unknown as ApiContext;
  return { ctx, node, emit: (e: GhostlyEvent) => { for (const l of listeners) l(e); } };
}

const msg = (id: string, timestamp: number, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "chat-one", id, text: id, sender: "peer", timestamp, via: "datalink", ...fields });

describe("chats", () => {
  it("are found by id, unique prefix or name, never by a guess", () => {
    const links = [link("abc1", { label: "Alice" }), link("abc2", { peerNick: "Bob" })];
    expect(findChat(links, "abc1").id).toBe("abc1");
    expect(findChat(links, "bob").id).toBe("abc2");
    expect(() => findChat(links, "abc")).toThrow(/more than one/);
    expect(() => findChat(links, "zed")).toThrow(/No chat/);
  });

  it("send refuses a seed or ecash unless forced, and reports the message it kept", async () => {
    const { ctx, node } = fake([msg("me_1", 5, { sender: "me", delivery: "sending" })]);
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbXX1dfQ" })).rejects.toMatchObject({ code: "confirm" });
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "legal winner thank year wave sausage worth useful legal winner thank yellow" })).rejects.toMatchObject({ code: "confirm" });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(await callApi(ctx, "chat.send", { chat: "Alice", text: "hi" })).toEqual({ chat: "chat-one", messageId: "me_1", delivery: "sending" });
    await callApi(ctx, "chat.send", { chat: "Alice", text: "legal winner thank year wave sausage worth useful legal winner thank yellow", force: true });
    expect(node.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("typing tells the engine this side writes, or stopped, and says whether the chat is live", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.typing", { chat: "Alice" })).toEqual({ chat: "chat-one", typing: true, kind: "typing", live: false, sendTyping: true });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true });
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", stop: true })).toMatchObject({ typing: false });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: false });
    await expect(callApi(ctx, "chat.typing", { chat: "zed" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("typing says a kind and a bot's status, checked before anything is said", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", kind: "recording" })).toMatchObject({ typing: true, kind: "recording" });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true, kind: "recording" });
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", kind: "thinking", status: "Transcribing your\naudio…" }))
      .toMatchObject({ typing: true, kind: "thinking", status: "Transcribing your audio…" });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true, kind: "thinking", status: "Transcribing your audio…" });
    // A status with plain typing is fine too.
    await callApi(ctx, "chat.typing", { chat: "Alice", status: "Reading" });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true, status: "Reading" });
    node.setTyping.mockClear();
    for (const [params, message] of [
      [{ kind: "dancing" }, "kind must be one of typing, recording, thinking"],
      [{ status: "x".repeat(41) }, "status: at most 40 characters"],
      [{ status: "see https://x.example" }, "status: plain text, with no link or markup"],
      [{ status: "<b>hi</b>" }, "status: plain text, with no link or markup"],
      [{ status: "\u202E\u200B" }, "status: plain text, with no link or markup"],
      [{ stop: true, kind: "thinking" }, "kind and status go with a start, not with stop"],
      [{ stop: true, status: "done" }, "kind and status go with a start, not with stop"],
    ] as const) await expect(callApi(ctx, "chat.typing", { chat: "Alice", ...params }), message).rejects.toMatchObject({ code: "bad_request", message });
    expect(node.setTyping).not.toHaveBeenCalled();
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", status: "x".repeat(40) })).toMatchObject({ status: "x".repeat(40) });
  });

  it("send waits for the delivery it was asked for, and fails with the engine's words", async () => {
    const stored = [msg("me_1", 5, { sender: "me", delivery: "sending" })];
    const { ctx, emit } = fake(stored);
    const sent = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 5 });
    await new Promise((r) => setTimeout(r, 10));
    stored[0] = { ...stored[0], delivery: "delivered" };
    emit({ seq: 1, id: "x", type: "message.delivery", at: 1, chat: "chat-one", messageId: "me_1" });
    expect(await sent).toMatchObject({ delivery: "delivered" });

    stored[0] = { ...stored[0], delivery: "failed", deliveryError: "Peer is gone" };
    await expect(callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "sent" })).rejects.toMatchObject({ code: "engine", message: "Peer is gone" });
  });

  it("history pages oldest first, before and after a message or a time", async () => {
    const { ctx } = fake([msg("c", 3), msg("a", 1), msg("b", 2), msg("d", 4)]);
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", limit: 2 })).toMatchObject({ messages: [{ id: "c" }, { id: "d" }], more: true });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", before: "c" })).toMatchObject({ messages: [{ id: "a" }, { id: "b" }], more: false });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: 1, limit: 2 })).toMatchObject({ messages: [{ id: "b" }, { id: "c" }], more: true });
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", before: "zz" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", limit: -1 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("remove needs a yes", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "chat.remove", { chat: "chat-one" })).rejects.toMatchObject({ code: "confirm" });
  });
});

describe("the engine passthrough", () => {
  it("reaches only the app's calls", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "engine.call", { method: "storeMessage", params: {} })).rejects.toMatchObject({ code: "not_found" });
    expect(node.storeMessage).not.toHaveBeenCalled();
    expect(await callApi(ctx, "engine.call", { method: "walletCreate", params: { type: "cashu" } })).toEqual({ id: "w" });
  });

  it("refuses a real-money confirmation it was not given", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "engine.call", { method: "payRequest", params: { linkId: "x", paymentId: "y", confirmedReal: true } })).rejects.toMatchObject({ code: "confirm" });
    expect(node.payRequest).not.toHaveBeenCalled();
    await callApi(ctx, "engine.call", { method: "payRequest", params: { linkId: "x", paymentId: "y", confirmedReal: true }, confirmReal: true });
    expect(node.payRequest).toHaveBeenCalledWith({ linkId: "x", paymentId: "y", confirmedReal: true });
  });
});

describe("groups", () => {
  it("mentions are members written as @name in the text, in code points", () => {
    expect(mentionsFor("hi @Ana and 👋 @bo", ["Ana", "abce"], group)).toEqual([{ k: "abcd1234zz", o: 3, l: 4 }, { k: "abce9999yy", o: 14, l: 3 }]);
    expect(mentionsFor("@everyone look", ["everyone"], group)).toEqual([{ k: "*", o: 0, l: 9 }]);
    expect(() => mentionsFor("hi", ["Ana"], group)).toThrow(/Write @Ana/);
    expect(() => mentionsFor("@abc hi", ["abc"], group)).toThrow(/more than one/);
    expect(() => mentionsFor("@x", ["nobody"], group)).toThrow(/No member/);
  });

  it("send passes the mentions to the engine", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "group.send", { group: "Crew", text: "@Ana ping", mentions: ["Ana"] });
    expect(node.sendGroupMessage).toHaveBeenCalledWith({ groupId: "g1", text: "@Ana ping", mentions: [{ k: "abcd1234zz", o: 0, l: 4 }] });
  });
});

describe("settings", () => {
  it("hide credentials unless asked, and change only what the CLI manages", async () => {
    const { ctx, node } = fake();
    const shown = await callApi(ctx, "settings.get", {}) as Record<string, unknown>;
    expect(JSON.stringify(shown)).not.toContain("SK");
    expect(shown).toMatchObject({ avatar: "<set>", holdStorage: { s3: { accessKeyId: "AK", secretAccessKey: "<hidden>" } } });
    expect(JSON.stringify(redactSettings({ holdStorage: { s3: { secretAccessKey: "SK" } } } as unknown as Settings, true))).toContain("SK");
    await expect(callApi(ctx, "settings.set", { mints: [] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "settings.set", { relays: "x" })).rejects.toMatchObject({ code: "bad_request" });
    await callApi(ctx, "settings.set", { relays: ["http://127.0.0.1:1"], readRelays: true });
    expect(node.updateSettings).toHaveBeenCalledWith({ settings: { relays: ["http://127.0.0.1:1"], readRelays: true } });
  });
});
