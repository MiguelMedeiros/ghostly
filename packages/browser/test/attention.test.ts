import { describe, expect, it } from "vitest";
import { CATCH_UP_SLACK_MS, messageAttention } from "../src/engine/attention";
import type { StoredMessage } from "../src/shared/types";
// covers: app.attention.sounds

/**
 * What a newly stored row says (engine/attention.ts): only a new message at the end of its chat, or mine going out,
 * plays a sound and shows a notification. A group's history lines, files, payments, join notices, empty texts and
 * late catch-ups are quiet. Typing, edits, reactions and receipts never become rows (their tests: edits.test.ts,
 * reactions.test.ts, the e2e web/attention-quiet.spec.ts).
 */
const STARTED = 1_000_000, NOW = STARTED + 10 * 60_000;
const row = (over: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "chat-1", id: "peer_x", text: "Hello", sender: "peer", timestamp: NOW - 1_000, via: "datalink", ...over });
const at = (over: Partial<Parameters<typeof messageAttention>[2]> = {}) => ({ startedAt: STARTED, now: NOW, ...over });

describe("messageAttention", () => {
  it("a new message from the contact: a message; one that names me says so", () => {
    expect(messageAttention("message", row(), at())).toEqual({ type: "message", mention: false });
    expect(messageAttention("message", row({ mentioned: true }), at())).toEqual({ type: "message", mention: true });
    // At the end of its chat: newer than what is there, or a little behind it (another member's clock).
    expect(messageAttention("message", row(), at({ newest: NOW - 5_000 }))).toMatchObject({ type: "message" });
    expect(messageAttention("message", row({ timestamp: NOW - 30_000 }), at({ newest: NOW }))).toMatchObject({ type: "message" });
  });

  it("mine going out: sent", () => {
    expect(messageAttention("sent", row({ sender: "me", id: "me_1" }), at())).toEqual({ type: "sent", mention: false });
  });

  it("a line of a group's history is quiet, but for the one that says I made the group or joined it", () => {
    for (const event of ["admin", "rotated", "gone", "renamed", "picture", "removed", "forked"] as const)
      expect(messageAttention("message", row({ linkId: "group:g", id: `event:1:${event}:5`, event, text: "Ana is now the admin" }), at())).toBeNull();
    // Someone else joined: a line, no sound.
    expect(messageAttention("message", row({ linkId: "group:g", event: "joined", member: "k", text: "Ana joined" }), at())).toBeNull();
    expect(messageAttention("message", row({ linkId: "group:g", event: "created", text: "Group created." }), at())).toEqual({ type: "message", mention: false, cue: "group" });
    expect(messageAttention("message", row({ linkId: "group:g", event: "joined", text: "You joined." }), at())).toEqual({ type: "message", mention: false, cue: "group" });
  });

  it("files, payments, join notices and texts with nothing to show are quiet", () => {
    expect(messageAttention("message", row({ file: { id: "f" } as StoredMessage["file"] }), at())).toBeNull();
    expect(messageAttention("message", row({ paymentId: "p" }), at())).toBeNull();
    expect(messageAttention("message", row({ text: "👋 Ana joined" }), at())).toBeNull();
    expect(messageAttention("message", row({ text: "👋 joined" }), at())).toBeNull();
    expect(messageAttention("message", row({ text: "" }), at())).toBeNull();
    expect(messageAttention("message", row({ text: " \n " }), at())).toBeNull();
  });

  it("history is quiet: what was sent before this engine started, and a late catch-up that lands among older messages", () => {
    expect(messageAttention("message", row({ timestamp: STARTED - 1 }), at())).toBeNull();
    // A member hands on what I missed five minutes ago; the chat already shows newer messages.
    const old = NOW - 5 * 60_000;
    expect(messageAttention("message", row({ timestamp: old }), at({ newest: NOW - 1_000 }))).toBeNull();
    expect(messageAttention("message", row({ timestamp: NOW - CATCH_UP_SLACK_MS - 1 }), at({ newest: NOW }))).toBeNull();
    // The same late message in a chat with nothing newer is the newest thing there: it is news.
    expect(messageAttention("message", row({ timestamp: old }), at())).toMatchObject({ type: "message" });
    expect(messageAttention("message", row({ timestamp: old }), at({ newest: old - 1 }))).toMatchObject({ type: "message" });
  });
});
