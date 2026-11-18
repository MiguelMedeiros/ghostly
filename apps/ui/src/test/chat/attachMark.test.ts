import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { engine } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: extension.engine

/*
 * The extension's pages share their stored chats, and the peer tells each page a mark once what changed up to it was
 * sent. The page keeps it with the chats, once they hold all of it, and its next connection (a tab reloaded or another
 * opened) comes with it: the peer sends no chat unchanged since. Each tab used to get every chat's newest 400 rows again,
 * 51 MiB of JSON at 300 chats, though the stored chats had them all.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

const NOW = Date.now();
const MARK_KEY = "ghostly_engine_mark";

async function storedChat(id: string) {
  const peer = id.repeat(52);
  const linkId = `link-${id}`;
  const row = (i: number): StoredMessage => ({ linkId, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (100 - i) * 1_000, via: "datalink" });
  const stored: ChatSession = {
    id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", createdAt: NOW - 200_000,
    messages: Array.from({ length: 10 }, (_, i) => { const m = row(i); return { id: m.id, text: m.text, sender: "peer", timestamp: m.timestamp }; }),
  };
  localStorage.setItem(`ghostly_${id}`, JSON.stringify(stored));
  fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
  const { startSessionSync } = await import("@ghostly/browser/platform/sync");
  startSessionSync();
  return { linkId, row, history: (n: number) => Array.from({ length: n }, (_, i) => row(i)) };
}

const storedTexts = (id: string) => (JSON.parse(localStorage.getItem(`ghostly_${id}`)!) as ChatSession).messages.map((m) => m.text);

describe("the peer's mark, kept with the stored chats", () => {
  it("is kept once what changed before it is in the stored chats, and the next connection comes with it", async () => {
    const { linkId, row, history } = await storedChat("a");
    fakeEngine.newestPage(linkId, history(10));
    // A message the change tick still holds when the mark comes: it is in the stored chat before the mark is.
    fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(10)], deleted: [] });
    expect(storedTexts("a")).not.toContain("message 10");
    fakeEngine.emit({ kind: "mark", epoch: "engine-1", mark: 7 });
    expect(storedTexts("a")).toContain("message 10");
    expect(JSON.parse(localStorage.getItem(MARK_KEY)!)).toEqual({ epoch: "engine-1", mark: 7 });

    // The peer goes away and the page connects again: with the mark.
    fakeEngine.drop();
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(fakeEngine.connectedSince[fakeEngine.connectedSince.length - 1]).toEqual({ epoch: "engine-1", mark: 7 });
  });

  it("leaves a chat the peer did not send not whole here: the open chat asks for its whole history", async () => {
    const { linkId } = await storedChat("b");
    fakeEngine.emit({ kind: "mark", epoch: "engine-1", mark: 3, skipped: [linkId] });
    expect(engine.whole(linkId)).toBe(false);
    expect(fakeEngine.historyAsks).toEqual([]);
    const release = engine.keepWhole(linkId);
    expect(fakeEngine.historyAsks).toEqual([linkId]);
    release();
  });

  it("is not kept, and the one stored goes, while localStorage refuses what the page mirrors", async () => {
    const { linkId, history } = await storedChat("c");
    localStorage.setItem(MARK_KEY, JSON.stringify({ epoch: "engine-1", mark: 2 }));
    const full = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    try {
      // Two new messages the stored chat cannot take: the next page must be sent this chat again to have them.
      fakeEngine.newestPage(linkId, history(12));
      await act(() => Promise.resolve());
      expect(localStorage.getItem(MARK_KEY)).toBeNull();
      fakeEngine.emit({ kind: "mark", epoch: "engine-1", mark: 9 });
      expect(localStorage.getItem(MARK_KEY)).toBeNull();
    } finally {
      full.mockRestore();
    }
  });
});
