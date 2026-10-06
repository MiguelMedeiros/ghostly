import { afterEach, describe, expect, it, vi } from "vitest";
import { handOverCall, takeHandedCall } from "../../lib/lockedRing";

// covers: calls.lock-ring-start

describe("a call answered on the lock screen before the first unlock, handed to the unlocked chat", () => {
  afterEach(() => { vi.useRealTimers(); takeHandedCall("chat-1"); });

  it("is answered once, by its own chat, as it came", () => {
    handOverCall("chat-1", true);
    expect(takeHandedCall("chat-2")).toBeUndefined();
    expect(takeHandedCall("chat-1")).toBe(true);
    expect(takeHandedCall("chat-1")).toBeUndefined();
  });

  it("never answers a later call: a handover nobody took is gone after one ring", () => {
    vi.useFakeTimers();
    handOverCall("chat-1", false);
    vi.advanceTimersByTime(61_000);
    expect(takeHandedCall("chat-1")).toBeUndefined();
  });
});
