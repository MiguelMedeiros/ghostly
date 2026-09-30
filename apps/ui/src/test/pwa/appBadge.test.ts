import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeCount, canBadge, resetAppBadge, showAppBadge } from "../../lib/appBadge";
import { groupChat, setChatMute, setMentionsNotify } from "../../lib/chatMute";
import { markGroupRead } from "../../lib/groups";
import { getPrefix } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";

// covers: app.attention.badge

const NOW = 1_800_000_000_000;
const message = (id: string) => ({ id, text: id, sender: "peer", timestamp: NOW - 1000 }) as ChatMessage;
const session = (id: string, messages: number, read = 0): ChatSession => {
  if (read) localStorage.setItem(`${getPrefix()}read_${id}`, String(read));
  return { id, mySeedB64: "s", peerPubKeyB64: `peer-${id}`, encKeyB64: "e", createdAt: 0, messages: Array.from({ length: messages }, (_, i) => message(`${id}-${i}`)) } as ChatSession;
};

describe("the number on the app's icon", () => {
  it("counts unread messages in 1:1 chats", () => {
    expect(badgeCount([session("a", 3), session("b", 5, 4), session("c", 2, 2)], [], NOW)).toBe(4);
  });

  it("leaves a muted chat out, until its mute ends", () => {
    setChatMute("a", NOW + 60_000);
    setChatMute("b", "forever");
    const chats = [session("a", 3), session("b", 2), session("c", 1)];
    expect(badgeCount(chats, [], NOW)).toBe(1);
    expect(badgeCount(chats, [], NOW + 120_000)).toBe(4);
  });

  it("counts one for each group with something new, not an invitation, and not a muted group", () => {
    markGroupRead("read", NOW - 500);
    setChatMute(groupChat("muted"), "forever");
    const groups = [
      { id: "new", lastMessageAt: NOW - 100 },
      { id: "read", lastMessageAt: NOW - 1000 },
      { id: "invited", lastMessageAt: NOW - 100, invitation: {} },
      { id: "muted", lastMessageAt: NOW - 100 },
    ];
    expect(badgeCount([], groups, NOW)).toBe(1);
  });

  it("a group whose newest message is mine (a forward to several chats) has nothing new", () => {
    markGroupRead("mine", NOW - 500);
    expect(badgeCount([], [{ id: "mine", lastMessageAt: NOW - 100, lastPeerMessageAt: NOW - 1000 }], NOW)).toBe(0);
    expect(badgeCount([], [{ id: "mine", lastMessageAt: NOW - 100, lastPeerMessageAt: NOW - 100 }], NOW)).toBe(1);
  });

  it("a mention gets through a muted group's mute, unless the group keeps mentions quiet too", () => {
    setChatMute(groupChat("g"), "forever");
    const groups = [{ id: "g", lastMessageAt: NOW - 100, lastMentionAt: NOW - 100 }];
    expect(badgeCount([], groups, NOW)).toBe(1);
    setMentionsNotify(groupChat("g"), false);
    expect(badgeCount([], groups, NOW)).toBe(0);
  });
});

describe("showing it", () => {
  const nav = { setAppBadge: vi.fn(() => Promise.resolve()), clearAppBadge: vi.fn(() => Promise.resolve()) };
  beforeEach(() => {
    resetAppBadge();
    nav.setAppBadge.mockClear();
    nav.clearAppBadge.mockClear();
  });
  afterEach(() => resetAppBadge());

  it("sets the number, clears it at 0, and sends only a change", () => {
    showAppBadge(3, nav);
    showAppBadge(3, nav);
    expect(nav.setAppBadge).toHaveBeenCalledTimes(1);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    showAppBadge(0, nav);
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("does nothing where there is no badge, and a refusal is not an error", async () => {
    expect(canBadge({})).toBe(false);
    expect(() => showAppBadge(2, {})).not.toThrow();
    const refusing = { setAppBadge: vi.fn(() => Promise.reject(new DOMException("not installed", "NotAllowedError"))) };
    expect(() => showAppBadge(2, refusing)).not.toThrow();
    const throwing = { setAppBadge: vi.fn(() => { throw new Error("no"); }) };
    resetAppBadge();
    expect(() => showAppBadge(5, throwing)).not.toThrow();
    await Promise.resolve();
  });
});
