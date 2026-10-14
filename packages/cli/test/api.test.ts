import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAITING_PEER_MS, OwnInviteError, type PairingProgress } from "@ghostly/core";
import type { EngineState, GroupView, LinkView, Settings, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, findChat, findGroup, hideStateSecrets, mentionsFor, redactSettings, type ApiContext } from "../src/api";
import { chatOrGroup, findChatOrGroup } from "../src/apiKit";
import { parseArgs } from "../src/args";
import { COMMANDS } from "../src/commands";
import type { GhostlyEvent } from "../src/events";
import { chatJson, isLive } from "../src/views";
import { pageOf } from "./support/messagePage";
// covers: headless.api, headless.engine-passthrough, headless.secret-guard, headless.typing, chat.order

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
    getMessage: vi.fn(async (_linkId: string, id: string) => messages.find((m) => m.id === id)),
    messagePage: vi.fn(async (params: { limit?: number; before?: string | number }) => pageOf(messages, params)),
    sendMessage: vi.fn(async () => ({ error: null, messageId: "me_1" })),
    sendGroupMessage: vi.fn(async () => ({ error: null })),
    walletCreate: vi.fn(async () => ({ id: "w" })),
    payRequest: vi.fn(async () => undefined),
    storeMessage: vi.fn(),
    updateSettings: vi.fn(async () => undefined),
    setChatTransport: vi.fn(async () => undefined),
    setTyping: vi.fn(),
    setGroupTyping: vi.fn(),
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

  // `invite join <your own invite>` said the engine's tag for its RPC clients: "own-invite <chat id>: This is your own…".
  it("joining your own invite is refused in a sentence alone, with the chat that owns it as its own field", async () => {
    const { ctx, node } = fake();
    const said = "This is your own invite. Share it with a contact; they join with it.";
    for (const thrown of [new OwnInviteError("chat-one"), new Error(new OwnInviteError("chat-one").message)]) {
      Object.assign(node, { joinLink: vi.fn(async () => { throw thrown; }) });
      await expect(callApi(ctx, "invite.join", { invite: "ghostly1abc" })).rejects.toMatchObject({ code: "refused", message: said, details: { chat: "chat-one" } });
    }
  });

  it("a contact's own name never stands for someone else: a key finds only its chat, a label wins over a name", () => {
    const KEY = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u";
    const alice = link("chatAlice", { label: "Alice", peerNick: "Alice", peerPubKeyZ32: KEY });
    const mallory = link("chatMallory", { peerNick: KEY });
    const impostor = link("chatImpostor", { peerNick: "alice" });
    expect(findChat([mallory, alice], KEY).id).toBe("chatAlice");
    expect(() => findChat([mallory], KEY)).toThrow(/No chat/);
    expect(findChat([impostor, alice], "Alice").id).toBe("chatAlice");
    expect(findChat([impostor], "alice").id).toBe("chatImpostor");
  });

  it("a contact's own name never takes what names a group: the group's id is the group, its name or a prefix is refused", () => {
    const GROUP = "g".repeat(22);
    const room = { ...group, id: GROUP, name: "Team Room", status: "active" } as unknown as GroupView;
    const asName = link("chatMallory", { peerNick: "Team Room" });
    const asId = link("chatIdName", { peerNick: GROUP });
    const asPrefix = link("chatPrefixName", { peerNick: "gggg" });
    const refused = (links: LinkView[], ref: string) => { try { findChatOrGroup(links, [room], ref); } catch (error) { return (error as { toJSON(): unknown }).toJSON(); } };
    expect(refused([asName], "team room")).toEqual({ code: "bad_request", message: expect.stringMatching(/names a chat .* and a group: use the chat's id or group:<id>/), details: { chat: "chatMallory", groups: [GROUP] } });
    expect(refused([asPrefix], "gggg")).toMatchObject({ code: "bad_request", details: { chat: "chatPrefixName", groups: [GROUP] } });
    expect(findChatOrGroup([asId], [room], GROUP)).toEqual({ group: room });
    // What a command makes of it: never the contact's chat.
    const ctx = { runtime: { server: { node: { getState: () => ({ links: [asName, asId], groups: [room] }) } } } } as unknown as ApiContext;
    expect(() => chatOrGroup(ctx, "Team Room")).toThrow(/and a group/);
    expect(chatOrGroup(ctx, GROUP)).toEqual({ id: GROUP, linkId: `group:${GROUP}`, group: true });
    expect(chatOrGroup(ctx, `group:${GROUP}`)).toEqual({ id: GROUP, linkId: `group:${GROUP}`, group: true });
    // The chat is still reached by its id, and by a label this side gave it.
    expect(chatOrGroup(ctx, "chatMallory")).toEqual({ id: "chatMallory", linkId: "chatMallory", group: false });
    expect(findChatOrGroup([link("chatMine", { label: "Team Room" }), asName], [room], "Team Room")).toEqual({ link: expect.objectContaining({ id: "chatMine" }) });
    // A name no group has is the contact's chat as before; so is one only an invitation has.
    expect(findChatOrGroup([link("chatBob", { peerNick: "Bob" })], [room, { ...room, id: "i".repeat(22), name: "Bob", status: undefined, invitation: {} } as unknown as GroupView], "bob")).toEqual({ link: expect.objectContaining({ id: "chatBob" }) });
    // Neither a chat nor a group: one not_found naming both, and where to look.
    expect(refused([asName], "zed")).toEqual({ code: "not_found", message: 'No chat or group "zed" (ghostly chat list, ghostly group list)' });
    expect(() => chatOrGroup(ctx, "zed")).toThrow('No chat or group "zed" (ghostly chat list, ghostly group list)');
    // An ambiguous name stays what it is, from either side; group:<id> is a group only.
    expect(refused([link("chatA", { label: "Twin" }), link("chatB", { label: "Twin" })], "twin")).toMatchObject({ code: "bad_request", message: expect.stringMatching(/more than one chat/) });
    expect(() => findChatOrGroup([], [room, { ...room, id: "h".repeat(22) } as unknown as GroupView], "team room")).toThrow(/more than one group/);
    expect(refused([asName], "group:zed")).toEqual({ code: "not_found", message: 'No group "zed"' });
    const KEY = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u";
    expect(refused([asName], KEY)).toMatchObject({ code: "not_found", message: `No chat with "${KEY}"` });
    expect(findChatOrGroup([asName], [room], "ggg")).toEqual({ group: room });
  });

  it("a command that takes a chat or a group names both when neither has the name", async () => {
    const { ctx } = fake();
    const neither = { code: "not_found", message: 'No chat or group "alcie" (ghostly chat list, ghostly group list)' };
    await expect(callApi(ctx, "chat.pin", { chat: "alcie", message: "m1" })).rejects.toMatchObject(neither);
    await expect(callApi(ctx, "chat.forward", { chat: "alcie", messages: ["m1"], to: ["Alice"] })).rejects.toMatchObject(neither);
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: ["m1"], to: ["alcie"] })).rejects.toMatchObject(neither);
    await expect(callApi(ctx, "task.send", { chat: "alcie", card: { title: "t" } })).rejects.toMatchObject(neither);
  });

  it("a group this profile is in wins over an invitation with its name or id prefix", () => {
    const mine = { ...group, id: "a".repeat(22), name: "Team Room", status: "active" } as unknown as GroupView;
    const invited = (id: string, name: string) => ({ ...group, id, name, status: undefined, invitation: { linkId: "chatMallory" } }) as unknown as GroupView;
    const sameName = invited("c".repeat(22), "Team Room"), samePrefix = invited("aaaa" + "c".repeat(18), "Other");
    expect(findGroup([mine, sameName], "Team Room").id).toBe(mine.id);
    expect(findGroup([sameName, mine, invited("d".repeat(22), "team room")], "team room").id).toBe(mine.id);
    expect(findGroup([mine, samePrefix], "aaaa").id).toBe(mine.id);
    // An invitation is still found: by its id, and by a name or prefix no group of mine has.
    expect(findGroup([mine, sameName], sameName.id).id).toBe(sameName.id);
    expect(findGroup([mine, sameName], "cccc").id).toBe(sameName.id);
    expect(findGroup([mine, samePrefix], "other").id).toBe(samePrefix.id);
    expect(() => findGroup([sameName, invited("d".repeat(22), "Team Room")], "Team Room")).toThrow(/more than one group/);
    expect(() => findGroup([mine, { ...mine, id: "b".repeat(22) } as unknown as GroupView], "Team Room")).toThrow(/more than one group/);
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

  it("a text past 16 KiB is a bad request, never handed to the engine, in a chat or a group", async () => {
    const { ctx, node } = fake();
    // 8193 two-byte letters: 16386 bytes. It used to come back as "unavailable", which reads as "try again later".
    const long = "é".repeat(8193);
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: long })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/exceeds 16384 UTF-8 bytes/) });
    await expect(callApi(ctx, "group.send", { group: "Crew", text: long })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
    // Exactly the limit, spaces around it trimmed as the engine does: it goes.
    await callApi(ctx, "chat.send", { chat: "Alice", text: `  ${"é".repeat(8192)}\n` });
    expect(node.sendMessage).toHaveBeenCalledOnce();
  });

  it("typing tells the engine this side writes, or stopped, and says whether the chat is live", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.typing", { chat: "Alice" })).toEqual({ chat: "chat-one", typing: true, kind: "typing", live: false, sendTyping: true });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true });
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", stop: true })).toMatchObject({ typing: false });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: false });
    await expect(callApi(ctx, "chat.typing", { chat: "zed" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("group typing says it in a private group, with the same checks, and refuses a community", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "group.typing", { group: "Crew" })).rejects.toMatchObject({ code: "unavailable" });
    const state = node.getState();
    const mesh = { ...group, id: "m1", name: "Mesh", profile: "mesh", status: "active",
      members: [...group.members.slice(0, 2), { ...group.members[2], online: false }] } as unknown as GroupView;
    node.getState = () => ({ ...state, groups: [mesh] });
    expect(await callApi(ctx, "group.typing", { group: "Mesh", kind: "thinking", status: "Reading the\nthread" }))
      .toEqual({ group: "m1", typing: true, kind: "thinking", status: "Reading the thread", reached: 1, sendTyping: true });
    expect(node.setGroupTyping).toHaveBeenLastCalledWith({ groupId: "m1", typing: true, kind: "thinking", status: "Reading the thread" });
    expect(await callApi(ctx, "group.typing", { group: "Mesh", stop: true })).toMatchObject({ typing: false });
    expect(node.setGroupTyping).toHaveBeenLastCalledWith({ groupId: "m1", typing: false });
    await expect(callApi(ctx, "group.typing", { group: "Mesh", status: "see https://x.example" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "group.typing", { group: "Mesh", stop: true, for: 5 })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.setGroupTyping).toHaveBeenCalledTimes(2);
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
    // A send and its wait read the message itself: in a long chat, the whole history costs each of them a read of every row.
    expect((ctx.runtime.server.node as unknown as { getMessages: ReturnType<typeof vi.fn> }).getMessages).not.toHaveBeenCalled();
  });

  it("send's wait sees a delivery that never came as message.delivery, and one that came as the time ran out", async () => {
    vi.useFakeTimers();
    try {
      const stored = [msg("me_1", 5, { sender: "me", delivery: "sending" })];
      const { ctx, emit } = fake(stored);
      // First seen by the event hub already delivered: it says message.sent, not message.delivery.
      const first = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 90 });
      await vi.advanceTimersByTimeAsync(10);
      stored[0] = { ...stored[0], delivery: "delivered" };
      emit({ seq: 1, id: "x", type: "message.sent", at: 1, chat: "chat-one", message: { id: "me_1" } });
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toMatchObject({ delivery: "delivered" });

      // Delivered with no event this side saw: the last look when the time is up says so, not a timeout.
      stored[0] = { ...stored[0], delivery: "sending" };
      const second = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 90 });
      await vi.advanceTimersByTimeAsync(89_000);
      stored[0] = { ...stored[0], delivery: "delivered" };
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await second).toMatchObject({ delivery: "delivered" });

      stored[0] = { ...stored[0], delivery: "sending" };
      const third = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 90 });
      const failed = expect(third).rejects.toMatchObject({ code: "timeout", details: { delivery: "sending" } });
      await vi.advanceTimersByTimeAsync(90_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("history pages oldest first, before and after a message or a time", async () => {
    const { ctx } = fake([msg("c", 3), msg("a", 1), msg("b", 2), msg("d", 4)]);
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", limit: 2 })).toMatchObject({ messages: [{ id: "c" }, { id: "d" }], more: true });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", before: "c" })).toMatchObject({ messages: [{ id: "a" }, { id: "b" }], more: false });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: 1, limit: 2 })).toMatchObject({ messages: [{ id: "b" }, { id: "c" }], more: true });
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", before: "zz" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", limit: -1 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("a history limit that is not a whole number is bad_request, not the engine failing", async () => {
    const { ctx } = fake([msg("a", 1), msg("b", 2)]);
    const wrong = { code: "bad_request", message: "limit must be a whole number from 1 to 10000" };
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", limit: 1.5 })).rejects.toMatchObject(wrong);
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", after: 1, limit: 1.5 })).rejects.toMatchObject(wrong);
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", limit: 0 })).rejects.toMatchObject(wrong);
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", limit: 1 })).toMatchObject({ messages: [{ id: "b" }], more: true });
  });

  it("history is in the order messages came here, whatever each sender's clock said, and gives both times", async () => {
    // As the engine stores them: `timestamp` is the row's place (when it came), `sentAt` what the contact's clock said.
    // The contact's clock was two minutes ahead for "b", and days behind for "d".
    const { ctx } = fake([msg("b", 2_000, { sentAt: 122_000 }), msg("a", 1_000, { sender: "me" }), msg("d", 4_000, { sentAt: 4_000 - 3 * 86_400_000 }), msg("c", 3_000, { sender: "me" })]);
    const page = await callApi(ctx, "chat.history", { chat: "chat-one" }) as { messages: { id: string; timestamp: number; sentAt?: number }[] };
    expect(page.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(page.messages.map((m) => m.sentAt)).toEqual([undefined, 122_000, undefined, 4_000 - 3 * 86_400_000]);
    // A time as a cursor is a place, as `timestamp` is.
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: 2_000 })).toMatchObject({ messages: [{ id: "c" }, { id: "d" }] });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", before: 3_000 })).toMatchObject({ messages: [{ id: "a" }, { id: "b" }] });
  });

  it("history cursors: digits are a time (0 from the start), seconds are refused, anything else is an id", () => {
    for (const name of ["chat history", "group history"]) {
      const command = COMMANDS[name]!;
      const params = (argv: string[]) => command.params!(parseArgs(["c1", ...argv], command.options ?? {}), { chat: "c1", group: "c1" });
      expect(params(["--after", "0"])).toMatchObject({ after: 0 });
      expect(params(["--after", "1000", "--before", "1791849403000"])).toMatchObject({ after: 1000, before: 1791849403000 });
      expect(params(["--before", "me_12"])).toMatchObject({ before: "me_12" });
      expect(() => params(["--before", "1791849403"])).toThrow(expect.objectContaining({ code: "usage", message: "--before takes milliseconds, not seconds: 1791849403000" }));
      expect(() => params(["--after", "1700000000"])).toThrow(/--after takes milliseconds, not seconds: 1700000000000/);
    }
  });

  it("remove needs a yes", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "chat.remove", { chat: "chat-one" })).rejects.toMatchObject({ code: "confirm" });
  });
});

describe("chat wait", () => {
  /** A fake engine whose state a test moves, as the daemon's hub hands each new state on. */
  function moving(first: LinkView) {
    let links = [first];
    const listeners = new Set<(s: EngineState) => void>();
    const stateOf = () => ({ links, groups: [], settings: { online: true } as unknown as Settings, transport: { protocol: "p", relays: [] } }) as unknown as EngineState;
    const ctx = {
      runtime: { server: { node: { getState: stateOf } }, paths: { name: "default" } },
      hub: { onEvent: () => () => {}, onState: (l: (s: EngineState) => void) => { listeners.add(l); return () => listeners.delete(l); }, lastSeq: 0, replay: () => [] },
      mode: "daemon", version: "test",
    } as unknown as ApiContext;
    return { ctx, set: (next: LinkView) => { links = [next]; for (const l of listeners) l(stateOf()); } };
  }
  /** Live when the app last ran (its history ends on a live stretch, WISP 100), and no session in this run yet. */
  const remembered = (fields: Partial<LinkView> = {}) => link("chat-one", {
    label: "Alice", dataLink: "idle", pairing: { status: "connecting" }, peerParticipationKey: "peerkey",
    transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }], ...fields,
  } as Partial<LinkView>);
  const session = { dataLink: "open", pairing: { status: "ready", transport: "iroh/1" }, textDelivery: "stream" } as Partial<LinkView>;

  it("a chat that was live when the daemon last ran is not live until a session exists in this run", () => {
    // Whatever the text path says: no open link and no authenticated session is not live.
    for (const text of ["stream", "dht", "hold", "unavailable"] as const) {
      const chat = remembered({ textDelivery: text });
      expect(isLive(chat), text).toBe(false);
      expect(chatJson(chat), text).toMatchObject({ live: false, transport: null });
    }
    // Each half alone is not a session either: a link open before it authenticated, a pairing with no open link.
    expect(isLive(remembered({ dataLink: "open" }))).toBe(false);
    expect(isLive(remembered({ pairing: { status: "ready", transport: "iroh/1" } } as Partial<LinkView>))).toBe(false);
    expect(isLive(remembered({ dataLink: "open", pairing: { status: "ready" } } as Partial<LinkView>))).toBe(false);
    expect(chatJson(remembered(session))).toMatchObject({ live: true, transport: "iroh/1" });
    // The older protocol has no pairing: its open link is the session.
    expect(isLive(link("old", { profile: undefined, dataLink: "open" }))).toBe(true);
    expect(isLive(link("old", { profile: undefined, dataLink: "idle" }))).toBe(false);
  });

  it("--until live waits for that session, and times out with none", async () => {
    const { ctx, set } = moving(remembered());
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "live", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    let done = false;
    const waiting = callApi(ctx, "chat.wait", { chat: "Alice", until: "live", timeout: 30 }).then((view) => { done = true; return view; });
    // The link dialling, then open and not authenticated yet: still waiting.
    set(remembered({ dataLink: "connecting" }));
    set(remembered({ dataLink: "open", pairing: { status: "negotiating" } } as Partial<LinkView>));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    set(remembered(session));
    expect(await waiting).toMatchObject({ id: "chat-one", live: true, transport: "iroh/1", text: "stream" });
    // The status line counts the same chats.
    expect(await callApi(ctx, "status", {})).toMatchObject({ chats: 1, live: 1 });
    set(remembered());
    expect(await callApi(ctx, "status", {})).toMatchObject({ chats: 1, live: 0 });
  });

  it("--until text takes the DHT floor or a hold, and --until paired the contact seen or a session, not the last run's", async () => {
    const { ctx, set } = moving(remembered({ textDelivery: "unavailable" }));
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "text", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    set(remembered({ textDelivery: "dht" }));
    expect(await callApi(ctx, "chat.wait", { chat: "Alice", until: "text", timeout: 1 })).toMatchObject({ live: false, text: "dht" });
    set(remembered({ textDelivery: "stream" }));
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "paired", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    set(remembered({ pairingProgress: { stage: "waiting", peerSeen: true } } as Partial<LinkView>));
    expect(await callApi(ctx, "chat.wait", { chat: "Alice", until: "paired", timeout: 1 })).toMatchObject({ live: false });
    set(remembered(session));
    expect(await callApi(ctx, "chat.wait", { chat: "Alice", until: "paired", timeout: 1 })).toMatchObject({ live: true });
  });
});

describe("invite create", () => {
  /** An engine whose new invite is at `progress`; `then` is the progress a later state brings. */
  function inviting(mode: "daemon" | "one-shot", progress: Partial<PairingProgress>) {
    let current = { role: "inviter", since: 0, startedAt: 0, attempt: 1, ...progress } as PairingProgress;
    const listeners = new Set<(s: EngineState) => void>();
    const stateOf = () => ({ links: [link("inv1", { pairingProgress: current })], groups: [] }) as unknown as EngineState;
    const node = { getState: stateOf, createLink: vi.fn(async () => ({ linkId: "inv1", inviteCode: "ghostly1abc" })), setActiveLink: vi.fn() };
    const ctx = {
      runtime: { server: { node }, paths: { name: "default" } },
      hub: { onEvent: () => () => {}, onState: (l: (s: EngineState) => void) => { listeners.add(l); return () => listeners.delete(l); }, lastSeq: 0, replay: () => [] },
      mode, version: "test",
    } as unknown as ApiContext;
    let answer: Record<string, unknown> | undefined;
    void callApi(ctx, "invite.create", {}).then((a) => { answer = a as Record<string, unknown>; });
    return { answer: () => answer, then: (next: Partial<PairingProgress>) => { current = { ...current, ...next }; for (const l of listeners) l(stateOf()); } };
  }

  beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }); });
  afterEach(() => { vi.useRealTimers(); });

  it("a daemon answers at once when the relays' request budget holds the invite back, and says when it goes", async () => {
    const held = inviting("daemon", { stage: "publishing", relayWaitUntil: 1_042_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(held.answer()).toEqual({ chat: "inv1", invite: "ghostly1abc", link: expect.stringContaining("ghostly1abc"), published: false, retryInMs: 42_000 });

    // Published first: so it says, with no wait.
    const out = inviting("daemon", { stage: "publishing" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.answer()).toBeUndefined();
    out.then({ stage: "waiting" });
    await vi.advanceTimersByTimeAsync(0);
    expect(out.answer()).toMatchObject({ published: true });
    expect(out.answer()).not.toHaveProperty("retryInMs");
  });

  it("a one-shot still waits for the invite to go out before it leaves, and says when it did not", async () => {
    const held = inviting("one-shot", { stage: "publishing", relayWaitUntil: 1_042_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(held.answer()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(held.answer()).toMatchObject({ published: false, retryInMs: 22_000 });
  });
});

describe("the chat on screen of a daemon", () => {
  /** A daemon whose invites are `inv1`, `inv2`…, and `join` the chats it joins; `pair` pairs one, `drop` deletes one. */
  function daemon() {
    let links: LinkView[] = [];
    const listeners = new Set<(s: EngineState) => void>();
    const stateOf = () => ({ links, groups: [] }) as unknown as EngineState;
    const push = () => { for (const l of [...listeners]) l(stateOf()); };
    let n = 0;
    const node = {
      getState: stateOf, setActiveLink: vi.fn(), renameLink: vi.fn(),
      createLink: vi.fn(async () => { const linkId = `inv${++n}`; links = [...links, link(linkId, { pairingProgress: { stage: "waiting" } } as Partial<LinkView>)]; return { linkId, inviteCode: "ghostly1" + linkId }; }),
      joinLink: vi.fn(async () => { links = [...links, link("join")]; return { linkId: "join" }; }),
    };
    const ctx = {
      runtime: { server: { node }, paths: { name: "default" } },
      hub: { onEvent: () => () => {}, onState: (l: (s: EngineState) => void) => { listeners.add(l); return () => listeners.delete(l); }, lastSeq: 0, replay: () => [] },
      mode: "daemon", version: "test",
    } as unknown as ApiContext;
    return {
      ctx, node, listeners,
      pair: (id: string) => { links = links.map((l) => l.id === id ? { ...l, peerParticipationKey: "peer-" + id } : l); push(); },
      drop: (id: string) => { links = links.filter((l) => l.id !== id); push(); },
      shown: () => node.setActiveLink.mock.calls.map(([p]) => p.linkId),
    };
  }

  it("an invite is the chat on screen until it is paired, then none is: an away contact is read at the background pace", async () => {
    const d = daemon();
    await callApi(d.ctx, "invite.create", {});
    expect(d.shown()).toEqual(["inv1"]);
    d.pair("inv1");
    expect(d.shown()).toEqual(["inv1", null]);
    // Nothing more to watch, and later states change nothing.
    expect(d.listeners.size).toBe(0);
    d.pair("inv1");
    expect(d.shown()).toEqual(["inv1", null]);

    // The joiner's side the same, and a chat deleted before it paired too; a state from before the chat was made, not.
    await callApi(d.ctx, "invite.join", { invite: "ghostly1abc" });
    d.pair("join");
    await callApi(d.ctx, "invite.create", {});
    for (const l of [...d.listeners]) l({ links: [], groups: [] } as unknown as EngineState);
    expect(d.shown()).toEqual(["inv1", null, "join", null, "inv2"]);
    d.pair("inv1");
    d.drop("inv2");
    expect(d.shown()).toEqual(["inv1", null, "join", null, "inv2", null]);
    expect(d.listeners.size).toBe(0);
  });

  it("a newer invite keeps the mark when an older one pairs, and a chat someone chose stays on screen", async () => {
    const d = daemon();
    await callApi(d.ctx, "invite.create", {});
    await callApi(d.ctx, "invite.create", {});
    d.pair("inv1");
    expect(d.shown()).toEqual(["inv1", "inv2"]);
    expect(d.listeners.size).toBe(1);

    await callApi(d.ctx, "engine.call", { method: "setActiveLink", params: { linkId: "inv2" } });
    d.pair("inv2");
    expect(d.shown()).toEqual(["inv1", "inv2", "inv2"]);
    expect(d.listeners.size).toBe(0);
  });
  it("an invite nobody joins leaves the screen once its wait for a peer is over, and a newer invite keeps its own wait", async () => {
    vi.useFakeTimers();
    try {
      const d = daemon();
      await callApi(d.ctx, "invite.create", {});
      await vi.advanceTimersByTimeAsync(AWAITING_PEER_MS - 60_000);
      // A newer invite takes the mark with a wait of its own: the older one's end does not clear it.
      await callApi(d.ctx, "invite.create", {});
      await vi.advanceTimersByTimeAsync(60_000);
      expect(d.shown()).toEqual(["inv1", "inv2"]);
      await vi.advanceTimersByTimeAsync(AWAITING_PEER_MS - 60_000);
      expect(d.shown()).toEqual(["inv1", "inv2", null]);
      expect(d.listeners.size).toBe(0);
      // Paired late, it is not marked again.
      d.pair("inv2");
      expect(d.shown()).toEqual(["inv1", "inv2", null]);

      // One paired in time leaves no timer behind that clears a chat someone chose later.
      await callApi(d.ctx, "invite.create", {});
      d.pair("inv3");
      await callApi(d.ctx, "engine.call", { method: "setActiveLink", params: { linkId: "inv1" } });
      await vi.advanceTimersByTimeAsync(AWAITING_PEER_MS);
      expect(d.shown()).toEqual(["inv1", "inv2", null, "inv3", null, "inv1"]);
    } finally {
      vi.useRealTimers();
    }
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

describe("a pending chat's invite code is a secret", () => {
  const CODE = "ghostly1pendingsecret";
  const pending = () => {
    const made = fake();
    const state = made.node.getState();
    made.node.getState = () => ({ ...state, links: [link("chat-zero"), link("chat-one", { label: "Alice", inviteCode: CODE, pairing: { status: "waiting" } } as never), link("chat-two", { peerNick: "Bob", inviteCode: CODE, pairing: { status: "ready" } } as never)] });
    return { ...made, node: { ...made.node, renameLink: vi.fn(async () => undefined), connect: vi.fn(async () => undefined), disconnect: vi.fn(), setChatTransport: vi.fn(async () => undefined) } };
  };

  it("is hidden in every chat summary unless asked for, and only list and show take the asking", async () => {
    const made = pending();
    const ctx = { ...made.ctx, runtime: { server: { node: made.node }, paths: { name: "default" } } } as unknown as ApiContext;
    expect(chatJson(link("c", { inviteCode: CODE } as never), true).invite).toBe(CODE);
    expect(chatJson(link("c")).invite).toBeNull();
    // Array.map hands the index as the second argument: it must never read as "show".
    expect(JSON.stringify([link("a"), link("b", { inviteCode: CODE } as never)].map(chatJson as never))).not.toContain(CODE);
    for (const [method, params] of [["chat.get", {}], ["chat.rename", { name: "Alice" }], ["chat.disconnect", {}], ["chat.transport", { transport: "dht" }], ["chat.wait", { until: "text", timeout: 1 }]] as const) {
      const hidden = await callApi(ctx, method, { chat: "chat-one", ...params });
      expect(JSON.stringify(hidden), method).not.toContain(CODE);
      expect(hidden, method).toMatchObject({ invite: "<hidden>" });
    }
    // Nobody took the invite: connect says so at once, without the code.
    const refused = await callApi(ctx, "chat.connect", { chat: "chat-one" }).catch((error: unknown) => error as Error);
    expect(refused).toMatchObject({ code: "unavailable" });
    expect(JSON.stringify(refused) + (refused as Error).message).not.toContain(CODE);
    const listed = await callApi(ctx, "chat.list", {}) as { chats: { id: string; invite: string | null }[] };
    expect(JSON.stringify(listed)).not.toContain(CODE);
    expect(Object.fromEntries(listed.chats.map((c) => [c.id, c.invite]))).toEqual({ "chat-zero": null, "chat-one": "<hidden>", "chat-two": null });
    expect(await callApi(ctx, "chat.get", { chat: "chat-one", showSecret: true })).toMatchObject({ invite: CODE });
    expect((await callApi(ctx, "chat.list", { showSecret: true }) as typeof listed).chats.find((c) => c.id === "chat-one")).toMatchObject({ invite: CODE });
    // Paired: the code opens nothing any more, and is not printed either way.
    expect(await callApi(ctx, "chat.get", { chat: "chat-two", showSecret: true })).toMatchObject({ invite: null });
    expect(JSON.stringify(await callApi(ctx, "chat.rename", { chat: "chat-one", name: "Alice", showSecret: true }))).not.toContain(CODE);
  });

  it("chat list and chat show ask with --show-secret; engine getState hides it too", () => {
    const flag = { "show-secret": { type: "boolean" as const, description: "" } };
    expect(COMMANDS["chat list"].params!(parseArgs([], flag), {})).toEqual({});
    expect(COMMANDS["chat list"].params!(parseArgs(["--show-secret"], flag), {})).toEqual({ showSecret: true });
    expect(COMMANDS["chat show"].params!(parseArgs(["Alice"], flag), { chat: "Alice" })).toEqual({ chat: "Alice" });
    expect(COMMANDS["chat show"].params!(parseArgs(["Alice", "--show-secret"], flag), { chat: "Alice" })).toEqual({ chat: "Alice", showSecret: true });
    const printed = hideStateSecrets({ ...pending().node.getState(), groups: [{ ...group, entryLink: "ghostly-link" }] });
    expect(JSON.stringify(printed)).not.toMatch(/ghostly1pendingsecret|ghostly-link|"SK"/);
    expect(printed.links.map((l) => l.inviteCode)).toEqual([undefined, "<hidden>", "<hidden>"]);
    expect(printed.groups[0]).toMatchObject({ entryLink: "<hidden>" });
  });
});

describe("settings", () => {
  it("hide credentials unless asked, and change only what the CLI manages", async () => {
    const { ctx, node } = fake();
    const shown = await callApi(ctx, "settings.get", {}) as Record<string, unknown>;
    expect(JSON.stringify(shown)).not.toContain("SK");
    expect(shown).toMatchObject({ avatar: "<set>", holdStorage: { s3: { accessKeyId: "AK", secretAccessKey: "<hidden>" } } });
    expect(JSON.stringify(redactSettings({ holdStorage: { s3: { secretAccessKey: "SK" } } } as unknown as Settings, true))).toContain("SK");
    const capabilities = redactSettings({ wake: { endpoint: "https://fcm.googleapis.com/x", p256dh: "P", auth: "AUTH", vapid: { publicKey: "VP", privateKey: "VK" } }, holdStorage: { s3: {}, space: "SPACE" } } as unknown as Settings);
    expect(capabilities).toMatchObject({ wake: "<set>", holdStorage: { space: "<hidden>" } });
    expect(JSON.stringify(capabilities)).not.toMatch(/fcm|AUTH|VK|SPACE/);
    await expect(callApi(ctx, "settings.set", { mints: [] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "settings.set", { relays: "x" })).rejects.toMatchObject({ code: "bad_request" });
    await callApi(ctx, "settings.set", { relays: ["http://127.0.0.1:1"], readRelays: true });
    expect(node.updateSettings).toHaveBeenCalledWith({ settings: { relays: ["http://127.0.0.1:1"], readRelays: true } });
    // ICE servers in WebRTC's form (urls a list) are taken; one without urls is a bad_request that says what to write.
    await callApi(ctx, "settings.set", { iceServers: [{ urls: ["stun:stun.example.org:3478", "stun:b.example.org"] }] });
    expect(node.updateSettings).toHaveBeenLastCalledWith({ settings: { iceServers: [{ urls: "stun:stun.example.org:3478, stun:b.example.org" }] } });
    for (const server of [{}, { url: "stun:stun.example.org" }])
      await expect(callApi(ctx, "settings.set", { iceServers: [server] })).rejects.toMatchObject({ code: "bad_request", message: "iceServers: Each ICE server needs urls: one address, or several comma-separated (turn:host:port)" });
    await expect(callApi(ctx, "settings.set", { iceServers: [{ urls: "turn:t.example.org:3478" }] })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("username and credential") });
  });

  it("say a relay address the engine refuses as a wrong value, named by its key, in a terminal's words", async () => {
    // Each was `engine` (exit 1), in the app's words ("Enter at least one relay address").
    const { ctx, node } = fake();
    const refusals: [Record<string, unknown>, string, string][] = [
      [{ relays: ["notaurl"] }, "Enter at least one relay address (https://…)", "relays: give at least one relay address (https://…)"],
      [{ irohRelays: ["x"] }, "Not a relay address: x", "irohRelays: not a relay address: x"],
      [{ hyperdhtRelay: "nope" }, "Enter a relay address (wss://…)", "hyperdhtRelay: give a relay address (wss://…)"],
    ];
    for (const [patch, engine, said] of refusals) {
      node.updateSettings.mockRejectedValueOnce(new Error(engine));
      await expect(callApi(ctx, "settings.set", patch)).rejects.toMatchObject({ code: "bad_request", message: said });
    }
  });

  it("take TCP and TLS TURN servers for the apps, and say the CLI does not use them", async () => {
    const { ctx, node } = fake();
    const turn = (urls: string) => ({ urls, username: "u", credential: "c" });
    const udp = await callApi(ctx, "settings.set", { iceServers: [turn("turn:t.example.org:3478"), turn("turn:t.example.org:3478?transport=udp")] }) as Record<string, unknown>;
    expect(udp.warning).toBeUndefined();
    const tcp = await callApi(ctx, "settings.set", { iceServers: [turn("turn:t.example.org:3478, turn:t.example.org:3478?transport=tcp"), turn("turns:t.example.org:443?transport=tcp")] }) as Record<string, unknown>;
    expect(node.updateSettings).toHaveBeenLastCalledWith({ settings: { iceServers: [turn("turn:t.example.org:3478, turn:t.example.org:3478?transport=tcp"), turn("turns:t.example.org:443?transport=tcp")] } });
    expect(tcp.warning).toBe("The CLI reaches TURN over UDP only: it does not use turn:t.example.org:3478?transport=tcp, turns:t.example.org:443?transport=tcp (the apps do). Add a turn: server over UDP for the CLI");
  });
});

/**
 * A name is looked up in a table (the settings a command changes, the transports, the methods), and every object has
 * `constructor`, `toString` and the like: they were found there too. `settings set constructor 5` stored it in the
 * profile for good, `chat transport bob constructor` handed the engine a function, and the socket's `constructor`
 * method answered with the daemon's own context, which cannot be written: the caller waited for ever.
 */
describe("a name every object has", () => {
  const NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it("is no setting: refused, and nothing is stored", async () => {
    const { ctx, node } = fake();
    for (const name of NAMES) {
      await expect(callApi(ctx, "settings.set", { [name]: 5 }), name).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining(`${name} is not a setting the CLI changes`) });
    }
    expect(node.updateSettings).not.toHaveBeenCalled();
  });

  it("is no transport: refused with the transports, and the engine is not asked", async () => {
    const { ctx, node } = fake();
    for (const name of NAMES) {
      await expect(callApi(ctx, "chat.transport", { chat: "Alice", transport: name }), name).rejects.toMatchObject({ code: "bad_request", message: "transport must be one of auto, dht, webrtc, iroh, hyperdht" });
    }
    expect(node.setChatTransport).not.toHaveBeenCalled();
  });

  it("is no method: not found, as any other unknown one", async () => {
    const { ctx } = fake();
    for (const name of [...NAMES, "nope"]) await expect(callApi(ctx, name, {}), name).rejects.toMatchObject({ code: "not_found", message: `No method ${name}` });
  });
});
