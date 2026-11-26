import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaySections } from "../../components/chat/DaySections";
import { rowDays } from "../../lib/chatDays";
import { renderApp } from "../render";

// covers: chat.days

/**
 * Today and Yesterday above a chat's days stay right when the device sleeps past midnight with the chat open: timers
 * stand still while it sleeps (or while the page is frozen in the background), so the midnight one can come hours late.
 */

const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min).getTime();
type Row = { id: string; at: number };
const labels = () => screen.queryAllByTestId("chat-day").map(day => day.textContent);

beforeEach(() => { vi.useFakeTimers({ now: at(29, 23) }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function show(rows: Row[], draw = (row: Row) => <p key={row.id}>{row.id}</p>) {
  const page = (list: Row[]) => <DaySections rows={list} days={rowDays(list.map(row => row.at))} from={0} draw={draw} />;
  const utils = renderApp(page(rows));
  return { ...utils, rerender: (list: Row[]) => utils.rerender(page(list)) };
}

const wake = () => act(() => {
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
});

describe("the days of an open chat after the device slept past midnight", () => {
  const rows: Row[] = [{ id: "m1", at: at(28, 10) }, { id: "m2", at: at(29, 10) }];

  it("move on when the page comes back, before any timer runs", () => {
    show(rows);
    expect(labels()).toEqual(["Yesterday", "Today"]);
    vi.setSystemTime(at(30, 9));
    wake();
    expect(labels()).toEqual(["Wednesday, October 28", "Yesterday"]);
  });

  it("put a message that comes after it under Today, even with no event from the page", () => {
    const { rerender } = show(rows);
    vi.setSystemTime(at(30, 9));
    rerender([...rows, { id: "m3", at: at(30, 9) }]);
    expect(labels()).toEqual(["Wednesday, October 28", "Yesterday", "Today"]);
  });

  it("draw nothing again when the page comes back on the same day", () => {
    const draw = vi.fn((row: Row) => <p key={row.id}>{row.id}</p>);
    show(rows, draw);
    const drawn = draw.mock.calls.length;
    vi.setSystemTime(at(29, 23, 30));
    wake();
    expect(draw.mock.calls.length).toBe(drawn);
    expect(labels()).toEqual(["Yesterday", "Today"]);
  });

  it("stop listening to the page once the chat closes", () => {
    const add = vi.spyOn(window, "addEventListener"), drop = vi.spyOn(window, "removeEventListener");
    const addDoc = vi.spyOn(document, "addEventListener"), dropDoc = vi.spyOn(document, "removeEventListener");
    const { unmount } = show(rows);
    const focus = add.mock.calls.filter(([type]) => type === "focus").map(([, fn]) => fn);
    const visible = addDoc.mock.calls.filter(([type]) => type === "visibilitychange").map(([, fn]) => fn);
    expect(focus.length).toBeGreaterThan(0);
    expect(visible.length).toBeGreaterThan(0);
    unmount();
    for (const fn of focus) expect(drop).toHaveBeenCalledWith("focus", fn);
    for (const fn of visible) expect(dropDoc).toHaveBeenCalledWith("visibilitychange", fn);
  });
});
