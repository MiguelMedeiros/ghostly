import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_JOIN_PREFIX,
  addMessage,
  deleteMessage,
  deleteSession,
  ensureSession,
  getUnreadCount,
  hasAnnouncedJoin,
  listSessions,
  loadSession,
  markJoinAnnounced,
  markSessionAsRead,
  peerDisplayName,
} from "../../../src/lib/storage";
import type { ChatMessage } from "../../../src/lib/types";
import { clearAllData } from "../../../src/lib/settings";
// covers: chat.paired.delete-message, chats.list.delete, app.clear-data, core.text-limits

/** Enough of the Web Storage API for the session store; node has none. */
class FakeStorage {
  private entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
  keys(): string[] {
    return [...this.entries.keys()];
  }
}

let storage: FakeStorage;

const keys = {
  seedB64: "c2VlZA",
  peerPubKeyB64: "peerpubkey",
  encKeyB64: "ZW5j",
};

beforeEach(() => {
  storage = new FakeStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});

describe("the flag that says we already announced ourselves", () => {
  it("goes with the chat when the chat is deleted", () => {
    const id = ensureSession(keys);
    markJoinAnnounced(id);
    expect(hasAnnouncedJoin(id)).toBe(true);

    deleteSession(id);

    expect(storage.keys().filter((key) => key.includes(id))).toEqual([]);
    expect(hasAnnouncedJoin(id)).toBe(false);
  });

  it("is read and taken over from where older versions kept it", () => {
    const id = ensureSession(keys);
    storage.setItem(LEGACY_JOIN_PREFIX + id, "true");

    expect(hasAnnouncedJoin(id)).toBe(true);
    markJoinAnnounced(id);
    expect(storage.getItem(LEGACY_JOIN_PREFIX + id)).toBeNull();
    expect(hasAnnouncedJoin(id)).toBe(true);

    deleteSession(id);
    expect(storage.keys().filter((key) => key.includes(id))).toEqual([]);
  });

  it("does not survive clearing all data, wherever it was kept", async () => {
    const id = ensureSession(keys);
    markJoinAnnounced(id);
    const stale = "e7c0f1a2b3c4d5e6f708192a3b4c5d6e";
    storage.setItem(LEGACY_JOIN_PREFIX + stale, "true");

    await clearAllData();

    expect(storage.keys()).toEqual([]);
    expect(listSessions()).toEqual([]);
  });
});

describe("the name a peer goes by", () => {
  it("cannot reorder or pad what it is shown next to", () => {
    expect(peerDisplayName("\u202eCasper")).toBe("Casper");
    expect(peerDisplayName("C\u200basper\ufeff")).toBe("Casper");
    expect(peerDisplayName("n".repeat(200))).toBe("n".repeat(64));
    expect(peerDisplayName("\u202e\u200b")).toBeUndefined();
    expect(peerDisplayName(undefined)).toBeUndefined();
  });
});

function peerMessage(n: number): ChatMessage {
  return { id: `peer_${n}`, text: `boo ${n}`, sender: "peer", timestamp: n * 1000 };
}

describe("deleting one message", () => {
  it("takes it out of the chat and leaves the rest in order", () => {
    const id = ensureSession(keys);
    for (const n of [1, 2, 3]) addMessage(id, peerMessage(n));

    const session = deleteMessage(id, "peer_2");

    expect(session?.messages.map((m) => m.id)).toEqual(["peer_1", "peer_3"]);
    expect(loadSession(id)?.messages.map((m) => m.id)).toEqual(["peer_1", "peer_3"]);
  });

  it("keeps it gone when the peer republishes it", () => {
    const id = ensureSession(keys);
    addMessage(id, peerMessage(1));
    deleteMessage(id, "peer_1");

    // What a poll or the peer engine's own store would hand back for minutes after.
    addMessage(id, peerMessage(1));

    expect(loadSession(id)?.messages).toEqual([]);
  });

  it("does not turn read messages into unread ones", () => {
    const id = ensureSession(keys);
    for (const n of [1, 2]) addMessage(id, peerMessage(n));
    markSessionAsRead(id);
    addMessage(id, peerMessage(3));
    expect(getUnreadCount(loadSession(id)!)).toBe(1);

    deleteMessage(id, "peer_1");

    expect(getUnreadCount(loadSession(id)!)).toBe(1);
  });

  it("says nothing happened when there is no such message or chat", () => {
    const id = ensureSession(keys);
    addMessage(id, peerMessage(1));

    expect(deleteMessage(id, "peer_9")).toBeNull();
    expect(deleteMessage("nosuchsession", "peer_1")).toBeNull();
    expect(loadSession(id)?.messages).toHaveLength(1);
  });

  it("is forgotten with the chat it was in", () => {
    const id = ensureSession(keys);
    addMessage(id, peerMessage(1));
    deleteMessage(id, "peer_1");

    deleteSession(id);

    expect(storage.keys().filter((key) => key.includes(id))).toEqual([]);
  });
});
