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

/** Keeps a box whole inside the window: first small enough, then moved back in. */
function fit(box: Box, aspect: number | undefined, minWidth: number, minHeight: number): Box {
  const maxW = window.innerWidth - 2 * MARGIN;
  const maxH = window.innerHeight - 2 * MARGIN;
  let w = Math.max(minWidth, Math.min(box.w, maxW));
  let h = aspect ? w / aspect : Math.max(minHeight, Math.min(box.h, maxH));
  if (aspect && h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return {
    w,
    h,
    x: Math.max(MARGIN, Math.min(box.x, window.innerWidth - w - MARGIN)),
    y: Math.max(MARGIN, Math.min(box.y, window.innerHeight - h - MARGIN)),
  };
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
  const [box, setBox] = useState<Box>(() => {
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

  // A new shape (camera to screen) or a smaller window: same place, still whole.
  useEffect(() => {
    if (!enabled) return;
    setBox((current) => fit(current, aspect, minWidth, minHeight));
    const onResize = () => setBox((current) => fit(current, aspect, minWidth, minHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, aspect, minWidth, minHeight]);

  /** Runs a drag or a resize: moves the element directly while it lasts, saves once at the end. */
  const gesture = (event: React.PointerEvent, next: (e: PointerEvent) => Box) => {
    const element = ref.current;
    if (!enabled || !element) return;
    event.preventDefault();
    event.stopPropagation();
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
