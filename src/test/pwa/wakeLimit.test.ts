import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WAKE_NOTICE_GAP_MS, wakeNoticeDue } from "../../../web/src/sw/policy";
import { resetWakeLimitMemory, takeWakeSlot } from "../../../web/src/sw/wakeLimit";

// covers: push.wake.notify, push.wake.call

/**
 * The push worker's own limit on wake-ups (web/src/sw/sw.ts): a contact's app keeps to one wake-up per 5 minutes,
 * but one that does not could fill the screen with "Incoming call" notices that stay until dismissed. Per token,
 * at most one call notice per 30 s and one message notice per 5 minutes; what was shown last survives the worker
 * being stopped between pushes.
 */
const T0 = 1_800_000_000_000;

afterEach(() => {
  resetWakeLimitMemory();
  vi.unstubAllGlobals();
});

describe("when a wake-up may show", () => {
  it("the first one always; then one call per 30 s and one message per 5 minutes", () => {
    expect(WAKE_NOTICE_GAP_MS).toEqual({ call: 30_000, message: 300_000 });
    expect(wakeNoticeDue(undefined, true, T0)).toBe(true);
    expect(wakeNoticeDue(T0, true, T0 + 29_999)).toBe(false);
    expect(wakeNoticeDue(T0, true, T0 + 30_000)).toBe(true);
    expect(wakeNoticeDue(T0, false, T0 + 299_999)).toBe(false);
    expect(wakeNoticeDue(T0, false, T0 + 300_000)).toBe(true);
    // A clock set back does not silence a token for good.
    expect(wakeNoticeDue(T0 + 60_000, true, T0)).toBe(true);
  });
});

describe("the worker's record of what it showed", () => {
  it("lets a flood of call wake-ups from one token through once per 30 s", async () => {
    const shown: number[] = [];
    for (let second = 0; second < 90; second++) {
      if (await takeWakeSlot("", "tok-flood", true, T0 + second * 1000)) shown.push(second);
    }
    expect(shown).toEqual([0, 30, 60]);
  });

  it("counts messages apart from calls, tokens apart, and profiles apart", async () => {
    expect(await takeWakeSlot("", "tok-a", true, T0)).toBe(true);
    expect(await takeWakeSlot("", "tok-a", false, T0 + 1)).toBe(true);
    expect(await takeWakeSlot("", "tok-a", false, T0 + 60_000)).toBe(false);
    expect(await takeWakeSlot("", "tok-b", false, T0 + 60_000)).toBe(true);
    expect(await takeWakeSlot("work", "tok-a", false, T0 + 60_000)).toBe(true);
    expect(await takeWakeSlot("", "tok-a", false, T0 + 300_001)).toBe(true);
  });

  it("keeps it in IndexedDB, so a worker started afresh still knows", async () => {
    expect(await takeWakeSlot("", "tok-kept", true, T0)).toBe(true);
    resetWakeLimitMemory();
    expect(await takeWakeSlot("", "tok-kept", true, T0 + 5_000)).toBe(false);
  });

  it("two pushes handled at once show one notice", async () => {
    const both = await Promise.all([takeWakeSlot("", "tok-race", true, T0), takeWakeSlot("", "tok-race", true, T0)]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it("falls back to memory when IndexedDB cannot be used", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await takeWakeSlot("", "tok-mem", true, T0)).toBe(true);
    expect(await takeWakeSlot("", "tok-mem", true, T0 + 1_000)).toBe(false);
    expect(await takeWakeSlot("", "tok-mem", true, T0 + 30_000)).toBe(true);
  });
});
