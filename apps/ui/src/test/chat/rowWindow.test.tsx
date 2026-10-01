import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_ROWS, OPEN_ROWS, PAGE_ROWS, revealMessage, useRowWindow } from "../../hooks/useRowWindow";

// covers: chat.scroll

/** A long timeline has a window of its rows in the page, never all of them: it opens on its last ones and moves by pages. */

/** Row keys `from` to `to - 1`. */
const rows = (to: number, from = 0) => Array.from({ length: to - from }, (_, i) => `m${from + i}`);
const range = (w: { from: number; to: number }) => [w.from, w.to];

describe("useRowWindow", () => {
  it("opens on the last rows, attached to the end", () => {
    const { result } = renderHook(() => useRowWindow(rows(20_000), "chat-1"));
    expect(range(result.current)).toEqual([20_000 - OPEN_ROWS, 20_000]);
    expect(result.current.detached).toBe(false);
  });

  it("draws a short timeline whole", () => {
    const { result } = renderHook(() => useRowWindow(rows(40), "chat-1"));
    expect(range(result.current)).toEqual([0, 40]);
  });

  it("decides when the rows come, and draws what comes at the end while attached", () => {
    const { result, rerender } = renderHook(({ ids }) => useRowWindow(ids, "chat-1"), { initialProps: { ids: rows(0) } });
    expect(range(result.current)).toEqual([0, 0]);
    rerender({ ids: rows(500) });
    expect(range(result.current)).toEqual([500 - OPEN_ROWS, 500]);
    rerender({ ids: rows(503) });
    expect(range(result.current)).toEqual([500 - OPEN_ROWS, 503]);
  });

  it("takes a page more above, and past the most rows lets the bottom ones go", () => {
    const { result } = renderHook(() => useRowWindow(rows(5_000), "chat-1"));
    for (let page = 1; page <= 2; page++) {
      act(() => { expect(result.current.more("up")).toBe(true); });
      expect(range(result.current)).toEqual([5_000 - OPEN_ROWS - page * PAGE_ROWS, 5_000]);
    }
    act(() => { result.current.more("up"); });
    const from = 5_000 - OPEN_ROWS - 3 * PAGE_ROWS;
    expect(range(result.current)).toEqual([from, from + MAX_ROWS]);
    expect(result.current.detached).toBe(true);
    // A message arriving now is not drawn: the window is up the history.
    const { result: grown, rerender } = renderHook(({ ids }) => useRowWindow(ids, "chat-2"), { initialProps: { ids: rows(5_000) } });
    for (let i = 0; i < 4; i++) act(() => { grown.current.more("up"); });
    const held = range(grown.current);
    rerender({ ids: rows(5_001) });
    expect(range(grown.current)).toEqual(held);
  });

  it("takes a page more below while detached, letting the top ones go, and attaches again at the end", () => {
    const { result } = renderHook(() => useRowWindow(rows(1_000), "chat-1"));
    for (let i = 0; i < 5; i++) act(() => { result.current.more("up"); });
    const [from, to] = range(result.current);
    expect(to - from).toBe(MAX_ROWS);
    act(() => { result.current.more("down"); });
    expect(range(result.current)).toEqual([from + PAGE_ROWS, to + PAGE_ROWS]);
    for (let i = 0; i < 10; i++) act(() => { result.current.more("down"); });
    expect(result.current.to).toBe(1_000);
    expect(result.current.detached).toBe(false);
    expect(result.current.more("down")).toBe(false);
  });

  it("at the end with more than its most rows (messages that came while open), trims to the last rows; otherwise leaves them", () => {
    const { result, rerender } = renderHook(({ ids }) => useRowWindow(ids, "chat-1"), { initialProps: { ids: rows(50) } });
    rerender({ ids: rows(50 + MAX_ROWS) });
    expect(range(result.current)).toEqual([0, 50 + MAX_ROWS]);
    let trimmed = false;
    act(() => { trimmed = result.current.trim(); });
    expect(trimmed).toBe(true);
    expect(range(result.current)).toEqual([50 + MAX_ROWS - OPEN_ROWS, 50 + MAX_ROWS]);
    expect(result.current.detached).toBe(false);
    // As many as the most, or up the history: nothing goes.
    act(() => { trimmed = result.current.trim(); });
    expect(trimmed).toBe(false);
    for (let i = 0; i < 4; i++) act(() => { result.current.more("up"); });
    const held = range(result.current);
    act(() => { trimmed = result.current.trim(); });
    expect(trimmed).toBe(false);
    expect(range(result.current)).toEqual(held);
  });

  it("goes back to the last rows on attach", () => {
    const { result } = renderHook(() => useRowWindow(rows(2_000), "chat-1"));
    for (let i = 0; i < 6; i++) act(() => { result.current.more("up"); });
    expect(result.current.detached).toBe(true);
    act(() => result.current.attach(true));
    expect(range(result.current)).toEqual([2_000 - OPEN_ROWS, 2_000]);
  });

  it("brings a row not drawn into the page at once, with rows around it (a quote's original)", () => {
    const { result } = renderHook(() => useRowWindow(rows(20_000), "chat-1"));
    let found = false;
    act(() => { found = revealMessage("m1234"); });
    expect(found).toBe(true);
    expect(range(result.current)).toEqual([1_234 - PAGE_ROWS, 1_234 + PAGE_ROWS + 1]);
    expect(result.current.detached).toBe(true);
    // One drawn already stays where it is; one no timeline has is not found.
    act(() => { found = revealMessage("m1200"); });
    expect(range(result.current)).toEqual([1_234 - PAGE_ROWS, 1_234 + PAGE_ROWS + 1]);
    act(() => { found = revealMessage("elsewhere"); });
    expect(found).toBe(false);
  });

  it("opens around the message it was left on", () => {
    const { result } = renderHook(() => useRowWindow(rows(9_000), "chat-1", { opensOn: "m300" }));
    expect(range(result.current)).toEqual([300 - PAGE_ROWS, 300 + PAGE_ROWS + 1]);
    const { result: gone } = renderHook(() => useRowWindow(rows(9_000), "chat-2", { opensOn: "deleted" }));
    expect(range(gone.current)).toEqual([9_000 - OPEN_ROWS, 9_000]);
  });

  it("keeps older history that comes in above out of the page, past what a chat opens with (a group's newest page, then the rest)", () => {
    const { result, rerender } = renderHook(({ ids }) => useRowWindow(ids, "group:g"), { initialProps: { ids: rows(2_000, 1_950) } });
    expect(range(result.current)).toEqual([0, 50]);
    rerender({ ids: rows(2_000) });
    expect(range(result.current)).toEqual([2_000 - OPEN_ROWS, 2_000]);
    act(() => { result.current.more("up"); });
    expect(range(result.current)).toEqual([2_000 - OPEN_ROWS - PAGE_ROWS, 2_000]);
  });

  it("opened on a list shorter than a chat opens with, takes in the rows that come above it (the engine's last copy, then the list)", () => {
    const { result, rerender } = renderHook(({ ids }) => useRowWindow(ids, "group:g"), { initialProps: { ids: rows(3, 2) } });
    expect(range(result.current)).toEqual([0, 1]);
    rerender({ ids: rows(3) });
    expect(range(result.current)).toEqual([0, 3]);
  });

  it("holds its edges by row: a row deleted at the edge leaves the window where it was", () => {
    const ids = rows(1_000);
    const { result, rerender } = renderHook(({ ids }) => useRowWindow(ids, "chat-1"), { initialProps: { ids } });
    for (let i = 0; i < 3; i++) act(() => { result.current.more("up"); });
    const [first, to] = range(result.current);
    expect(result.current.detached).toBe(true);
    // Its first row goes: the next one is first. The rows after it moved up one, and so did its last.
    rerender({ ids: ids.filter(id => id !== `m${first}`) });
    expect(range(result.current)).toEqual([first, to - 1]);
  });

  it("never starts inside a run of stacked rows", () => {
    // Rows 890 to 910 are one run of routines, headed by 890; the window would start at 900.
    const heads = new Map(rows(911, 891).map(id => [id, "m890"]));
    const { result } = renderHook(() => useRowWindow(rows(1_000), "chat-1", { heads }));
    expect(range(result.current)).toEqual([890, 1_000]);
  });

  it("starts over for another timeline", () => {
    const { result, rerender } = renderHook(({ ids, key }) => useRowWindow(ids, key), { initialProps: { ids: rows(3_000), key: "g1" } });
    for (let i = 0; i < 5; i++) act(() => { result.current.more("up"); });
    rerender({ ids: rows(800), key: "g2" });
    expect(range(result.current)).toEqual([800 - OPEN_ROWS, 800]);
  });
});
