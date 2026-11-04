import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { deleteMessage, getLastReadCount, loadSession, markSessionAsRead, saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * A message deleted for everyone in a long 1:1 chat (WISP 400 § Delete for everyone) left the session by reading the chat
 * again (a parse of its stored copy and a merge with the thousands of messages it leaves out), and then once more; the
 * write it made stopped the mirror from taking only what changed, so the same removal walked the whole history and wrote
 * the chat a second time. The author's chat then deleted the row the mirror had already taken out, reading it once more.
 * A removal costs what an arrival does: one read of the chat (the sync's own), one write.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

const NOW = Date.now();
const N = 1_000;

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

/**
 * Reads (parses) of chat `seed`'s stored copy while `run` runs, its saves (each one turns the session into its stored
 * text, written or not) and its writes.
 */
async function counted(seed: string, run: () => Promise<void> | void): Promise<{ reads: number; saves: number; writes: number }> {
  const parse = JSON.parse, stringify = JSON.stringify;
  let reads = 0, saves = 0, writes = 0;
  const parsed = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof text === "string" && text.includes(`"mySeedB64":"${seed}"`)) reads++;
    return parse(text, reviver);
  });
  const stringified = vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...args);
    if (typeof text === "string" && text.includes(`"mySeedB64":"${seed}"`)) saves++;
    return text;
  });
  const setItem = localStorage.setItem.bind(localStorage);
  const written = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
    if (value.includes(`"mySeedB64":"${seed}"`)) writes++;
    setItem(key, value);
  });
  try {
    await run();
  } finally {
    parsed.mockRestore();
    stringified.mockRestore();
    written.mockRestore();
  }
  return { reads, saves, writes };
}

describe("a message deleted for everyone in a long chat", () => {
  it("leaves the session the mirror holds: one read and one write per removal, not a whole pass", async () => {
    const id = "r";
    const peer = "r".repeat(52);
    const linkId = "link-r";
    const row = (i: number): StoredMessage => ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000 }) as StoredMessage;
    saveSession({ id, profile: "paired-chat/1", mySeedB64: "seed-r", peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - N * 2_000 });
    fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
    const { startSessionSync } = await import("@ghostly/browser/platform/sync");
    startSessionSync();
    let list = Array.from({ length: N }, (_, i) => row(i));
    fakeEngine.messages(linkId, list);
    await tick();
    markSessionAsRead(id);
    expect(getLastReadCount(id)).toBe(N);

    const removed = [N - 3, N - 7, N - 12].map((i) => `peer_${i}`);
    const counts = await counted("seed-r", async () => {
      for (const gone of removed) {
        list = list.filter((m) => m.id !== gone);
        fakeEngine.emit({ kind: "message-changes", linkId, messages: [], deleted: [gone] });
        await tick();
      }
    });
    // Once per removal: the sync's own read of the chats (its reconcile, on `session-updated`); the session saved once.
    expect(counts).toEqual({ reads: 3, saves: 3, writes: 3 });

    const session = loadSession(id)!;
    expect(session.messages).toHaveLength(N - 3);
    expect(session.messages.some((m) => removed.includes(m.id))).toBe(false);
    expect(session.deletedIds).toEqual(expect.arrayContaining(removed));
    // They were read: the read count goes with them.
    expect(getLastReadCount(id)).toBe(N - 3);

    // The author's chat deletes the row once the engine took the removal: the mirror took it out already, so the chat
    // is not read or written again for it.
    const again = await counted("seed-r", () => void expect(deleteMessage(id, removed[0])).toBeNull());
    expect(again).toEqual({ reads: 0, saves: 0, writes: 0 });

    // The next arrival is still mirrored from what changed only, after the rows that went.
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(N)].map((m) => ({ ...m, timestamp: NOW + 1 })), deleted: [] });
    await tick();
    const after = loadSession(id)!.messages;
    expect(after).toHaveLength(N - 2);
    expect(after[after.length - 1].text).toBe(`message ${N}`);
  });
});
