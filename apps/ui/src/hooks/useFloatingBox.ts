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
  /**
   * Stays in what the on-screen keyboard leaves while it is up (`aboveKeyboard`): between the chat's header and its
   * message field, or as a one-line bar over the header where there is no room for the box (`compact`). The box the
   * person chose comes back as it was when the keyboard goes down. Off, the box ignores the keyboard (a computer).
   */
  keyboard?: boolean;
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
  insets = safeAreaInsets();
}

/** The safe area's insets now, in px (`env(safe-area-inset-*)` read through a probe). */
export function safeAreaInsets(): Insets {
  if (typeof document === "undefined" || !document.body) return insets;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const read = { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 };
  probe.remove();
  return read;
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

/** The chat's header (`h-14` under the safe area, pages/Chat.tsx): the box stays below it while the keyboard is up. */
const HEADER = 56;
/** The one-line bar the box becomes where the keyboard leaves no room for it: 44 px buttons and 2 px around them. */
export const COMPACT_HEIGHT = 48;
const COMPACT_WIDTH = 320;

/**
 * What the on-screen keyboard leaves while it is up, as hooks/useViewportHeight.ts says it (`data-keyboard` on
 * `<html>`) and the visual viewport measures it: its top past the safe area, and its bottom at the message field's top
 * when the field is in it. Null while no keyboard is up.
 */
type Room = { top: number; bottom: number };
function keyboardRoom(): Room | null {
  if (typeof document === "undefined" || document.documentElement.dataset.keyboard !== "true") return null;
  const viewport = window.visualViewport;
  const top = (viewport?.offsetTop ?? 0) + insets.top;
  let bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
  for (const composer of document.querySelectorAll("[data-composer]")) {
    const field = composer.getBoundingClientRect();
    if (field.height > 0 && field.top > top && field.top < bottom) bottom = field.top;
  }
  return { top, bottom };
}

/**
 * The box placed in what the keyboard leaves (`keyboardRoom`): moved up between the header and the field, on the
 * side it was, when it fits there; or else a one-line bar at the top, over the header, on the side of its corner.
 */
function aboveKeyboard(box: Box, room: Room, aspect: number | undefined, minHeight: number): { box: Box; compact: boolean } {
  const top = room.top + HEADER + MARGIN, bottom = room.bottom - MARGIN;
  if (bottom - top >= minHeight) {
    const h = Math.max(minHeight, Math.min(box.h, bottom - top));
    const w = aspect ? h * aspect : box.w;
    return { compact: false, box: { ...box, w, h, y: Math.max(top, Math.min(box.y, bottom - h)) } };
  }
  const w = Math.min(COMPACT_WIDTH, window.innerWidth - insets.left - insets.right - 2 * MARGIN);
  const east = box.x + box.w / 2 > window.innerWidth / 2;
  return {
    compact: true,
    box: { w, h: COMPACT_HEIGHT, x: east ? window.innerWidth - insets.right - MARGIN - w : insets.left + MARGIN, y: room.top + (HEADER - COMPACT_HEIGHT) / 2 },
  };
}

/**
 * A box the person can drag anywhere and resize from any corner. It never
 * leaves the window, can keep an aspect ratio, and comes back the way it was
 * left. Spread `boxProps` on the element (positioned `fixed` or `absolute` in a
 * full-window parent) and render one handle per corner with `handleProps`.
 */
export function useFloatingBox(storageKey: string, initial: () => Box, options: Options = {}) {
  const { enabled = true, aspect, minWidth = 120, minHeight = 90, keyboard = false } = options;
  const ref = useRef<HTMLDivElement>(null);
  /** The window's size the box was last placed in. */
  const windowSize = useRef({ w: window.innerWidth, h: window.innerHeight });
  /** The box the person chose (kept and saved), not where the keyboard puts it for now (`shown` below). */
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
  const chosen = useRef(box);
  useEffect(() => { chosen.current = box; }, [box]);
  /** The box and the window's size before a keyboard made the page shorter (`keyboard` on). */
  const beforeShorter = useRef<{ box: Box; size: { w: number; h: number } } | null>(null);

  const commit = useCallback(
    (next: Box) => {
      const fitted = fit(next, aspect, minWidth, minHeight);
      beforeShorter.current = null;
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
      // Only shorter or taller again at the same width, with a keyboard about: one that shrinks the page with it
      // (Android's resizes-content). Placed from where it was before, the box is back in its corner once the page has
      // its height again: from the squeezed place, a phone on its side brought a box from the bottom back at the top.
      if (keyboard && now.w === was.w && now.h !== was.h && (now.h < was.h || beforeShorter.current)) {
        const before = (beforeShorter.current ??= { box: chosen.current, size: was });
        if (now.h >= before.size.h) beforeShorter.current = null;
        setBox(fit(keepPlace(before.box, before.size, now), aspect, minWidth, minHeight));
        return;
      }
      beforeShorter.current = null;
      setBox((current) => fit(was.w === now.w && was.h === now.h ? current : keepPlace(current, was, now), aspect, minWidth, minHeight));
    };
    // Also as it comes back (the small window again): the screen may have turned meanwhile.
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, aspect, minWidth, minHeight, keyboard]);

  // What the keyboard leaves, while it is up: measured again as it opens, closes or changes (useViewportHeight's
  // `data-keyboard`, the visual viewport), and as the message field grows (a second line, a reply above it).
  const [room, setRoom] = useState<Room | null>(null);
  useEffect(() => {
    if (!enabled || !keyboard) return;
    const viewport = window.visualViewport;
    const field = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    let watched: Element[] = [];
    const measure = () => {
      readInsets();
      const next = keyboardRoom();
      setRoom((was) => (was && next && was.top === next.top && was.bottom === next.bottom) || (!was && !next) ? was : next);
      // Observed again only when the fields changed: a field observed anew is reported at the next frame, and observed
      // anew at each measure it was measured at every frame the keyboard stayed up (a forced layout each).
      const fields = next ? [...document.querySelectorAll("[data-composer]")] : [];
      if (fields.length === watched.length && fields.every((composer, i) => composer === watched[i])) return;
      field?.disconnect();
      watched = fields;
      for (const composer of fields) field?.observe(composer);
    };
    const said = new MutationObserver(measure);
    said.observe(document.documentElement, { attributes: true, attributeFilter: ["data-keyboard"] });
    measure();
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      said.disconnect();
      field?.disconnect();
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      setRoom(null);
    };
  }, [enabled, keyboard]);
  // Where it is drawn: the box chosen, or with the keyboard up, in what it leaves. Never saved, so the box chosen
  // (its corner, where it was dragged) is back as the keyboard goes down.
  const placed = enabled && keyboard && room ? aboveKeyboard(box, room, aspect, minHeight) : { box, compact: false };
  const shown = placed.box;

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
    const grab = { x: event.clientX - shown.x, y: event.clientY - shown.y };
    gesture(event, (e) => fit({ ...shown, x: e.clientX - grab.x, y: e.clientY - grab.y }, aspect, minWidth, minHeight));
  };

  const startResize = (corner: Corner) => (event: React.PointerEvent) => {
    const east = corner.includes("e");
    const south = corner.includes("s");
    // The opposite corner stays where it is.
    const anchor = { x: east ? shown.x : shown.x + shown.w, y: south ? shown.y : shown.y + shown.h };
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

  const style = { left: shown.x, top: shown.y, width: shown.w, height: shown.h };
  return {
    box: shown,
    /** The one-line bar the keyboard leaves room for (`aboveKeyboard`): no corner grips, and it is not dragged. */
    compact: placed.compact,
    reset: () => commit(initial()),
    boxProps: !enabled
      ? { ref }
      : placed.compact
        ? { ref, style }
        : { ref, onPointerDown: startDrag, style: { ...style, touchAction: "none" as const } },
    handleProps: (corner: Corner) => ({ "data-handle": corner, onPointerDown: startResize(corner) }),
  };
}
