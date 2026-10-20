import { describe, expect, it, vi } from "vitest";
import { chatOfLink } from "../../lib/chatMute";
import { offerSession } from "../../lib/lockedRing";
import { chatNamesForPeer, deleteSession, saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chats.mute, calls.lock-ring

/*
 * Each attention event (a message arriving) found its chat by the contact's key through `listSessions()` with no cache:
 * every chat's stored copy parsed again, and a long chat's whole history merged back in, per event. Finding a chat by
 * its contact reads each chat once, and no history.
 */

const NOW = Date.now();
const key = (c: string) => c.repeat(52);
const chat = (id: string, over: Partial<ChatSession> = {}): ChatSession => ({
  id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", createdAt: NOW - 60_000,
  messages: Array.from({ length: 300 }, (_, i) => ({ id: `peer_${id}${i}`, text: `message ${i}`, sender: "peer" as const, timestamp: NOW - 50_000 + i })),
  ...over,
});
const links = ["a", "b", "c", "d"].map((c) => ({ id: `link-${c}`, peerPubKeyZ32: key(c) }));

/** How many chats' stored copies were parsed while `run` ran. */
function chatsParsed(run: () => void): number {
  const parse = vi.spyOn(JSON, "parse");
  try {
    run();
    return parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes("\"peerPubKeyB64\"")).length;
  } finally {
    parse.mockRestore();
  }
}

describe("finding a 1:1 chat by its contact", () => {
  it("parses no chat again once each was read", () => {
    for (const c of ["a", "b", "c"]) saveSession(chat(c));
    expect(chatOfLink("link-b", links)).toBe("b");
    expect(chatsParsed(() => {
      for (let i = 0; i < 20; i++) expect(chatOfLink("link-a", links)).toBe("a");
    })).toBe(0);
  });

  it("finds a chat added since and not one deleted since", () => {
    saveSession(chat("a"));
    expect(chatOfLink("link-a", links)).toBe("a");
    expect(chatOfLink("link-d", links)).toBeUndefined();
    saveSession(chat("d"));
    expect(chatOfLink("link-d", links)).toBe("d");
    deleteSession("a");
    expect(chatOfLink("link-a", links)).toBeUndefined();
  });

  it("finds the chat the list shows first when two have the same contact", () => {
    saveSession(chat("a", { lastSyncAt: NOW - 5_000 }));
    saveSession(chat("e", { peerPubKeyB64: key("a"), lastSyncAt: NOW - 1_000 }));
    expect(chatOfLink("link-a", links)).toBe("e");
  });

  it("names a contact with two chats from the one the list shows first, parsing no chat again", () => {
    saveSession(chat("a", { nick: "Ana", lastSyncAt: NOW - 5_000 }));
    saveSession(chat("e", { peerPubKeyB64: key("a"), nick: "Ana II", lastSyncAt: NOW - 1_000 }));
    // Which of the two the list shows first is read through the page's one cache: the Identities screen asks per row.
    expect(chatNamesForPeer(key("a"))).toEqual({ label: undefined, nick: "Ana II" });
    expect(chatsParsed(() => {
      for (let i = 0; i < 20; i++) expect(chatNamesForPeer(key("a"))?.nick).toBe("Ana II");
    })).toBe(0);
  });

  it("finds the chat a call offer rings in, parsing no chat again", () => {
    for (const c of ["a", "b"]) saveSession(chat(c));
    fakeEngine.update({ links: [linkView({ id: "link-b", peerPubKeyZ32: key("b") })] });
    const offer = JSON.stringify({ t: "o", ts: Date.now(), u: "x9Kq", p: "Q2m1yU7tX8nB4vL0pR6sZ3aW", f: "ab".repeat(32), s: "actpass" });
    expect(offerSession("link-b", offer)).toBe("b");
    expect(chatsParsed(() => expect(offerSession("link-b", offer)).toBe("b"))).toBe(0);
  });
});
