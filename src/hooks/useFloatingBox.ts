import { useCallback, useEffect, useRef, useState } from "react";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MARGIN = 8;
const clamp = (box: Box): Box => ({
  ...box,
  x: Math.max(MARGIN, Math.min(box.x, window.innerWidth - box.w - MARGIN)),
  y: Math.max(MARGIN, Math.min(box.y, window.innerHeight - box.h - MARGIN)),
});

/**
 * A box the person can drag anywhere and resize from its corner (CSS `resize`),
 * and that comes back the way they left it. Give the element `ref`, `style` and
 * `onPointerDown`, and a class with `resize: both; overflow: hidden`.
 */
export function useFloatingBox(storageKey: string, initial: () => Box, enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<Box> | null;
      if (saved && [saved.x, saved.y, saved.w, saved.h].every((n) => typeof n === "number")) return clamp(saved as Box);
    } catch {
      // start fresh
    }
    return clamp(initial());
  });

  const save = useCallback(
    (next: Box) => {
      setBox(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // only a preference
      }
    },
    [storageKey],
  );

  // Resizing is the browser's doing; remember the result or the next render undoes it.
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const observer = new ResizeObserver(() => {
      const now = element.getBoundingClientRect();
      if (Math.abs(now.width - box.w) > 1 || Math.abs(now.height - box.h) > 1) save({ x: now.left, y: now.top, w: now.width, h: now.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, box, save]);

  // A smaller window must not leave the box out of reach.
  useEffect(() => {
    if (!enabled) return;
    const onResize = () => setBox((current) => clamp(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = ref.current;
    if (!enabled || !element || (event.target as HTMLElement).closest("button")) return;
    const start = element.getBoundingClientRect();
    // The bottom right corner belongs to the resize handle.
    if (event.clientX > start.right - 22 && event.clientY > start.bottom - 22) return;
    event.stopPropagation();
    const parent = element.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const offset = { x: event.clientX - start.left, y: event.clientY - start.top };
    const move = (e: PointerEvent) => {
      const next = clamp({ x: e.clientX - offset.x, y: e.clientY - offset.y, w: start.width, h: start.height });
      element.style.left = `${next.x - parent.left}px`;
      element.style.top = `${next.y - parent.top}px`;
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      const now = element.getBoundingClientRect();
      save({ x: now.left, y: now.top, w: now.width, h: now.height });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return { ref, onPointerDown, style: enabled ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined };
}
