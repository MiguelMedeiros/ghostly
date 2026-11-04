import { expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { ReactionNote, StoredMessage } from "@ghostly/browser/shared/types";
import { deleteMessage, loadSession, saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.reactions

/*
 * The chat list's reaction line ("You reacted 👍 to "…"") quotes its message. Deleted here, the message's quote stayed
 * in the chat's session, shown and stored, as long as the engine said no newer reaction: the session took only newer
 * notes, and the engine's note after a delete is an older one, or none.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

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
