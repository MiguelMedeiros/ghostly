import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../lib/types";

// covers: chat.paired.storage

/*
 * A contact who rang and hung up over and over left two lines a call ("Incoming audio call", "Missed audio call") in
 * the chat's stored copy, and none ever left: a paired chat's stored copy keeps its last `STORED_MESSAGES` rows of
 * those the engine keeps, and a call's line is one only the page keeps. 9,000 calls were 18,000 stored rows, 3 M
 * characters stringified on every later write, past WebKit's quota. A chat keeps its last call lines; older ones go
 * from this device as a deleted message does, and the unread count stays right.
 */

const NOW = 1_800_000_000_000;
const N = 1_000;
const CALLS = 500;

const storage = () => import("../../lib/storage");

/** One ring from the chat's contact, missed. */
async function ring(call: number) {
  const { addMessage } = await storage();
  const at = NOW + N + call * 10;
  addMessage("chat", { id: `system_call_call_received_${at}`, text: "Incoming audio call", sender: "system", timestamp: at, callEvent: { type: "call_received", hasVideo: false } });
  addMessage("chat", { id: `system_call_call_missed_${at}`, text: "Missed audio call", sender: "system", timestamp: at + 1, callEvent: { type: "call_missed", hasVideo: false } });
}

/** A paired chat of N messages the engine keeps, read, then CALLS rings from its contact. */
async function rungChat() {
  const { saveSession, setEngineMessages, markSessionAsRead } = await storage();
  const messages: ChatMessage[] = Array.from({ length: N }, (_, i) => ({ id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW + i }));
  const session: ChatSession = { id: "chat", profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", messages, createdAt: NOW };
  setEngineMessages("chat", new Set(messages.map((m) => m.id)));
  saveSession(session);
  markSessionAsRead("chat");
  for (let call = 0; call < CALLS; call++) await ring(call);
  return messages;
}

const storedRows = () => (JSON.parse(localStorage.getItem("ghostly_chat")!) as ChatSession).messages;

describe("a contact who rings and hangs up over and over", () => {
  it("leaves the chat's stored copy about as long as any chat's", async () => {
    const { STORED_MESSAGES, CALL_LINES, loadSession } = await storage();
    await rungChat();
    expect(storedRows().length).toBeLessThanOrEqual(STORED_MESSAGES + CALL_LINES);
    // The latest lines stay, in the stored copy and in the chat.
    const lines = loadSession("chat")!.messages.filter((m) => m.callEvent);
    expect(lines).toHaveLength(CALL_LINES);
    expect(lines[lines.length - 1]!.id).toBe(`system_call_call_missed_${NOW + N + (CALLS - 1) * 10}`);
    expect(storedRows().filter((m) => m.callEvent)).toEqual(lines);
    // Every message the engine keeps is still in the chat.
    expect(loadSession("chat")!.messages.filter((m) => !m.callEvent)).toHaveLength(N);
  });

  it("counts as unread the missed calls the chat still shows, and the next message after a reload", async () => {
    const { CALL_LINES, getUnreadCount, loadSession, markSessionAsRead } = await storage();
    const messages = await rungChat();
    expect(getUnreadCount(loadSession("chat")!)).toBe(CALL_LINES / 2);
    markSessionAsRead("chat");
    // One more: the oldest lines, read, make room for its two.
    await ring(CALLS);
    expect(getUnreadCount(loadSession("chat")!)).toBe(1);

    // The page reloads: its stored copy only, until the engine brings back the whole history.
    vi.resetModules();
    const again = await storage();
    again.setEngineMessages("chat", new Set(messages.map((m) => m.id)));
    expect(again.getUnreadCount(again.loadSession("chat")!)).toBe(1);
    again.addMessages("chat", messages, true);
    expect(again.getUnreadCount(again.loadSession("chat")!)).toBe(1);
    again.addMessage("chat", { id: "peer_new", text: "there?", sender: "peer", timestamp: NOW + N + (CALLS + 1) * 10 });
    expect(again.getUnreadCount(again.loadSession("chat")!)).toBe(2);
  });
});
