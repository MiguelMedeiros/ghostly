import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, toBase64Url } from "../src/bytes";
import { GROUP_TYPING_FRAME, GroupTypingBoard, groupTypingEpoch, openGroupTyping, sealGroupTyping, type GroupTypingFrame } from "../src/groupTyping";
import { TYPING_FRAME, TYPING_RATE_LIMIT, TYPING_TIMEOUT_MS, TypingSender, typingFrame } from "../src/pairedTyping";
// covers: group.typing

afterEach(() => { vi.useRealTimers(); });

const G = "AAAAAAAAAAAAAAAAAAAAAA";
const secret = toBase64Url(randomBytes(32));
const ANA = "ana-member-key", BO = "bo-member-key";

describe("group-typing frames", () => {
  it("seals the 1:1 word under the epoch key, bound to the group, the epoch and the sender", () => {
    const frame = sealGroupTyping(G, 3, secret, ANA, typingFrame("start", { kind: "recording" }));
    expect(frame).toMatchObject({ t: GROUP_TYPING_FRAME, g: G, e: 3 });
    // Nothing of the word is in the clear.
    expect(JSON.stringify(frame)).not.toContain("recording");
    expect(groupTypingEpoch(JSON.parse(JSON.stringify(frame)), G)).toBe(3);
    expect(openGroupTyping(frame, secret, ANA)).toEqual({ t: TYPING_FRAME, s: "start", kind: "recording" });
    // Another member replaying it on its own edge, or another epoch's secret: it does not open.
    expect(openGroupTyping(frame, secret, BO)).toBeNull();
    expect(openGroupTyping(frame, toBase64Url(randomBytes(32)), ANA)).toBeNull();
    expect(openGroupTyping({ ...frame, e: 4 }, secret, ANA)).toBeNull();
  });

  it("carries a stop and a bot's status", () => {
    expect(openGroupTyping(sealGroupTyping(G, 0, secret, ANA, typingFrame("stop")), secret, ANA)).toEqual({ t: TYPING_FRAME, s: "stop" });
    const word = typingFrame("start", { kind: "thinking", status: "Reading the thread" });
    expect(openGroupTyping(sealGroupTyping(G, 0, secret, ANA, word), secret, ANA)).toEqual(word);
  });

  it("refuses what is not a frame for this group", () => {
    const frame = sealGroupTyping(G, 1, secret, ANA, typingFrame("start"));
    expect(groupTypingEpoch(frame, "BBBBBBBBBBBBBBBBBBBBBB")).toBeNull();
    for (const bad of [null, "x", { ...frame, t: "group-msg" }, { ...frame, e: -1 }, { ...frame, e: 1.5 }, { ...frame, n: 3 }, { ...frame, c: "a".repeat(600) }])
      expect(groupTypingEpoch(bad, G)).toBeNull();
  });
});

describe("GroupTypingBoard", () => {
  const word = (s: "start" | "stop", extra: Record<string, unknown> = {}) => ({ t: TYPING_FRAME, s, ...extra });

  it("keeps each member's word with the 1:1 timeout, and clears one on its message", () => {
    vi.useFakeTimers();
    const changes = vi.fn();
    const board = new GroupTypingBoard(changes);
    board.receive(ANA, word("start"));
    board.receive(BO, word("start", { kind: "recording" }));
    expect(board.typing()).toEqual([{ member: ANA, activity: { kind: "typing" } }, { member: BO, activity: { kind: "recording" } }]);
    board.clear(ANA);
    expect(board.typing().map(t => t.member)).toEqual([BO]);
    vi.advanceTimersByTime(TYPING_TIMEOUT_MS);
    expect(board.typing()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it("never shows a status with a link or control characters", () => {
    const board = new GroupTypingBoard(() => {});
    board.receive(ANA, word("start", { kind: "thinking", status: "see https://evil.example" }));
    expect(board.typing()).toEqual([{ member: ANA, activity: { kind: "thinking" } }]);
    board.receive(BO, word("start", { status: "Look‮ing\u0007\nup" }));
    expect(board.typing()[1].activity.status).not.toMatch(/[‮\u0007\n]/);
  });

  it("holds a member who floods without holding the others, and hides who the roster took out", () => {
    let now = 0;
    const board = new GroupTypingBoard(() => {}, () => now);
    for (let i = 0; i < TYPING_RATE_LIMIT; i++) expect(board.receive(ANA, word(i % 2 ? "stop" : "start"))).toBe(true);
    expect(board.receive(ANA, word("start"))).toBe(false);
    expect(board.receive(BO, word("start"))).toBe(true);
    expect(board.typing([ANA]).map(t => t.member)).toEqual([]);
    expect(board.typing([BO]).map(t => t.member)).toEqual([BO]);
    board.clearAll();
    expect(board.typing()).toEqual([]);
  });

  it("takes a sender's frames end to end", () => {
    const sender = new TypingSender(() => 1_000);
    const board = new GroupTypingBoard(() => {});
    const sealed = sealGroupTyping(G, 0, secret, ANA, sender.typing({ kind: "typing" })!) as GroupTypingFrame;
    board.receive(ANA, openGroupTyping(sealed, secret, ANA)!);
    expect(board.typing()).toHaveLength(1);
    board.receive(ANA, openGroupTyping(sealGroupTyping(G, 0, secret, ANA, sender.stopped()!), secret, ANA)!);
    expect(board.typing()).toEqual([]);
  });
});
