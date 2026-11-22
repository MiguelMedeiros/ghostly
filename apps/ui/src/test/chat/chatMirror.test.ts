import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage, MessageReply, ReactionNote } from "@ghostly/browser/shared/types";
import { loadSession, saveSession, getLastReadCount, markSessionAsRead, deleteMessage } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";
import { quoteFor, replyIndex } from "../../lib/replies";

/*
 * A message arriving in an open chat was added to its session by reading the session again (a parse of its stored copy
 * and a merge with the thousands of messages it leaves out), right after the mirror had read it to find the message
 * new. The mirror hands the session it holds: the chat is read once per arrival, by the sync, not twice.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

// covers: chat.paired.storage
describe("a message arriving in a long open chat", () => {
  const NOW = Date.now();
  const N = 1_000;

  const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

  it("is added to the session the mirror holds, without reading the chat again", async () => {
    const peer = "h".repeat(52);
    const linkId = "link-h";
    const row = (i: number, patch: Partial<StoredMessage> = {}): StoredMessage =>
      ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000, ...patch }) as StoredMessage;
    saveSession({ id: "h", profile: "paired-chat/1", mySeedB64: "seed-h", peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - N * 2_000 });
    fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
    const { startSessionSync } = await import("@ghostly/browser/platform/sync");
    startSessionSync();
    fakeEngine.messages(linkId, Array.from({ length: N }, (_, i) => row(i)));
    await tick();

    // Each read of the chat's stored copy, from here on.
    const parse = JSON.parse;
    let reads = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"mySeedB64":"seed-h"')) reads++;
      return parse(text, reviver);
    });
    try {
      for (let i = 0; i < 3; i++) {
        fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(N + i, { timestamp: NOW + i })], deleted: [] });
        await tick();
      }
    } finally {
      spy.mockRestore();
    }
    // Once per arrival: the sync's own read of the chats (its reconcile, on `session-updated`), which the next mirror reuses.
    expect(reads).toBe(3);
    const session = loadSession("h")!;
    expect(session.messages).toHaveLength(N + 3);
    expect(session.messages.slice(-3).map((m) => m.text)).toEqual([`message ${N}`, `message ${N + 1}`, `message ${N + 2}`]);
  });
});

// covers: chat.paired.storage
/*
 * A contact deletes a message of theirs for everyone (WISP 400 § Delete for everyone): the engine forgets the row. A
 * 1:1 chat on the web, Desktop and the extension is a session mirrored from the engine, and the mirror added and
 * changed rows but never removed one: the message stayed in the chat, and in its stored copy, text and all.
 */

// The real sync (the setup stubs it out).
describe("a row the engine deleted, in the chat's mirror", () => {
  const NOW = Date.now();
  const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

  async function chat(id: string) {
    const peer = id.repeat(52), linkId = `link-${id}`;
    const row = (i: number): StoredMessage => ({ linkId, id: `peer_${i}`, text: `secret ${i}`, sender: "peer", timestamp: NOW - (5 - i) * 1_000 }) as StoredMessage;
    saveSession({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - 10_000 });
    fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
    const { startSessionSync } = await import("@ghostly/browser/platform/sync");
    startSessionSync();
    fakeEngine.messages(linkId, [row(0), row(1), row(2)]);
    await tick();
    expect(loadSession(id)!.messages.map((m) => m.text)).toEqual(["secret 0", "secret 1", "secret 2"]);
    const stored = () => Object.keys(localStorage).filter((k) => localStorage.getItem(k)?.includes("secret 1"));
    return { linkId, row, stored };
  }

  it("a row the engine deleted, told as a change, leaves the chat and its stored copy, as a delete here does", async () => {
    const { linkId, stored } = await chat("a");
    markSessionAsRead("a");
    expect(getLastReadCount("a")).toBe(3);
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [], deleted: ["peer_1"] });
    await tick();
    const session = loadSession("a")!;
    expect(session.messages.map((m) => m.text)).toEqual(["secret 0", "secret 2"]);
    expect(session.deletedIds).toContain("peer_1");
    // It was read: the read count goes with it, so nothing reads as unread.
    expect(getLastReadCount("a")).toBe(2);
    expect(stored()).toEqual([]);
  });

  it("only the rows the change names go: a whole list without a row (one a page is behind on) takes none away", async () => {
    const { linkId, row } = await chat("b");
    fakeEngine.messages(linkId, [row(0), row(2)]);
    await tick();
    expect(loadSession("b")!.messages.map((m) => m.id)).toEqual(["peer_0", "peer_1", "peer_2"]);
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [], deleted: ["peer_2", "call_1"] });
    await tick();
    expect(loadSession("b")!.messages.map((m) => m.id)).toEqual(["peer_0", "peer_1"]);
  });

  it("a removal no page heard (the extension's engine ran with none open) leaves the chat with the next whole list, which names it", async () => {
    const { linkId, row, stored } = await chat("c");
    markSessionAsRead("c");
    fakeEngine.messages(linkId, [row(0), row(2)], ["older_9", "peer_1"]);
    await tick();
    const session = loadSession("c")!;
    expect(session.messages.map((m) => m.id)).toEqual(["peer_0", "peer_2"]);
    expect(session.deletedIds).toContain("peer_1");
    expect(getLastReadCount("c")).toBe(2);
    expect(stored()).toEqual([]);
  });

  it("a removal still in the change tick when a whole list comes goes with that list", async () => {
    const { linkId, row } = await chat("d");
    // The whole list takes the tick's place (it holds what changed): the tick's deletion is told by the list.
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [], deleted: ["peer_1"] });
    fakeEngine.messages(linkId, [row(0), row(2)], ["peer_1"]);
    await tick();
    expect(loadSession("d")!.messages.map((m) => m.id)).toEqual(["peer_0", "peer_2"]);
  });
});

// covers: chat.paired.storage
/*
 * A message deleted for everyone (WISP 400 § Delete for everyone): the engine blanks the quote of the replies to it,
 * which keep only its id. A 1:1 chat on the web, Desktop and the extension is a session mirrored from the engine, and
 * the mirror took a reply's quote only as the reply came: the removed message's words stayed in the reply's stored
 * copy, and in its bubble when that quote was one the engine had not checked.
 */

// The real sync (the setup stubs it out).
describe("the quotes of a message deleted for everyone, in the chat's mirror", () => {
  const NOW = Date.now();
  const WORDS = "the words that went";
  const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

  async function chat(id: string) {
    const peer = id.repeat(52), linkId = `link-${id}`;
    const at = (i: number) => NOW - (5 - i) * 1_000;
    const original = { linkId, id: "peer_1", text: WORDS, sender: "peer", timestamp: at(1) } as StoredMessage;
    // The contact's reply, its quote as their app said it (not checked here), and mine, checked.
    const quoted: MessageReply = { id: "1", snippet: WORDS, from: "peer" };
    const theirs = (replyTo: MessageReply) => ({ linkId, id: "peer_2", text: "theirs", sender: "peer", timestamp: at(2), replyTo }) as StoredMessage;
    const mine = (replyTo: MessageReply) => ({ linkId, id: "me_3", text: "mine", sender: "me", delivery: "delivered", timestamp: at(3), replyTo }) as StoredMessage;
    saveSession({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - 10_000 });
    fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
    const { startSessionSync } = await import("@ghostly/browser/platform/sync");
    startSessionSync();
    fakeEngine.messages(linkId, [original, theirs(quoted), mine({ ...quoted, messageId: "peer_1" })]);
    await tick();
    expect(loadSession(id)!.messages.map((m) => m.id)).toEqual(["peer_1", "peer_2", "me_3"]);
    // What the engine holds once it forgot the quote: its id, who wrote it, no words.
    const blank: MessageReply = { id: "1", snippet: "", from: "peer", messageId: "peer_1" };
    const stored = () => Object.keys(localStorage).filter((k) => localStorage.getItem(k)?.includes(WORDS));
    return { linkId, replies: [theirs(blank), mine(blank)], stored };
  }

  function expectForgotten(id: string, stored: () => string[]) {
    const session = loadSession(id)!;
    expect(session.messages.map((m) => m.id)).toEqual(["peer_2", "me_3"]);
    for (const reply of session.messages) {
      expect(reply.replyTo).toEqual({ id: "1", snippet: "", from: "peer", messageId: "peer_1" });
      // The bubble says the original was deleted, with no line of it.
      expect(quoteFor(reply.replyTo!, replyIndex(session.messages), () => "Ana")).toMatchObject({ state: "deleted", snippet: "" });
    }
    expect(stored()).toEqual([]);
  }

  it("the replies to a message deleted for everyone lose its words in the chat's stored copy, as the engine's do", async () => {
    const { linkId, replies, stored } = await chat("a");
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [], deleted: ["peer_1"] });
    await tick();
    // The engine's sweep of the quotes comes after the removal, as a change of the replies.
    fakeEngine.emit({ kind: "message-changes", linkId, messages: replies, deleted: [] });
    await tick();
    expectForgotten("a", stored);
  });

  it("a whole list with the quotes forgotten (a removal no page heard) takes them in too", async () => {
    const { linkId, replies, stored } = await chat("b");
    fakeEngine.messages(linkId, replies, ["peer_1"]);
    await tick();
    expectForgotten("b", stored);
  });
});

// covers: chat.reactions
/*
 * The chat list's reaction line ("You reacted 👍 to "…"") quotes its message. Deleted here, the message's quote stayed
 * in the chat's session, shown and stored, as long as the engine said no newer reaction: the session took only newer
 * notes, and the engine's note after a delete is an older one, or none.
 */

// The real sync (the setup stubs it out).
describe("the chat list's reaction line of a message deleted here", () => {
  const NOW = Date.now();
  const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

  it("a message deleted here takes its reaction line with it, back to the one before that still stands, or none", async () => {
    const id = "r", peer = id.repeat(52), linkId = `link-${id}`;
    const row = (i: number): StoredMessage => ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (5 - i) * 1_000 }) as StoredMessage;
    const note = (i: number, at: number): ReactionNote => ({ at, by: "me", emoji: "👍", snippet: `message ${i}`, mine: false, message: `peer_${i}` });
    const link = (lastReaction?: ReactionNote) => linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1", ...(lastReaction && { lastReaction }) });
    saveSession({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - 10_000 });
    fakeEngine.update({ links: [link(note(2, NOW))] });
    const { startSessionSync } = await import("@ghostly/browser/platform/sync");
    startSessionSync();
    fakeEngine.messages(linkId, [row(0), row(1), row(2)]);
    await tick();
    expect(loadSession(id)!.lastReaction).toMatchObject({ snippet: "message 2" });

    deleteMessage(id, "peer_2");
    // A state the engine sent before it took the delete still names it: not shown again.
    fakeEngine.update({ links: [link(note(2, NOW))] });
    await tick();
    expect(loadSession(id)!.lastReaction).toBeUndefined();
    // Then the engine's note before it, older.
    fakeEngine.update({ links: [link(note(0, NOW - 5_000))] });
    await tick();
    expect(loadSession(id)!.lastReaction).toMatchObject({ snippet: "message 0" });

    deleteMessage(id, "peer_0");
    fakeEngine.update({ links: [link()] });
    await tick();
    expect(loadSession(id)!.lastReaction).toBeUndefined();
    expect(Object.keys(localStorage).filter((k) => localStorage.getItem(k)?.includes("message 0"))).toEqual([]);
  });
});
