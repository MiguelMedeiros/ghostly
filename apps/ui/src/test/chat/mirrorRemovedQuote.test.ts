import { expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { MessageReply, StoredMessage } from "@ghostly/browser/shared/types";
import { loadSession, saveSession } from "../../lib/storage";
import { quoteFor, replyIndex } from "../../lib/replies";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * A message deleted for everyone (WISP 400 § Delete for everyone): the engine blanks the quote of the replies to it,
 * which keep only its id. A 1:1 chat on the web, Desktop and the extension is a session mirrored from the engine, and
 * the mirror took a reply's quote only as the reply came: the removed message's words stayed in the reply's stored
 * copy, and in its bubble when that quote was one the engine had not checked.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

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
