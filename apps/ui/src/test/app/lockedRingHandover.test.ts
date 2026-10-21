import { afterEach, describe, expect, it, vi } from "vitest";
import { handOverCall, takeHandedCall } from "../../lib/lockedRing";

// covers: calls.lock-ring-start

const offer = (ts: number) => JSON.stringify({ t: "o", ts, u: "abcd", p: "a".repeat(22), f: "0".repeat(64), s: "actpass" });

describe("a call answered on the lock screen before the first unlock, handed to the unlocked chat", () => {
  afterEach(() => { vi.useRealTimers(); takeHandedCall("chat-1", null); });

  it("is answered once, by its own chat, as it came", () => {
    const a = offer(Date.now());
    handOverCall("chat-1", a, true);
    expect(takeHandedCall("chat-2", a)).toBeUndefined();
    expect(takeHandedCall("chat-1", a)).toBe(true);
    expect(takeHandedCall("chat-1", a)).toBeUndefined();
  });

  it("never answers a later call: a handover nobody took is gone after one ring", () => {
    vi.useFakeTimers();
    const a = offer(Date.now());
    handOverCall("chat-1", a, false);
    vi.advanceTimersByTime(61_000);
    expect(takeHandedCall("chat-1", a)).toBeUndefined();
  });

  it("answers only the offer it was pressed for: another call ringing in that chat just rings", () => {
    const now = Date.now();
    handOverCall("chat-1", offer(now - 5_000), true);
    expect(takeHandedCall("chat-1", offer(now))).toBeUndefined();
    // Dropped, not kept for later: the first offer coming back answers nothing either.
    expect(takeHandedCall("chat-1", offer(now - 5_000))).toBeUndefined();
  });

  it("hands nothing over without the offer", () => {
    handOverCall("chat-1", null, true);
    expect(takeHandedCall("chat-1", offer(Date.now()))).toBeUndefined();
  });
});
