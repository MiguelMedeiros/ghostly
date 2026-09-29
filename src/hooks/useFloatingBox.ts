import { useCallback, useEffect, useRef, useState } from "react";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Corner = "nw" | "ne" | "sw" | "se";
export const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

interface Options {
  enabled?: boolean;
  /** Width over height. When set, the box keeps this shape however it is resized. */
  aspect?: number;
  minWidth?: number;
  minHeight?: number;
}

const MARGIN = 8;

type Insets = { top: number; right: number; bottom: number; left: number };
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
/**
 * The screen's safe area (a phone's status bar, notch or Dynamic Island, home indicator): read when the window
 * changes and as a gesture starts, not on every move. All 0 on a computer.
 */
let insets: Insets = NO_INSETS;
function readInsets(): void {
  if (typeof document === "undefined" || !document.body) return;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  insets = { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 };
  probe.remove();
}

/** Keeps a box whole inside the window and clear of its safe area: first small enough, then moved back in. */
function fit(box: Box, aspect: number | undefined, minWidth: number, minHeight: number): Box {
  const maxW = window.innerWidth - insets.left - insets.right - 2 * MARGIN;
  const maxH = window.innerHeight - insets.top - insets.bottom - 2 * MARGIN;
  let w = Math.max(minWidth, Math.min(box.w, maxW));
  let h = aspect ? w / aspect : Math.max(minHeight, Math.min(box.h, maxH));
  if (aspect && h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return {
    w,
    h,
    x: Math.max(insets.left + MARGIN, Math.min(box.x, window.innerWidth - insets.right - w - MARGIN)),
    y: Math.max(insets.top + MARGIN, Math.min(box.y, window.innerHeight - insets.bottom - h - MARGIN)),
  };
}

/**
 * The same place in a window of another size (a phone turned on its side, a resized window): as far along the room
 * left on each axis as before, so a box in the top right corner stays in it instead of ending up mid-screen.
 */
function keepPlace(box: Box, from: { w: number; h: number }, to: { w: number; h: number }): Box {
  const along = (at: number, size: number, was: number, now: number) => {
    const before = was - size - 2 * MARGIN;
    return before > 0 ? MARGIN + ((at - MARGIN) * Math.max(0, now - size - 2 * MARGIN)) / before : at;
  };
  return { ...box, x: along(box.x, box.w, from.w, to.w), y: along(box.y, box.h, from.h, to.h) };
}

/**
 * A box the person can drag anywhere and resize from any corner. It never
 * leaves the window, can keep an aspect ratio, and comes back the way it was
 * left. Spread `boxProps` on the element (positioned `fixed` or `absolute` in a
 * full-window parent) and render one handle per corner with `handleProps`.
 */
export function useFloatingBox(storageKey: string, initial: () => Box, options: Options = {}) {
  const { enabled = true, aspect, minWidth = 120, minHeight = 90 } = options;
  const ref = useRef<HTMLDivElement>(null);
  /** The window's size the box was last placed in. */
  const windowSize = useRef({ w: window.innerWidth, h: window.innerHeight });
  const [box, setBox] = useState<Box>(() => {
    readInsets();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<Box> | null;
      if (saved && [saved.x, saved.y, saved.w, saved.h].every((n) => typeof n === "number")) return fit(saved as Box, aspect, minWidth, minHeight);
    } catch {
      // start fresh
    }
    return fit(initial(), aspect, minWidth, minHeight);
  });

  const commit = useCallback(
    (next: Box) => {
      const fitted = fit(next, aspect, minWidth, minHeight);
      setBox(fitted);
      try {
        localStorage.setItem(storageKey, JSON.stringify(fitted));
      } catch {
        // only a preference
      }
    },
    [storageKey, aspect, minWidth, minHeight],
  );

  // A new shape (camera to screen) or another window size: same place, still whole. A phone turned on its side keeps
  // the box in its corner (`keepPlace`), clear of the notch on either end.
  useEffect(() => {
    if (!enabled) return;
    const onResize = () => {
      readInsets();
      const now = { w: window.innerWidth, h: window.innerHeight }, was = windowSize.current;
      windowSize.current = now;
      setBox((current) => fit(was.w === now.w && was.h === now.h ? current : keepPlace(current, was, now), aspect, minWidth, minHeight));
    };
    // Also as it comes back (the small window again): the screen may have turned meanwhile.
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, aspect, minWidth, minHeight]);

  /** Runs a drag or a resize: moves the element directly while it lasts, saves once at the end. */
  const gesture = (event: React.PointerEvent, next: (e: PointerEvent) => Box) => {
    const element = ref.current;
    if (!enabled || !element) return;
    event.preventDefault();
    event.stopPropagation();
    readInsets();
    let latest: Box | null = null;
    const move = (e: PointerEvent) => {
      latest = next(e);
      Object.assign(element.style, { left: `${latest.x}px`, top: `${latest.y}px`, width: `${latest.w}px`, height: `${latest.h}px` });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (latest) commit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const startDrag = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest("button, [data-handle]")) return;
    const grab = { x: event.clientX - box.x, y: event.clientY - box.y };
    gesture(event, (e) => fit({ ...box, x: e.clientX - grab.x, y: e.clientY - grab.y }, aspect, minWidth, minHeight));
  };

  const startResize = (corner: Corner) => (event: React.PointerEvent) => {
    const east = corner.includes("e");
    const south = corner.includes("s");
    // The opposite corner stays where it is.
    const anchor = { x: east ? box.x : box.x + box.w, y: south ? box.y : box.y + box.h };
    const roomX = east ? window.innerWidth - MARGIN - anchor.x : anchor.x - MARGIN;
    const roomY = south ? window.innerHeight - MARGIN - anchor.y : anchor.y - MARGIN;
    gesture(event, (e) => {
      const wantW = east ? e.clientX - anchor.x : anchor.x - e.clientX;
      const wantH = south ? e.clientY - anchor.y : anchor.y - e.clientY;
      let w: number;
      let h: number;
      if (aspect) {
        w = Math.max(minWidth, Math.min(Math.max(wantW, wantH * aspect), roomX, roomY * aspect));
        h = w / aspect;
      } else {
        w = Math.max(minWidth, Math.min(wantW, roomX));
        h = Math.max(minHeight, Math.min(wantH, roomY));
      }
      return { w, h, x: east ? anchor.x : anchor.x - w, y: south ? anchor.y : anchor.y - h };
    });
  };

  return {
    box,
    reset: () => commit(initial()),
    boxProps: enabled
      ? { ref, onPointerDown: startDrag, style: { left: box.x, top: box.y, width: box.w, height: box.h, touchAction: "none" as const } }
      : { ref },
    handleProps: (corner: Corner) => ({ "data-handle": corner, onPointerDown: startResize(corner) }),
  };
}
