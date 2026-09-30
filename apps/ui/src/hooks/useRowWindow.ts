import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Rows a timeline opens with: its last ones, several screens of them. */
export const OPEN_ROWS = 100;
/** Rows added at an edge of the window when the view nears it. */
export const PAGE_ROWS = 100;
/** Most rows in the page at once: past this, the rows at the far end of the window go. */
export const MAX_ROWS = 300;

const REVEAL = "ghostly:reveal-message";

/**
 * Brings a message of an open timeline into the page when it is not there (a quote's original, a search's match, a
 * Tasks row, the pinned message), before this returns: a window of rows around it takes the place of the drawn ones.
 * False when no open timeline has it.
 */
export function revealMessage(id: string): boolean {
  const event = new CustomEvent<{ id: string; found: boolean }>(REVEAL, { detail: { id, found: false } });
  window.dispatchEvent(event);
  return event.detail.found;
}

/** What `useRowWindow` gives: the rows to draw and the ways to move them. */
export interface RowWindow {
  /** Index of the first row to draw. */
  from: number;
  /** Index after the last row to draw. */
  to: number;
  /** The last rows are not drawn: the window is somewhere up the history, and its end is not the timeline's. */
  detached: boolean;
  /** `PAGE_ROWS` more at that edge; the far edge gives up rows past `MAX_ROWS`. False when there are none. */
  more(edge: "up" | "down"): boolean;
  /** Back on the timeline's last rows (the ↓ button, a message I send). `sync`: in the page before this returns. */
  attach(sync?: boolean): void;
  /** The window around this row, in the page before this returns (see `revealMessage`). False when it is no row here. */
  reveal(id: string): boolean;
}

interface State {
  key: string;
  /** Rows came and the window was decided: before that there is nothing to hold. */
  decided: boolean;
  /** The first row drawn, and where it was (a deleted row's place). */
  first: string | null;
  firstAt: number;
  /** The last row drawn; null: every row to the end, new ones as they come. */
  last: string | null;
  lastAt: number;
}

const idle = (key: string): State => ({ key, decided: false, first: null, firstAt: 0, last: null, lastAt: 0 });

/** Where a row is, by its id; a row gone (deleted) is found where it was. */
function place(ids: readonly string[], id: string, at: number): number {
  const i = ids[at] === id ? at : ids.indexOf(id);
  return i >= 0 ? i : Math.max(0, Math.min(at, ids.length - 1));
}

/** The window of rows `from` to `to` (exclusive): held by its edge rows, the end left open when it reaches it. */
function span(key: string, ids: readonly string[], from: number, to: number): State {
  from = Math.max(0, from);
  to = Math.min(ids.length, to);
  const end = to >= ids.length;
  return { key, decided: true, first: ids[from] ?? null, firstAt: from, last: end ? null : ids[to - 1], lastAt: end ? 0 : to - 1 };
}

/** The window around row `at`: `PAGE_ROWS` on each side, to the end when the end is that near. */
function around(key: string, ids: readonly string[], at: number): State {
  return span(key, ids, at - PAGE_ROWS, at + PAGE_ROWS + 1);
}

/**
 * The rows of a long timeline in the page: a window of them, never the whole history. A chat opens on its last
 * `OPEN_ROWS` (or around the message it was left on, `opensOn`); as the view nears an edge the window takes in
 * `PAGE_ROWS` more there, and past `MAX_ROWS` the rows at the other end go. The page's size stays bounded however long
 * the history is: a chat of 20,000 messages opens, scrolls and answers as one of 200 does.
 *
 * The window is held by its edge rows, not by positions: older history coming in above later (a group's newest page
 * first, then the rest) stays out of the page until the view goes up to it (past the `OPEN_ROWS` the end always has),
 * and messages coming at the end are drawn
 * while the window reaches the end. `useChatScroll` keeps the view where it was when rows come or go above it.
 *
 * `ids` are the rows' keys in order and `key` the timeline (another one starts over). `heads` maps a row folded into a
 * run (a bot's stacked routines) to the run's first row: the window never starts inside a run.
 */
export function useRowWindow(ids: readonly string[], key: string, { opensOn, heads }: { opensOn?: string | null; heads?: ReadonlyMap<string, string> } = {}): RowWindow {
  const [held, setHeld] = useState<State>(() => idle(key));
  let state = held.key === key ? held : idle(key);
  if (!state.decided && ids.length > 0) {
    const on = opensOn ? ids.indexOf(opensOn) : -1;
    state = on >= 0 ? around(key, ids, on) : span(key, ids, ids.length - OPEN_ROWS, ids.length);
  }
  if (state !== held) setHeld(state);

  let from = state.first === null ? 0 : place(ids, state.first, state.firstAt);
  const to = state.last === null ? ids.length : Math.max(from, place(ids, state.last, state.lastAt)) + 1;
  // At the end, never fewer than a chat opens with: a first page shorter than that (a group's newest page, what the engine
  // last sent) takes in the rows that come above it, up to `OPEN_ROWS`.
  if (state.last === null && to - from < OPEN_ROWS) from = Math.max(0, to - OPEN_ROWS);
  // Never inside a run of stacked rows: from its first row, which draws the whole run.
  const head = heads?.get(ids[from]);
  if (head !== undefined) { const at = ids.lastIndexOf(head, from); if (at >= 0) from = at; }

  const now = useRef({ ids, from, to, key });
  now.current = { ids, from, to, key };

  // The ways to move it: made once, reading the latest rows.
  const [moves] = useState((): Pick<RowWindow, "more" | "attach" | "reveal"> => ({
    more(edge) {
      const { ids, from, to, key } = now.current;
      if (edge === "up") {
        if (from <= 0) return false;
        const start = Math.max(0, from - PAGE_ROWS);
        setHeld(span(key, ids, start, Math.min(to, start + MAX_ROWS)));
        return true;
      }
      if (to >= ids.length) return false;
      const end = Math.min(ids.length, to + PAGE_ROWS);
      setHeld(span(key, ids, Math.max(from, end - MAX_ROWS), end));
      return true;
    },
    attach(sync = false) {
      const { ids, to, key } = now.current;
      if (to >= ids.length) return;
      const tail = () => setHeld(span(key, ids, ids.length - OPEN_ROWS, ids.length));
      if (sync) flushSync(tail); else tail();
    },
    reveal(id) {
      const { ids, from, to, key } = now.current;
      const at = ids.indexOf(id);
      if (at < 0) return false;
      if (at >= from && at < to) return true;
      flushSync(() => setHeld(around(key, ids, at)));
      return true;
    },
  }));

  useEffect(() => {
    const onReveal = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; found: boolean }>).detail;
      if (!detail.found && moves.reveal(detail.id)) detail.found = true;
    };
    window.addEventListener(REVEAL, onReveal);
    return () => window.removeEventListener(REVEAL, onReveal);
  }, [moves]);

  const detached = to < ids.length;
  return useMemo(() => ({ ...moves, from, to, detached }), [moves, from, to, detached]);
}
