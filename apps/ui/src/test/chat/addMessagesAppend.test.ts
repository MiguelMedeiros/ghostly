import { afterEach, describe, expect, it, vi } from "vitest";
import { addMessages, getLastReadCount, loadSession, markSessionAsRead, saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";

// covers: chat.scroll, chat.paired.receipts

/*
 * A message arriving in a long chat (`addMessages`, as the session mirror calls it with the session it holds): it comes
 * after every message the chat has, so nothing is sorted again and nothing is looked for among the read ones. Sorting the
 * whole history and scanning it for a late row was a pass over every message of the chat per arrival.
 */

const PEER = "peer".padEnd(52, "p");
const T = 1_700_000_000_000;
const COUNT = 5_000;
const theirs = (i: number, at = T + i * 1000): ChatMessage => ({ id: `peer_${i}`, sender: "peer", text: `message ${i}`, timestamp: at });

function longChat(): ChatSession {
  const session: ChatSession = { id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: Array.from({ length: COUNT }, (_, i) => theirs(i)), createdAt: T - 1000 };
  saveSession(session);
  markSessionAsRead("chat-1");
  return loadSession("chat-1")!;
}

/** Whole-history passes: sorts and searches over arrays as long as the chat. */
function passes() {
  const counted = { sorts: 0, finds: 0 };
  const { sort, findIndex } = Array.prototype;
  vi.spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare) { if (this.length >= COUNT) counted.sorts++; return sort.call(this, compare); });
  vi.spyOn(Array.prototype, "findIndex").mockImplementation(function (this: unknown[], predicate, self) { if (this.length >= COUNT) counted.finds++; return findIndex.call(this, predicate, self); });
  return counted;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("a message arriving in a long chat", () => {
  it("is put after the others without sorting them or looking among the read ones", () => {
    const held = longChat();
    const counted = passes();
    const updated = addMessages("chat-1", [theirs(COUNT), theirs(COUNT + 1)], false, held)!;
    vi.restoreAllMocks();
    expect(counted).toEqual({ sorts: 0, finds: 0 });
    expect(updated.messages.slice(-3).map((m) => m.id)).toEqual([`peer_${COUNT - 1}`, `peer_${COUNT}`, `peer_${COUNT + 1}`]);
    // Unread: the two new ones, after every one read.
    expect(getLastReadCount("chat-1")).toBe(COUNT);
    expect(loadSession("chat-1")!.messages).toHaveLength(COUNT + 2);
  });

  it("one that was held up on its way still sorts in among the read ones, and the unread count starts from it", () => {
    const held = longChat();
    const late = theirs(COUNT, T + 10.5 * 1000);
    const updated = addMessages("chat-1", [late], false, held)!;
    expect(updated.messages[11]!.id).toBe(`peer_${COUNT}`);
    expect(getLastReadCount("chat-1")).toBe(11);
  });

  it("one the chat has already, or deleted here, is not added again", () => {
    const held = longChat();
    saveSession({ ...held, deletedIds: [`peer_${COUNT}`] });
    const updated = addMessages("chat-1", [theirs(COUNT), theirs(COUNT - 1), theirs(COUNT + 1), theirs(COUNT + 1)])!;
    expect(updated.messages.slice(-2).map((m) => m.id)).toEqual([`peer_${COUNT - 1}`, `peer_${COUNT + 1}`]);
    expect(updated.messages).toHaveLength(COUNT + 1);
  });
});
