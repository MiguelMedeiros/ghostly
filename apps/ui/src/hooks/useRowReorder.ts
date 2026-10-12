import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";

/*
 * Rows of a list put in another order by dragging, with pointer events alone: a mouse drags a row once it has moved a
 * few pixels; a finger (or a pen) holds the row still for a moment first, so a swipe still scrolls the list and a tap
 * still opens the row. Only the rows given here move and take a drop; the row follows the pointer between the first
 * and the last of them, and a line (`drop`) shows where it would land. Escape, or a cancelled touch, puts it back.
 *
 * The same gesture also puts a row in a folder (`folders`): a part of the list marked `data-folder-drop` (a folder's
 * id, or nothing for the rows in no folder) takes a row dropped on it. A row held over another part than its own goes
 * there, wherever it is among the rows; held over its own part, it is put in order as before, if it can be.
 */

/** How long a finger holds a row before it can be dragged. */
export const REORDER_HOLD_MS = 400;
/** A mouse that moved this far with its button down is dragging, not clicking. */
const MOUSE_SLOP = 5;
/** A finger that moved this far before the hold was over is scrolling. */
const TOUCH_SLOP = 8;
/** What a press never starts a drag from: the row's own buttons and its identity marks (which have their own long press). */
const CONTROLS = "button, a, input, textarea, [role=button], .contact-marks";

interface Box { top: number; height: number }

/** The part of the list a point is over: a folder's id, null for the rows in no folder, undefined for neither. */
function folderAt(x: number, y: number): string | null | undefined {
  if (typeof document.elementFromPoint !== "function") return undefined;
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder-drop]");
  return zone ? zone.dataset.folderDrop || null : undefined;
}
/** How near an edge of the list a held row makes it scroll, and how fast. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 10;

/**
 * The place a row dragged from `from` takes among `rows` once its middle is at `middle`: how many other rows have
 * theirs above it. A row it reaches the middle of gives way (so the first and the last place can be reached by a row
 * that goes no further than them).
 */
export function dropIndex(rows: readonly Box[], from: number, middle: number): number {
  let to = 0;
  rows.forEach((row, i) => {
    const mid = row.top + row.height / 2;
    if (i < from ? middle > mid : i > from && middle >= mid) to++;
  });
  return to;
}

interface Live {
  id: string;
  el: HTMLElement;
  touch: boolean;
  x: number;
  y: number;
  active: boolean;
  /** The pointer went somewhere once the row was in the hand. */
  moved: boolean;
  timer?: ReturnType<typeof setTimeout>;
  rows: Box[];
  from: number;
  to: number;
  /** It may be put in order among `rows`. */
  reorders: boolean;
  /** It may be dropped on a folder; `own` is the part it is in (null: no folder). */
  drops: boolean;
  own: string | null;
  /** The other part of the list it is over now: where it goes if let go. Undefined over its own, or over none. */
  target?: string | null;
  /** The list, which scrolls under a row held near its edge, and how far it had scrolled when the row was taken. */
  scroller: HTMLElement | null;
  scrolled: number;
  frame?: number;
  last?: { x: number; y: number };
  stop(): void;
}

export interface RowReorder {
  /** Spread on a row that can be dragged. */
  rowProps(id: string): Record<string, unknown>;
  /** The row being dragged now. */
  dragging?: string;
  /** Where the line goes while a row is dragged: on this row's top or bottom edge. */
  drop?: { id: string; edge: "before" | "after" };
  /** The part of the list a dragged row would go to: a folder's id, or null for no folder. Undefined: nowhere else. */
  over?: string | null;
}

/** Rows that may be dropped on a folder of the list. */
export interface FolderDrops {
  /** The rows that can be moved, by id. */
  rows: readonly string[];
  /** The folder a row is in now. */
  of(id: string): string | undefined;
  /** A row was dropped on a folder (undefined: on the rows in no folder). */
  onDrop(id: string, folder: string | undefined): void;
}

export function useRowReorder({ ids, enabled, onMove, folders }: {
  /** The rows that can be put in another order, in the order they are drawn. */
  ids: readonly string[];
  enabled: boolean;
  /** A row was dropped at `index` among `ids`. */
  onMove(id: string, index: number): void;
  folders?: FolderDrops;
}): RowReorder {
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; target?: string | null } | null>(null);
  const live = useRef<Live | null>(null);
  /** The click a drop ends with would open the chat under it. */
  const swallow = useRef(false);
  const latest = useRef(onMove);
  latest.current = onMove;
  const drops = useRef(folders);
  drops.current = folders;

  const finish = useCallback((commit: boolean) => {
    const now = live.current;
    if (!now) return;
    live.current = null;
    clearTimeout(now.timer);
    if (now.frame !== undefined) cancelAnimationFrame(now.frame);
    now.stop();
    now.el.style.transform = "";
    now.el.style.pointerEvents = "";
    if (!now.active) return;
    document.body.style.userSelect = "";
    // A row that went somewhere and came down: its click is not a tap. Held and let go where it was, it is a slow tap,
    // which opens the chat as it always did.
    if (now.moved) {
      swallow.current = true;
      setTimeout(() => { swallow.current = false; }, 100);
    }
    setDrag(null);
    if (!commit) return;
    if (now.target !== undefined) drops.current?.onDrop(now.id, now.target ?? undefined);
    else if (now.to !== now.from) latest.current(now.id, now.to);
  }, []);

  useEffect(() => () => finish(false), [finish]);
  // The rows changed under the drag (a search, a profile switch): it is over.
  useEffect(() => { if (!enabled) finish(false); }, [enabled, finish]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    const el = e.currentTarget, id = el.dataset.reorderId ?? el.dataset.dragId;
    if (live.current || !id || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const control = e.target instanceof Element ? e.target.closest(CONTROLS) : null;
    if (control && control !== el && el.contains(control)) return;
    const pointer = e.pointerId;

    const activate = () => {
      const now = live.current;
      if (!now || now.active) return;
      const rows = el.dataset.reorderId ? [...el.parentElement?.querySelectorAll<HTMLElement>("[data-reorder-id]") ?? []] : [];
      const from = rows.indexOf(el);
      now.reorders = from >= 0 && rows.length >= 2;
      now.drops = !!drops.current?.rows.includes(id);
      if (!now.reorders && !now.drops) { finish(false); return; }
      if (now.reorders) {
        now.rows = rows.map(row => { const box = row.getBoundingClientRect(); return { top: box.top, height: box.height }; });
        now.from = now.to = from;
      } else {
        const box = el.getBoundingClientRect();
        now.rows = [{ top: box.top, height: box.height }];
        now.from = now.to = 0;
      }
      now.own = drops.current?.of(id) ?? null;
      now.scroller = el.closest<HTMLElement>("[data-drag-scroll]");
      now.scrolled = now.scroller?.scrollTop ?? 0;
      // What is under the row is what it is dropped on: the row itself is not in the way of that question.
      if (now.drops) el.style.pointerEvents = "none";
      now.active = true;
      try { el.setPointerCapture?.(pointer); } catch { /* the pointer is gone: the window's listeners still end the drag */ }
      document.body.style.userSelect = "none";
      if (now.touch) { try { navigator.vibrate?.(10); } catch { /* no vibration here */ } }
      setDrag({ id, from, to: from });
    };
    const move = (ev: globalThis.PointerEvent) => {
      const now = live.current;
      if (!now || ev.pointerId !== pointer) return;
      if (!now.active) {
        const far = Math.hypot(ev.clientX - now.x, ev.clientY - now.y);
        if (now.touch) { if (far > TOUCH_SLOP) finish(false); return; }
        if (far <= MOUSE_SLOP) return;
        activate();
        if (!now.active) return;
      }
      if (Math.hypot(ev.clientX - now.x, ev.clientY - now.y) > MOUSE_SLOP) now.moved = true;
      now.last = { x: ev.clientX, y: ev.clientY };
      place();
      if (now.drops && now.scroller && now.frame === undefined) now.frame = requestAnimationFrame(scroll);
    };
    /** Puts the row where the pointer is and says where it would land. */
    const place = () => {
      const now = live.current;
      if (!now?.active || !now.last) return;
      const { x, y } = now.last;
      const over = now.drops ? folderAt(x, y) : undefined;
      const target = over === undefined || over === now.own ? undefined : over;
      // The list scrolled under the row since it was taken: the row keeps up with the pointer, not with the list.
      const free = y - now.y + ((now.scroller?.scrollTop ?? 0) - now.scrolled);
      const own = now.rows[now.from], first = now.rows[0], last = now.rows[now.rows.length - 1];
      let by = free, to = now.from;
      if (target === undefined && now.reorders) {
        // Among its own rows it stays with the ones that can take it: no further up than the first, no further down than the last.
        by = Math.max(first.top - own.top, Math.min(last.top + last.height - own.top - own.height, y - now.y));
        to = dropIndex(now.rows, now.from, own.top + own.height / 2 + by);
      }
      now.el.style.transform = `translateY(${by}px)`;
      if (to !== now.to || target !== now.target) { now.to = to; now.target = target; setDrag({ id: now.id, from: now.from, to, target }); }
    };
    /** A row held near the top or the bottom of the list scrolls it, so a folder out of sight can be reached. */
    const scroll = () => {
      const now = live.current;
      if (!now?.active || !now.scroller || !now.last) return;
      now.frame = undefined;
      const box = now.scroller.getBoundingClientRect();
      const step = now.last.y < box.top + SCROLL_EDGE ? -SCROLL_STEP : now.last.y > box.bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
      if (!step) return;
      const before = now.scroller.scrollTop;
      now.scroller.scrollTop = before + step;
      if (now.scroller.scrollTop === before) return;
      place();
      now.frame = requestAnimationFrame(scroll);
    };
    const up = (ev: globalThis.PointerEvent) => { if (ev.pointerId === pointer) finish(true); };
    const cancel = (ev: globalThis.PointerEvent) => { if (ev.pointerId === pointer) finish(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape" && live.current?.active) { ev.stopPropagation(); finish(false); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    const touch = e.pointerType !== "mouse";
    live.current = {
      id, el, touch, x: e.clientX, y: e.clientY, active: false, moved: false, rows: [], from: -1, to: -1,
      reorders: false, drops: false, own: null, scroller: null, scrolled: 0,
      timer: touch ? setTimeout(activate, REORDER_HOLD_MS) : undefined,
      stop() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
      },
    };
  }, [finish]);

  // Once the row is held, the finger moves the row, not the list. Not passive (a passive listener cannot say so), and
  // on the row from the start: a browser decides when the finger lands whether a touch there can be kept from scrolling.
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const touchMove = (ev: TouchEvent) => { if (live.current?.active && live.current.el === el && ev.cancelable) ev.preventDefault(); };
    el.addEventListener("touchmove", touchMove, { passive: false });
    return () => el.removeEventListener("touchmove", touchMove);
  }, []);

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (!swallow.current) return;
    swallow.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);
  // A held finger asks for the browser's own menu (Android); the picture in the row would be dragged as a picture.
  const onContextMenu = useCallback((e: MouseEvent) => { if (live.current?.touch) e.preventDefault(); }, []);
  const onDragStart = useCallback((e: DragEvent) => { e.preventDefault(); }, []);

  const usable = enabled && ids.length > 1;
  const droppable = enabled ? folders?.rows : undefined;
  const rowProps = useCallback((id: string) => {
    const reorders = usable && ids.includes(id);
    if (!reorders && !droppable?.includes(id)) return {};
    return { [reorders ? "data-reorder-id" : "data-drag-id"]: id, ref, onPointerDown, onClickCapture, onContextMenu, onDragStart };
  }, [usable, ids, droppable, ref, onPointerDown, onClickCapture, onContextMenu, onDragStart]);

  if (!drag || !enabled) return { rowProps };
  if (drag.target !== undefined) return { rowProps, dragging: drag.id, over: drag.target };
  const others = ids.filter(id => id !== drag.id);
  const drop = !usable || !ids.includes(drag.id) || drag.to === drag.from || !others.length ? undefined
    : drag.to < others.length ? { id: others[drag.to], edge: "before" as const } : { id: others[others.length - 1], edge: "after" as const };
  return { rowProps, dragging: drag.id, drop };
}
