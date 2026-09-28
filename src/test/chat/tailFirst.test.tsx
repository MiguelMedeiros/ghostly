import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawEveryRow, FIRST_ROWS, MORE_ROWS, useTailFirst } from "../../hooks/useTailFirst";

// covers: chat.scroll

/** A long timeline draws its last rows first, then the older ones above, a step per task, until all are drawn. */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const step = () => act(() => { vi.advanceTimersByTime(0); });

describe("useTailFirst", () => {
  it("draws the last rows, then the older ones a step at a time, until every row", () => {
    const { result } = renderHook(({ count }) => useTailFirst(count, "chat-1", false), { initialProps: { count: 1_000 } });
    expect(result.current).toBe(1_000 - FIRST_ROWS);
    step();
    expect(result.current).toBe(1_000 - FIRST_ROWS - MORE_ROWS);
    for (let i = 0; i < 20; i++) step();
    expect(result.current).toBe(0);
  });

  it("decides when the rows come (a chat's history comes a moment after it opens), and keeps what came after", () => {
    const { result, rerender } = renderHook(({ count }) => useTailFirst(count, "chat-1", false), { initialProps: { count: 0 } });
    expect(result.current).toBe(0);
    rerender({ count: 500 });
    expect(result.current).toBe(500 - FIRST_ROWS);
    // A message arrives meanwhile: the rows drawn stay drawn, the new one with them.
    rerender({ count: 501 });
    expect(result.current).toBe(500 - FIRST_ROWS);
  });

  it("draws a short timeline, or one opening on a message further up, whole", () => {
    expect(renderHook(() => useTailFirst(FIRST_ROWS, "a", false)).result.current).toBe(0);
    expect(renderHook(() => useTailFirst(2_000, "b", true)).result.current).toBe(0);
  });

  it("draws every row at once when a row not drawn yet is asked for (a quote's original)", () => {
    const { result } = renderHook(() => useTailFirst(1_000, "chat-1", false));
    expect(result.current).toBe(1_000 - FIRST_ROWS);
    act(() => drawEveryRow());
    expect(result.current).toBe(0);
  });

  it("starts over for another timeline (a group page kept from one group to the next)", () => {
    const { result, rerender } = renderHook(({ count, key }) => useTailFirst(count, key, false), { initialProps: { count: 300, key: "g1" } });
    for (let i = 0; i < 5; i++) step();
    expect(result.current).toBe(0);
    rerender({ count: 800, key: "g2" });
    expect(result.current).toBe(800 - FIRST_ROWS);
  });
});
