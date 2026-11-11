import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** From this many rows the chat list draws a window of them; a shorter list draws every row, as it always did. */
export const WINDOW_FROM = 60;
/** Rows drawn in each part of the list before it is laid out once and its view is known. */
export const FIRST_ROWS = 30;
/** How far past the view's edges rows are drawn (a screen at least): a scroll or a Tab finds them there already. */
const NEAR_PX = 600;

/** A row in the list, drawn or a space (`data-row-space`); keyed as the list keys them: a chat's id, or `group:<id>`. */
const ROWS = "[data-row-space],[data-chat],[data-group]";
const rowKey = (row: Element) => row.getAttribute("data-row-space") ?? row.getAttribute("data-chat") ?? (row.hasAttribute("data-group") ? `group:${row.getAttribute("data-group")}` : null);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const same = (a: ReadonlySet<string> | null, b: ReadonlySet<string>) => !!a && a.size === b.size && [...b].every(key => a.has(key));

/** The heights of the rows drawn so far, by key, and the usual one: the room each takes once it is a space. */
interface Sizes { heights: Map<string, number>; typical: number }

/**
 * The rows in `list` near its view, by key; the heights of the ones drawn go to `sizes`. Null while the list is not laid
 * out (hidden behind an open chat on a phone): every row would be at its top, near, and drawn.
 */
function look(list: HTMLElement, sizes: Sizes): Set<string> | null {
  const view = list.getBoundingClientRect();
  if (view.height === 0) return null;
  const margin = Math.max(NEAR_PX, view.height);
  const found = new Set<string>(), drawn: [string, number][] = [];
  for (const row of list.querySelectorAll(ROWS)) {
    const key = rowKey(row);
    if (key === null) continue;
    const at = row.getBoundingClientRect();
    if (!row.hasAttribute("data-row-space") && at.height > 0) drawn.push([key, at.height]);
    if (at.bottom >= view.top - margin && at.top <= view.bottom + margin) found.add(key);
  }
  // Most rows drawn changed height together (a Text size step, a density): the heights kept from before are no longer
  // theirs. One row that grew (a longer last message) changes only its own.
  const known = drawn.filter(([key]) => sizes.heights.has(key));
  if (known.filter(([key, h]) => sizes.heights.get(key) !== h).length * 2 > known.length) sizes.heights.clear();
  for (const [key, h] of drawn) sizes.heights.set(key, h);
  if (drawn.length) sizes.typical = median(drawn.map(([, h]) => h));
  return found;
}

/** What `useListWindow` gives: which rows to draw, and the room a row not drawn takes. */
export interface ListWindow {
  /** The row is drawn. `at`: its place in its part of the list (a folder, the rows in no folder). */
  drawn(key: string, at: number): boolean;
  /** The height a row not drawn keeps for it, in pixels: what it had when it was drawn last. */
  space(key: string): number;
}

/**
 * The chat list's rows in the page: only the ones near its view, the rest a space of their height. Everything that
 * restyles the whole page (Light/Dark, a color theme, a Text size step, a language, the window crossing a width
 * breakpoint) paid for every chat in the list, on screen or not: with 300 chats a theme change took ~0.75 s of the main
 * thread against ~0.2 s with 5. Off (`on` false: a short list, or the rail) every row is drawn.
 *
 * `box` is the list that scrolls. The rows near its view are found after each draw, before it is painted, and at each
 * scroll and resize. The row the focus was last in stays drawn; the list keeps others drawn itself (the open chat's,
 * which `useOpenRowInView` scrolls to; an invitation; a row in the hand). A space keeps the row's `data-reorder-id`
 * (Sidebar.tsx), so a pinned row dragged among others is put at the place it is let go at. `fallback`: the height of a
 * row never drawn, before any row was.
 */
export function useListWindow(box: RefObject<HTMLElement | null>, { on, fallback }: { on: boolean; fallback: number }): ListWindow {
  const [near, setNear] = useState<ReadonlySet<string> | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const sizes = useRef<Sizes>({ heights: new Map(), typical: 0 });

  // After every draw, before it is painted: a row that came near (a chat moved to the top, a search) is never a blank.
  // It settles: a draw that brings no other row near sets the same set, which draws nothing more. (After every draw: what
  // a draw changed is in the page, not in this hook's inputs.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const list = box.current;
    if (!on || !list) return;
    const found = look(list, sizes.current);
    if (found) setNear(was => (same(was, found) ? was : found));
  });

  useEffect(() => {
    const list = box.current;
    if (!on || !list) return;
    let frame: number | undefined;
    const soon = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        const found = look(list, sizes.current);
        if (found) setNear(was => (same(was, found) ? was : found));
      });
    };
    const focus = (e: FocusEvent) => {
      const row = e.target instanceof Element ? e.target.closest(ROWS) : null;
      const key = row && rowKey(row);
      if (key) setFocused(key);
    };
    list.addEventListener("scroll", soon, { passive: true });
    list.addEventListener("focusin", focus);
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(soon);
    resized?.observe(list);
    return () => {
      list.removeEventListener("scroll", soon);
      list.removeEventListener("focusin", focus);
      resized?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [on, box]);

  return {
    drawn: (key, at) => !on || key === focused || (near === null ? at < FIRST_ROWS : near.has(key)),
    space: key => sizes.current.heights.get(key) ?? (sizes.current.typical || fallback),
  };
}
