import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawEveryRow, FIRST_ROWS, MORE_ROWS, useTailFirst } from "../../hooks/useTailFirst";

// covers: chat.scroll

/** A long timeline draws its last rows first, then the older ones above, a step per task, until all are drawn. */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const step = () => act(() => { vi.advanceTimersByTime(0); });
/** Row keys `from` to `to - 1`. */
const rows = (to: number, from = 0) => Array.from({ length: to - from }, (_, i) => `m${from + i}`);

describe("useTailFirst", () => {
  it("draws the last rows, then the older ones a step at a time, until every row", () => {
    const { result } = renderHook(({ ids }) => useTailFirst(ids, "chat-1", false), { initialProps: { ids: rows(1_000) } });
    expect(result.current).toBe(1_000 - FIRST_ROWS);
    step();
    expect(result.current).toBe(1_000 - FIRST_ROWS - MORE_ROWS);
    for (let i = 0; i < 20; i++) step();
    expect(result.current).toBe(0);
  });

  it("decides when the rows come (a chat's history comes a moment after it opens), and draws what comes after", () => {
    const { result, rerender } = renderHook(({ ids }) => useTailFirst(ids, "chat-1", false), { initialProps: { ids: rows(0) } });
    expect(result.current).toBe(0);
    rerender({ ids: rows(500) });
    expect(result.current).toBe(500 - FIRST_ROWS);
    // A message arrives meanwhile: the rows drawn stay drawn, the new one with them.
    rerender({ ids: rows(501) });
    expect(result.current).toBe(500 - FIRST_ROWS);
  });

  it("keeps older history that comes in above undrawn, and draws it by steps (a group's newest page, then the rest)", () => {
    const { result, rerender } = renderHook(({ ids }) => useTailFirst(ids, "group:g", false), { initialProps: { ids: rows(2_000, 1_950) } });
    expect(result.current).toBe(0);
    rerender({ ids: rows(2_000) });
    expect(result.current).toBe(1_950);
    step();
    expect(result.current).toBe(1_950 - MORE_ROWS);
  });

  it("draws a timeline opening on a message further up whole", () => {
    expect(renderHook(() => useTailFirst(rows(FIRST_ROWS), "a", false)).result.current).toBe(0);
    expect(renderHook(() => useTailFirst(rows(2_000), "b", true)).result.current).toBe(0);
  });

  it("draws every row at once when a row not drawn yet is asked for (a quote's original)", () => {
    const { result } = renderHook(() => useTailFirst(rows(1_000), "chat-1", false));
    expect(result.current).toBe(1_000 - FIRST_ROWS);
    act(() => drawEveryRow());
    expect(result.current).toBe(0);
  });

  it("starts over for another timeline (a group page kept from one group to the next)", () => {
    const { result, rerender } = renderHook(({ ids, key }) => useTailFirst(ids, key, false), { initialProps: { ids: rows(300), key: "g1" } });
    for (let i = 0; i < 5; i++) step();
    expect(result.current).toBe(0);
    rerender({ ids: rows(800), key: "g2" });
    expect(result.current).toBe(800 - FIRST_ROWS);
  });
});
