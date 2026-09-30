import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { reducedMotion } from "../lib/motion";
import { JUMP_EVENT } from "../lib/replies";
import type { RowWindow } from "./useRowWindow";

/** A message row of the timeline, in order: its id (the row's `data-message-id`) and whether I sent it. */
export interface ScrollRow {
  id: string;
  mine: boolean;
}

/** This close to the bottom counts as at the bottom: a new message keeps the view there. */
export const NEAR_BOTTOM_PX = 100;
/** Further than this from the bottom, the ↓ button shows even with nothing new. */
export const FAR_FROM_BOTTOM_PX = 400;
/** The view this near an edge of the rows in the page (in heights of the view) takes a page more there (`useRowWindow`). */
export const EDGE_VIEWS = 1.5;
/** A hand's wheel, touch or key moves the list for this long after it (smooth scrolling, a trackpad's momentum). */
export const HAND_MS = 1000;
/** A jump to a message (a quote's, a search's) is on its way for at most this long, unless a hand takes over first. */
const JUMP_MS = 2000;
/** Keys that scroll the list (outside a text field). */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

interface Anchor {
  id: string;
  /** Where the row's top was, from the list's top edge. */
  offset: number;
  /** The list's height then: when it changes, the view keeps its bottom edge (see `settle`). */
  height: number;
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
  return !!leftOn(chat);
}
/** The message the chat was left scrolled up on, if it was: the rows in the page open around it (`useRowWindow`). */
export function leftOn(chat: string): string | undefined {
  const was = left.get(chat);
  return was && !was.atBottom ? was.anchor?.id : undefined;
}
/** Forgets where every chat was left (for tests). */
export function forgetChatScroll() {
  left.clear();
}

const rowsOf = (list: HTMLElement) => list.querySelectorAll<HTMLElement>("[data-message-id]");
const rowById = (list: HTMLElement, id: string) => list.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
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
 * One exception: a move that leaves it a little short of the bottom with no wheel, touch, press or scrolling key on the
 * list in the last `HAND_MS` is the browser's, not a hand's (something measured at another size for an instant, like the
 * composer sizing itself to its text), and it goes back to the bottom.
 *
 * Give `listRef` to the scrolling element and `columnRef` to the one that grows with the rows. `chat` starts it over: a
 * chat opens where it was left (on the same message, or at its bottom) with nothing counted, and one never opened opens
 * at its bottom. When the message it was left on is not among its first rows, it opens at its bottom and goes back on
 * that message once the rows bring it, unless a hand scrolled first. `keys`: End or Ctrl/Cmd+↓ (outside a text field)
 * jumps to the bottom. A jump to a message (`jumpToMessage`: a quote's, a search's) lands on it, from the bottom too.
 */
export function useChatScroll({ rows, chat, keys = true, window: rowWindow }: { rows: readonly ScrollRow[]; chat: string; keys?: boolean; window?: RowWindow }) {
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
  /** When a hand last touched the list (wheel, touch, a press on it, a scrolling key), and whether it is still pressed. */
  const handAt = useRef(-Infinity);
  const pressed = useRef(false);
  /**
   * Until when a jump to a message is on its way (`jumpToMessage`): its row is the anchor, where the jump puts it, and
   * its own scroll events neither take it back to the bottom nor move the anchor. Over once the row is there, when a
   * hand takes over, or after `JUMP_MS`.
   */
  const jumping = useRef(0);
  /**
   * The rows in the page, when they are a window of the timeline (`useRowWindow`). Detached, the page's end is not the
   * chat's: the view is never at the bottom there, and going to the bottom brings the last rows back first.
   */
  const win = useRef(rowWindow);
  win.current = rowWindow;
  const detached = () => !!win.current?.detached;

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
    anchor.current = found < 0 ? null : { id: all[found].dataset.messageId!, offset: all[found].getBoundingClientRect().top - top, height: el.clientHeight };
  }, []);

  const clear = useCallback(() => {
    firstNew.current = null;
    setCount(0);
  }, []);

  /**
   * After the rows or their sizes changed: at the bottom, stay there; otherwise put the anchored row back where it was.
   * The list itself taller or shorter (a phone turned on its side, the keyboard, a window resized) keeps what was at the
   * view's bottom edge where it was, as a chat does at its bottom: the anchored row moves with that edge. Held by its
   * top instead, the view would keep the history above and lose the messages it was showing below (a video playing
   * there stops), and go to the very top when what is above the rows (the pairing scene) got shorter too.
   */
  const settle = useCallback(() => {
    const el = list.current;
    if (!el || !hasRows.current || hidden(el)) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const grew = el.clientHeight - anchor.current.height;
      if (grew) anchor.current = { ...anchor.current, offset: anchor.current.offset + grew, height: el.clientHeight };
      const row = rowById(el, anchor.current.id);
      if (row) {
        const moved = row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset;
        if (Math.abs(moved) >= 1) el.scrollTop += moved;
      }
    }
    lastTop.current = el.scrollTop;
    setFar(detached() || distance(el) > FAR_FROM_BOTTOM_PX);
  }, []);

  const toBottom = useCallback(() => {
    const el = list.current;
    if (!el) return;
    pending.current = null;
    atBottom.current = true;
    following.current = true;
    jumping.current = 0;
    anchor.current = null;
    clear();
    // Up the history, the last rows come back first, in place of the ones in the page: at once, not a long glide.
    const swapped = detached();
    if (swapped) win.current!.attach(true);
    const top = el.scrollHeight;
    if (swapped || reducedMotion() || typeof el.scrollTo !== "function") el.scrollTop = top;
    else el.scrollTo({ top, behavior: "smooth" });
    lastTop.current = el.scrollTop;
  }, [clear]);

  /** The pill: to the first message not seen yet, or to the bottom when that one is already in reach of it. */
  const toNew = useCallback(() => {
    const el = list.current;
    const id = firstNew.current;
    // Not in the page (the window is elsewhere): the rows around it come in first.
    const row = el && id ? rowById(el, id) ?? (win.current?.reveal(id) ? rowById(el, id) : undefined) : undefined;
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
    jumping.current = 0;
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
      // Where it was on the list as it is now: a chat left upright and opened again on its side is on the same message.
      anchor.current = { ...was.anchor!, height: el.clientHeight };
      firstNew.current = null;
      setCount(0);
      // A bubble that came seconds ago still plays its entry, drawn a few pixels off: measured at rest, it lands exactly.
      for (const animation of rowById(el, was.anchor!.id)?.getAnimations?.() ?? []) animation.finish();
      settle();
    };
    if (!opened.current) {
      opened.current = true;
      for (const row of rows) seen.current.add(row.id);
      const was = left.get(chat);
      const back = was && !was.atBottom && was.anchor ? was : null;
      if (back && rowById(el, back.anchor!.id)) { restore(back); return; }
      win.current?.attach();
      atBottom.current = true;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      setFar(false);
      // Set after the scroll it just made, which is not a hand's.
      pending.current = back;
      return;
    }
    if (pending.current?.anchor && rowById(el, pending.current.anchor.id)) { restore(pending.current); return; }
    // Only what comes after the newest row seen is new. Older history coming in above (a group's newest page first, then
    // the rest) or a late catch-up put in its place among the rows seen (a group syncing after a reconnect) is not.
    let newestSeen = rows.length - 1;
    while (newestSeen >= 0 && !seen.current.has(rows[newestSeen].id)) newestSeen--;
    const fresh = rows.slice(newestSeen + 1);
    for (let i = 0; i < newestSeen; i++) seen.current.add(rows[i].id);
    if (fresh.length === 0) { settle(); return; }
    for (const row of fresh) seen.current.add(row.id);
    const last = rows[rows.length - 1];
    if (last.mine && fresh.includes(last)) {
      // What I send goes to the bottom, wherever I was: up the history, the last rows come back (and this runs again).
      pending.current = null;
      atBottom.current = true;
      anchor.current = null;
      clear();
      win.current?.attach();
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
    const sizeOf = () => `${el.clientWidth}x${el.clientHeight}`;
    /** The list's size at its last scroll event. */
    let lastSize = sizeOf();
    const onScroll = () => {
      if (hidden(el)) return;
      const size = sizeOf();
      const resized = size !== lastSize;
      lastSize = size;
      // Not moved since it was last set or seen: content grew or shrank under the view, and no hand scrolled it.
      if (Math.abs(el.scrollTop - lastTop.current) < 1) { settle(); return; }
      if (jumping.current) {
        const row = anchor.current && rowById(el, anchor.current.id);
        const landed = !row || Math.abs(row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current!.offset) < 1;
        if (landed || performance.now() > jumping.current) jumping.current = 0;
        lastTop.current = el.scrollTop;
        setFar(distance(el) > FAR_FROM_BOTTOM_PX);
        return;
      }
      const d = distance(el);
      // Moved a little short of the bottom with no hand on it: the browser pulled it back while something under it was
      // measured one size and drawn another in the same moment (the composer measuring its text grows the list for an
      // instant). Nothing reports that, and the view would stay short of the last message: back to the bottom.
      const hand = pressed.current || performance.now() - handAt.current < HAND_MS;
      if (atBottom.current && !hand && d <= NEAR_BOTTOM_PX) { following.current = false; settle(); return; }
      // The list itself changed size (a phone turned on its side, a window resized): the browser moved it to keep what
      // was on screen, before the resize reaches `settle`. Not a hand's: at the bottom it stays there, scrolled up it
      // stays on its message.
      if (resized && !pressed.current) { settle(); return; }
      lastTop.current = el.scrollTop;
      // A hand moved it: where the chat was left no longer matters.
      pending.current = null;
      if (d <= NEAR_BOTTOM_PX) following.current = false;
      atBottom.current = !detached() && (following.current || d <= NEAR_BOTTOM_PX);
      setFar(detached() || d > FAR_FROM_BOTTOM_PX);
      if (atBottom.current) { anchor.current = null; clear(); } else capture(el);
      nearEdge(el);
    };
    /** Near an edge of the rows in the page, with more beyond it: a page more there (the view stays on its row). */
    const nearEdge = (el: HTMLElement) => {
      const w = win.current;
      if (!w) return;
      const edge = el.clientHeight * EDGE_VIEWS;
      if (el.scrollTop < edge && w.more("up")) return;
      if (w.detached && distance(el) < edge) w.more("down");
    };
    const takeOver = (e: Event) => {
      following.current = false;
      jumping.current = 0;
      handAt.current = performance.now();
      if (e.type === "pointerdown") pressed.current = true;
      // A wheel against an end of the rows in the page scrolls nothing, so no scroll event says it: more there.
      if (e.type === "wheel" && !hidden(el) && ((e as WheelEvent).deltaY < 0 ? el.scrollTop <= 0 : distance(el) <= 1)) {
        if (atBottom.current === false) capture(el);
        nearEdge(el);
      }
    };
    const release = () => { pressed.current = false; };
    const onKey = (e: KeyboardEvent) => { if (SCROLL_KEYS.has(e.key) && !editable(e.target)) { handAt.current = performance.now(); jumping.current = 0; } };
    // A jump to a message: the list goes where the row will be, in the middle of the view (or as near as it scrolls).
    const onJump = (e: Event) => {
      const row = e.target as HTMLElement;
      if (hidden(el) || !row.dataset?.messageId) return;
      following.current = false;
      pending.current = null;
      const view = el.getBoundingClientRect(), box = row.getBoundingClientRect();
      const max = el.scrollHeight - el.clientHeight;
      const target = Math.min(max, Math.max(0, el.scrollTop + box.top - view.top - (el.clientHeight - box.height) / 2));
      // Near the bottom: it goes to the bottom, as a hand taking it there would.
      if (max - target <= NEAR_BOTTOM_PX) { handAt.current = performance.now(); return; }
      atBottom.current = false;
      anchor.current = { id: row.dataset.messageId, offset: box.top - view.top - (target - el.scrollTop), height: el.clientHeight };
      jumping.current = performance.now() + JUMP_MS;
    };
    el.addEventListener(JUMP_EVENT, onJump);
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "touchmove", "pointerdown"]) el.addEventListener(type, takeOver, { passive: true });
    // A release the page never sees (over another window, a native menu) is let go when the window loses focus.
    for (const type of ["pointerup", "pointercancel", "blur"]) window.addEventListener(type, release, { passive: true });
    window.addEventListener("keydown", onKey, { capture: true, passive: true });
    // A picture or a video loading, a bubble growing, the list itself getting shorter (a bar under it, the keyboard).
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => settle()) : undefined;
    observer?.observe(el);
    if (columnEl) observer?.observe(columnEl);
    return () => {
      el.removeEventListener(JUMP_EVENT, onJump);
      el.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchstart", "touchmove", "pointerdown"]) el.removeEventListener(type, takeOver);
      for (const type of ["pointerup", "pointercancel", "blur"]) window.removeEventListener(type, release);
      window.removeEventListener("keydown", onKey, { capture: true });
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
