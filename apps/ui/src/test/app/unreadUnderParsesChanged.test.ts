import { afterEach, describe, expect, it, vi } from "vitest";
import { unreadUnder } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";

// covers: profiles.switcher

/**
 * Another profile's unread count (the account switcher's glance) is read again at each of its chats' writes in another
 * window: only the chat whose stored copy changed is parsed again, and the count is the same as reading them all.
 */
const PREFIX = "ghostly_small1234_";
const chat = (id: string, peer: number, older = 0): ChatSession => ({
  id, profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", createdAt: 1, older,
  messages: [
    { id: `${id}-a`, text: "hi", sender: "me", timestamp: 1 },
    ...Array.from({ length: peer }, (_, i) => ({ id: `${id}-${i}`, text: "hi", sender: "peer" as const, timestamp: 2 + i })),
    { id: `${id}-call`, text: "", sender: "peer", timestamp: 99, callEvent: { type: "call_missed", count: 3 } },
  ],
});
const store = (session: ChatSession) => localStorage.setItem(`${PREFIX}${session.id}`, JSON.stringify(session));

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("another profile's unread count", () => {
  it("parses only the chats that changed since it was last read, and counts as before", () => {
    for (let i = 0; i < 20; i++) store(chat(`c${i}`, 2));
    localStorage.setItem(`${PREFIX}read_c0`, "2");
    localStorage.setItem(`${PREFIX}draft_c0`, "typing");
    const first = unreadUnder(PREFIX);

    // The same count read with nothing remembered: a copy under a prefix never read before.
    let copies = 0;
    const fresh = () => {
      const copy = `ghostly_fresh${++copies}_`;
      for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.setItem(copy + key.slice(PREFIX.length), localStorage.getItem(key)!);
      return unreadUnder(copy);
    };
    const parse = vi.spyOn(JSON, "parse");
    const chatsParsed = () => parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes("\"mySeedB64\"")).length;
    expect(unreadUnder(PREFIX), "nothing changed").toBe(first);
    expect(chatsParsed()).toBe(0);

    store(chat("c5", 4));
    localStorage.setItem(`${PREFIX}read_c1`, "3");
    const second = unreadUnder(PREFIX);
    expect(chatsParsed(), "the chat written again, not its 19 neighbours").toBe(1);
    expect(second).toBe(fresh());

    localStorage.removeItem(`${PREFIX}c7`);
    store(chat("c8", 1, 5));
    localStorage.setItem(`${PREFIX}read_c8`, "6");
    parse.mockClear();
    const third = unreadUnder(PREFIX);
    expect(chatsParsed()).toBe(1);
    expect(third).toBe(fresh());

    // 20 chats of 2 + a missed-call line of 3; c0 read past its first 2; then c5 up 2, c1 down 2; then c7 gone, c8 down 1.
    expect([first, second, third]).toEqual([99, 99, 93]);
  });
});
