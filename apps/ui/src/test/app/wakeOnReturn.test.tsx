import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { engine } from "@ghostly/browser/platform/engine";
import { SLEPT_LATE_MS, WAKE_TICK_MS, useWakeOnReturn } from "../../hooks/useWakeOnReturn";

// covers: chat.paired.reconnect

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const wakes = (call: { mock: { calls: unknown[][] } }) => call.mock.calls.filter(([method]) => method === "wake").length;

describe("Back from a sleep the window says nothing about", () => {
  it("wakes the engine when its timer fires far later than set, with no focus or visibility event", () => {
    const call = vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    renderHook(() => useWakeOnReturn());
    // Awake: the ticks come on time, and nothing is asked of the engine.
    act(() => { vi.advanceTimersByTime(WAKE_TICK_MS * 6); });
    expect(wakes(call)).toBe(0);
    // A sleep: the clock moves on while no timer runs, then the next tick fires minutes late.
    vi.setSystemTime(Date.now() + 180_000);
    act(() => { vi.advanceTimersByTime(WAKE_TICK_MS); });
    expect(wakes(call)).toBe(1);
  });

  it("does not wake on a tick only a little late (a busy page), nor twice for a focus that came with the wake", () => {
    const call = vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    renderHook(() => useWakeOnReturn());
    vi.setSystemTime(Date.now() + SLEPT_LATE_MS / 2);
    act(() => { vi.advanceTimersByTime(WAKE_TICK_MS); });
    expect(wakes(call)).toBe(0);
    // An unlock gives a focus at the wake, a second before the late tick: one wake, not two.
    vi.setSystemTime(Date.now() + 180_000);
    act(() => { vi.advanceTimersByTime(WAKE_TICK_MS - 1_000); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(wakes(call)).toBe(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(wakes(call)).toBe(1);
  });
});
