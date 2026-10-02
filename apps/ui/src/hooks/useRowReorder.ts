import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";

/*
 * Rows of a list put in another order by dragging, with pointer events alone: a mouse drags a row once it has moved a
 * few pixels; a finger (or a pen) holds the row still for a moment first, so a swipe still scrolls the list and a tap
 * still opens the row. Only the rows given here move and take a drop; the row follows the pointer between the first
 * and the last of them, and a line (`drop`) shows where it would land. Escape, or a cancelled touch, puts it back.
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
  stop(): void;
}

export interface RowReorder {
  /** Spread on a row that can be dragged. */
  rowProps(id: string): Record<string, unknown>;
  /** The row being dragged now. */
  dragging?: string;
  /** Where the line goes while a row is dragged: on this row's top or bottom edge. */
  drop?: { id: string; edge: "before" | "after" };
}

export function useRowReorder({ ids, enabled, onMove }: {
  /** The rows that can be put in another order, in the order they are drawn. */
  ids: readonly string[];
  enabled: boolean;
  /** A row was dropped at `index` among `ids`. */
  onMove(id: string, index: number): void;
}): RowReorder {
  const [drag, setDrag] = useState<{ id: string; from: number; to: number } | null>(null);
  const live = useRef<Live | null>(null);
  /** The click a drop ends with would open the chat under it. */
  const swallow = useRef(false);
  const latest = useRef(onMove);
  latest.current = onMove;

  const finish = useCallback((commit: boolean) => {
    const now = live.current;
    if (!now) return;
    live.current = null;
    clearTimeout(now.timer);
    now.stop();
    now.el.style.transform = "";
    if (!now.active) return;
    document.body.style.userSelect = "";
    // A row that went somewhere and came down: its click is not a tap. Held and let go where it was, it is a slow tap,
    // which opens the chat as it always did.
    if (now.moved) {
      swallow.current = true;
      setTimeout(() => { swallow.current = false; }, 100);
    }
    setDrag(null);
    if (commit && now.to !== now.from) latest.current(now.id, now.to);
  }, []);

  useEffect(() => () => finish(false), [finish]);
  // The rows changed under the drag (a search, a profile switch): it is over.
  useEffect(() => { if (!enabled) finish(false); }, [enabled, finish]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    const el = e.currentTarget, id = el.dataset.reorderId;
    if (live.current || !id || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const control = e.target instanceof Element ? e.target.closest(CONTROLS) : null;
    if (control && control !== el && el.contains(control)) return;
    const pointer = e.pointerId;

    const activate = () => {
      const now = live.current;
      if (!now || now.active) return;
      const rows = [...el.parentElement?.querySelectorAll<HTMLElement>("[data-reorder-id]") ?? []];
      const from = rows.indexOf(el);
      if (from < 0 || rows.length < 2) { finish(false); return; }
      now.rows = rows.map(row => { const box = row.getBoundingClientRect(); return { top: box.top, height: box.height }; });
      now.from = now.to = from;
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
      const own = now.rows[now.from], first = now.rows[0], last = now.rows[now.rows.length - 1];
      // The row stays among the rows that can take it: no further up than the first, no further down than the last.
      const by = Math.max(first.top - own.top, Math.min(last.top + last.height - own.top - own.height, ev.clientY - now.y));
      now.el.style.transform = `translateY(${by}px)`;
      const to = dropIndex(now.rows, now.from, own.top + own.height / 2 + by);
      if (to !== now.to) { now.to = to; setDrag({ id: now.id, from: now.from, to }); }
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
  const rowProps = useCallback((id: string) => usable && ids.includes(id)
    ? { "data-reorder-id": id, ref, onPointerDown, onClickCapture, onContextMenu, onDragStart }
    : {}, [usable, ids, ref, onPointerDown, onClickCapture, onContextMenu, onDragStart]);

  if (!drag || !usable) return { rowProps };
  const others = ids.filter(id => id !== drag.id);
  const drop = drag.to === drag.from || !others.length ? undefined
    : drag.to < others.length ? { id: others[drag.to], edge: "before" as const } : { id: others[others.length - 1], edge: "after" as const };
  return { rowProps, dragging: drag.id, drop };
}
