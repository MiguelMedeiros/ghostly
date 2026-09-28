import { startTransition, useEffect, useState } from "react";

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
 * Returns the index of the first row to draw. `count` is how many rows there are, `key` the timeline (another one starts
 * over) and `whole` asks for every row at once: a chat opening on a message further up, which must be in the page.
 */
export function useTailFirst(count: number, key: string, whole: boolean): number {
  // `from` is decided when the timeline first has rows: a chat's history comes a moment after the chat opens.
  const [state, setState] = useState<{ key: string; from: number | null }>({ key, from: null });
  let from = state.key === key ? state.from : null;
  if (from === null && count > 0) from = whole ? 0 : Math.max(0, count - FIRST_ROWS);
  if (state.key !== key || state.from !== from) setState({ key, from });

  const pending = from !== null && from > 0;
  useEffect(() => {
    if (!pending) return;
    // A step at a time, each its own task: the page paints and answers between them.
    const timer = setTimeout(() => startTransition(() => {
      setState(now => now.key === key && now.from ? { key, from: Math.max(0, now.from - MORE_ROWS) } : now);
    }), 0);
    return () => clearTimeout(timer);
  }, [pending, key, from]);

  return from ?? 0;
}
