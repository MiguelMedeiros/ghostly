import { expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { getLastReadCount, loadSession, markSessionAsRead, saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * A contact deletes a message of theirs for everyone (WISP 400 § Delete for everyone): the engine forgets the row. A
 * 1:1 chat on the web, Desktop and the extension is a session mirrored from the engine, and the mirror added and
 * changed rows but never removed one: the message stayed in the chat, and in its stored copy, text and all.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

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
