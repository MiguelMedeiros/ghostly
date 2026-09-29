import { startTransition, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

const DRAW_ALL = "ghostly:draw-every-row";

/** Draws every row of the timelines still drawing their older ones, before this returns: for a jump to a message. */
export function drawEveryRow(): void {
  window.dispatchEvent(new Event(DRAW_ALL));
}

/** Rows a long timeline draws first: its last ones, more than a tall window shows. */
export const FIRST_ROWS = 60;
/** Rows added above at each step after that: a few dozen milliseconds of work, with a frame between steps. */
export const MORE_ROWS = 150;

/**
 * A long timeline's first draw: only its last `FIRST_ROWS` rows, so a chat of thousands of messages shows at once. The
 * older ones come in above, `MORE_ROWS` at a time with a frame between, until every row is in the page; from then on
 * (well within a second) it is the whole history, as before, for search, a quote's jump and the rest. The rows coming
 * in above do not move the view: at the bottom it stays there, scrolled up it stays on its message (`useChatScroll`).
 *
 * The drawn part is held by its first row, not by a position: history that comes in above later (a group's newest page
 * first, then the rest) stays undrawn and comes in by steps too, and messages that come at the end are drawn at once.
 *
 * Returns the index of the first row to draw. `ids` are the rows' keys in order, `key` the timeline (another one starts
 * over) and `whole` asks for every row at once: a chat opening on a message further up, which must be in the page.
 */
export function useTailFirst(ids: readonly string[], key: string, whole: boolean): number {
  // Decided when the timeline first has rows: a chat's history comes a moment after the chat opens.
  const [state, setState] = useState<{ key: string; first: string | null; all: boolean }>({ key, first: null, all: false });
  const same = state.key === key;
  let first = same ? state.first : null;
  let all = same && state.all;
  if (!all && first === null && ids.length > 0) {
    if (whole) all = true;
    else first = ids[Math.max(0, ids.length - FIRST_ROWS)];
  }
  if (!same || state.first !== first || state.all !== all) setState({ key, first, all });
  const at = all || first === null ? 0 : ids.indexOf(first);
  // Its first row gone (deleted): every row.
  const from = Math.max(0, at);
  const latest = useRef(ids);
  latest.current = ids;

  const pending = from > 0;
  // Asked for a row not drawn yet (a quote's original): every row, now, in this very call.
  useEffect(() => {
    if (!pending) return;
    const drawAll = () => flushSync(() => setState(now => now.key === key ? { key, first: null, all: true } : now));
    window.addEventListener(DRAW_ALL, drawAll);
    return () => window.removeEventListener(DRAW_ALL, drawAll);
  }, [pending, key]);
  useEffect(() => {
    if (!pending) return;
    // A step at a time, each its own task: the page paints and answers between them.
    const timer = setTimeout(() => startTransition(() => {
      setState(now => {
        if (now.key !== key || now.all || now.first === null) return now;
        const next = latest.current.indexOf(now.first) - MORE_ROWS;
        return next <= 0 ? { key, first: null, all: true } : { key, first: latest.current[next], all: false };
      });
    }), 0);
    return () => clearTimeout(timer);
  }, [pending, key, from]);

  return from;
}
