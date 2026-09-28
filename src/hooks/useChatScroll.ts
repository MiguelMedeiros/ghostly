import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** A message row of the timeline, in order: its id (the row's `data-message-id`) and whether I sent it. */
export interface ScrollRow {
  id: string;
  mine: boolean;
}

/** This close to the bottom counts as at the bottom: a new message keeps the view there. */
export const NEAR_BOTTOM_PX = 100;
/** Further than this from the bottom, the ↓ button shows even with nothing new. */
export const FAR_FROM_BOTTOM_PX = 400;

interface Anchor {
  id: string;
  /** Where the row's top was, from the list's top edge. */
  offset: number;
}

/** Where a chat was left: at its bottom, or on a message. Kept while the app runs, so a chat opened again is where it was. */
interface Left {
  atBottom: boolean;
  anchor: Anchor | null;
}
const left = new Map<string, Left>();
/** Chats remembered at most; the oldest left goes first. */
const LEFT_MAX = 200;
function remember(chat: string, state: Left) {
  left.delete(chat);
  left.set(chat, state);
  if (left.size > LEFT_MAX) left.delete(left.keys().next().value!);
}
/** Whether the chat was left scrolled up, on a message: it opens on that message, so the message must be in the page. */
export function leftScrolledUp(chat: string): boolean {
  const was = left.get(chat);
  return !!was && !was.atBottom && !!was.anchor;
}
/** Forgets where every chat was left (for tests). */
export function forgetChatScroll() {
  left.clear();
}

const rowsOf = (list: HTMLElement) => list.querySelectorAll<HTMLElement>("[data-message-id]");
const rowById = (list: HTMLElement, id: string) => [...rowsOf(list)].find(row => row.dataset.messageId === id);
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const editable = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='menu']");

/**
 * The chat timeline's scrolling, as WhatsApp does it. At the bottom, a new message keeps the view there. Scrolled up,
 * nothing moves it: the view stays on the message it shows (not on a scroll offset, so a picture or a video loading above
 * or below keeps it in place), and the contact's new messages are counted for the ↓ pill. A message I send goes to the
 * bottom. Reactions and edits keep their message's id, so they are never new.
 *
 * At the bottom, it stays pinned there until a hand moves it: a picture, a video poster or a long message laying out after
 * the chat opened (or at any time) keeps the last message in view. A scroll event is a hand's only when the scroll
 * position moved since this hook last set or saw it; content growing under the view moves nothing, so there is no timer.
 *
 * Give `listRef` to the scrolling element and `columnRef` to the one that grows with the rows. `chat` starts it over: a
 * chat opens where it was left (on the same message, or at its bottom) with nothing counted, and one never opened opens
 * at its bottom. When the message it was left on is not among its first rows, it opens at its bottom and goes back on
 * that message once the rows bring it, unless a hand scrolled first. `keys`: End or Ctrl/Cmd+↓ (outside a text field)
 * jumps to the bottom.
 */
export function useChatScroll({ rows, chat, keys = true }: { rows: readonly ScrollRow[]; chat: string; keys?: boolean }) {
  // Elements, not refs: a list shown later (a group still joining) still gets its listeners.
  const [listEl, listRef] = useState<HTMLElement | null>(null);
  const [columnEl, columnRef] = useState<HTMLElement | null>(null);
  const list = useRef<HTMLElement | null>(null);
  list.current = listEl;
  const [count, setCount] = useState(0);
  const [far, setFar] = useState(false);
  const atBottom = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  const seen = useRef(new Set<string>());
  const opened = useRef(false);
  const firstNew = useRef<string | null>(null);
  /**
   * Where the chat was left, while its message is not among the rows yet: the first rows a chat opens with can be another
   * chat's (a group page kept across groups) or not the whole history. It opens at its bottom meanwhile, and goes back on
   * the message as soon as a later update brings it, unless a hand has scrolled first.
   */
  const pending = useRef<Left | null>(null);
  /** On the way down after ↓ or End: counts as at the bottom until it gets there, or until a hand scrolls it. */
  const following = useRef(false);
  const hasRows = useRef(false);
  hasRows.current = rows.length > 0;
  /** The scroll position as this hook last set or saw it: a scroll event that finds it unchanged is not a hand's. */
  const lastTop = useRef(0);

  const distance = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
  /** A list not on screen (a chat kept loaded for a call) has no size: nothing about it says where the view is. */
  const hidden = (el: HTMLElement) => el.clientHeight === 0;

  /** The first row not wholly above the view, and where it is. Rows are in order, so it is a binary search. */
  const capture = useCallback((el: HTMLElement) => {
    const all = rowsOf(el);
    const top = el.getBoundingClientRect().top;
    let lo = 0;
    let hi = all.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].getBoundingClientRect().bottom > top) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    anchor.current = found < 0 ? null : { id: all[found].dataset.messageId!, offset: all[found].getBoundingClientRect().top - top };
  }, []);

  const clear = useCallback(() => {
    firstNew.current = null;
    setCount(0);
  }, []);

  /** After the rows or their sizes changed: at the bottom, stay there; otherwise put the anchored row back where it was. */
  const settle = useCallback(() => {
    const el = list.current;
    if (!el || !hasRows.current || hidden(el)) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const row = rowById(el, anchor.current.id);
      if (row) {
        const moved = row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset;
        if (Math.abs(moved) >= 1) el.scrollTop += moved;
      }
    }
    lastTop.current = el.scrollTop;
    setFar(distance(el) > FAR_FROM_BOTTOM_PX);
  }, []);

  const toBottom = useCallback(() => {
    const el = list.current;
    if (!el) return;
    pending.current = null;
    atBottom.current = true;
    following.current = true;
    anchor.current = null;
    clear();
    const top = el.scrollHeight;
    if (reducedMotion() || typeof el.scrollTo !== "function") el.scrollTop = top;
    else el.scrollTo({ top, behavior: "smooth" });
    lastTop.current = el.scrollTop;
  }, [clear]);

  /** The pill: to the first message not seen yet, or to the bottom when that one is already in reach of it. */
  const toNew = useCallback(() => {
    const el = list.current;
    const id = firstNew.current;
    const row = el && id ? rowById(el, id) : undefined;
    if (!el || !row) { toBottom(); return; }
    const top = el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    if (top >= el.scrollHeight - el.clientHeight - NEAR_BOTTOM_PX) { toBottom(); return; }
    clear();
    if (reducedMotion() || typeof el.scrollTo !== "function") el.scrollTop = top;
    else el.scrollTo({ top, behavior: "smooth" });
    lastTop.current = el.scrollTop;
  }, [toBottom, clear]);

  // Another chat: it opens where it was left, with nothing counted. The one left is remembered.
  useLayoutEffect(() => {
    opened.current = false;
    following.current = false;
    seen.current = new Set();
    atBottom.current = true;
    anchor.current = null;
    firstNew.current = null;
    pending.current = null;
    setCount(0);
    setFar(false);
    return () => {
      // Opened but not back on its message yet, and no hand moved it: it is still where it was left.
      // Not from the rows on screen: when a page is kept across chats, they are already the next chat's here.
      if (pending.current) remember(chat, pending.current);
      else if (opened.current) remember(chat, { atBottom: atBottom.current, anchor: atBottom.current ? null : anchor.current });
    };
  }, [chat]);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    // No rows (yet): the list is as short as it gets, and its scroll event is not a hand's.
    if (rows.length === 0) { lastTop.current = el.scrollTop; return; }
    /** Left scrolled up: back on the same message, as far from the top of the view as it was, with nothing counted. */
    const restore = (was: Left) => {
      pending.current = null;
      seen.current = new Set(rows.map(row => row.id));
      following.current = false;
      atBottom.current = false;
      anchor.current = was.anchor;
      firstNew.current = null;
      setCount(0);
      settle();
    };
    if (!opened.current) {
      opened.current = true;
      for (const row of rows) seen.current.add(row.id);
      const was = left.get(chat);
      const back = was && !was.atBottom && was.anchor ? was : null;
      if (back && rowById(el, back.anchor!.id)) { restore(back); return; }
      atBottom.current = true;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      setFar(false);
      // Set after the scroll it just made, which is not a hand's.
      pending.current = back;
      return;
    }
    if (pending.current?.anchor && rowById(el, pending.current.anchor.id)) { restore(pending.current); return; }
    const fresh = rows.filter(row => !seen.current.has(row.id));
    if (fresh.length === 0) { settle(); return; }
    for (const row of fresh) seen.current.add(row.id);
    const last = rows[rows.length - 1];
    if (last.mine && fresh.includes(last)) {
      // What I send goes to the bottom, wherever I was.
      pending.current = null;
      atBottom.current = true;
      anchor.current = null;
      clear();
    } else if (!atBottom.current) {
      const theirs = fresh.filter(row => !row.mine);
      if (theirs.length) {
        firstNew.current ??= theirs[0].id;
        setCount(n => n + theirs.length);
      }
    }
    settle();
  }, [rows, listEl, chat, settle, clear]);

  useEffect(() => {
    const el = listEl;
    if (!el) return;
    const onScroll = () => {
      if (hidden(el)) return;
      // Not moved since it was last set or seen: content grew or shrank under the view, and no hand scrolled it.
      if (Math.abs(el.scrollTop - lastTop.current) < 1) { settle(); return; }
      lastTop.current = el.scrollTop;
      // A hand moved it: where the chat was left no longer matters.
      pending.current = null;
      const d = distance(el);
      if (d <= NEAR_BOTTOM_PX) following.current = false;
      atBottom.current = following.current || d <= NEAR_BOTTOM_PX;
      setFar(d > FAR_FROM_BOTTOM_PX);
      if (atBottom.current) { anchor.current = null; clear(); } else capture(el);
    };
    const takeOver = () => { following.current = false; };
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "pointerdown"]) el.addEventListener(type, takeOver, { passive: true });
    // A picture or a video loading, a bubble growing, the list itself getting shorter (a bar under it, the keyboard).
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => settle()) : undefined;
    observer?.observe(el);
    if (columnEl) observer?.observe(columnEl);
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchstart", "pointerdown"]) el.removeEventListener(type, takeOver);
      observer?.disconnect();
    };
  }, [listEl, columnEl, capture, settle, clear]);

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || editable(e.target)) return;
      const end = e.key === "End" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const down = e.key === "ArrowDown" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (!end && !down) return;
      e.preventDefault();
      toBottom();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, toBottom]);

  return { listRef, columnRef, count, far, toBottom, toNew };
}
