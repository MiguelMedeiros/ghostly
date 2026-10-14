import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { FIT, MAX_SCALE, clamp, distance, isZoomed, laidOut, midpoint, pinch, toggleAt, zoomAt, type Box, type Point, type Zoom } from "../lib/pictureZoom";

/** Two taps closer than this, in time and on the screen, are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
/** A finger that moved less than this still tapped. */
const TAP_SLOP_PX = 8;
/** How far one `+` or `-` goes. */
const KEY_STEP = 1.5;
/** How far an arrow key moves a zoomed picture. */
const KEY_PAN_PX = 48;

const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
const point = (e: { clientX: number; clientY: number }): Point => ({ x: e.clientX, y: e.clientY });

/** Where the page laid the picture out (from where it is drawn with `zoom`), and the area it may be moved in. */
function measureOf(picture: HTMLElement | null, view: HTMLElement | null, zoom: Zoom): { base: Box; area: Box } | null {
  if (!picture || !view) return null;
  return { base: laidOut(box(picture), zoom), area: box(view) };
}

type Gesture =
  | { kind: "pan"; start: Zoom; from: Point }
  | { kind: "pinch"; start: Zoom; mid: Point; spread: number };

/**
 * Zoom and pan for the picture viewer (components/AvatarViewer.tsx), so a phone's pinch scales the picture and not
 * the page: two fingers zoom around themselves (1× to MAX_SCALE), one finger moves a zoomed picture, a double tap goes
 * in at the tap and back to whole. With a mouse: the wheel (a trackpad's pinch) zooms at the pointer, a double click
 * toggles, a drag moves. From the keyboard: `+` / `-` / `0`, arrows move a zoomed picture.
 *
 * `picture` is the element drawn with the zoom's transform; `view` the area that takes the gestures (the whole viewer,
 * so a pinch that starts beside a small picture still zooms it). The zoom starts whole each time the viewer opens,
 * and goes back to whole when the window changes size (the layout it was measured against is gone).
 */
export function usePictureZoom(picture: RefObject<HTMLElement | null>, view: RefObject<HTMLElement | null>) {
  const [zoom, setZoomState] = useState<Zoom>(FIT);
  const current = useRef<Zoom>(FIT);
  const setZoom = useCallback((next: Zoom) => { current.current = next; setZoomState(next); }, []);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  /** The pointers down now did more than tap: a pinch, a drag, a double tap. The viewer does not close for them. */
  const gestured = useRef(false);
  const downAt = useRef<Point | null>(null);
  const lastTap = useRef<{ at: Point; time: number } | null>(null);
  /** What the last pointer was: a browser may follow a touch double tap with its own dblclick, already handled. */
  const lastType = useRef("mouse");

  const measure = () => measureOf(picture.current, view.current, current.current);

  const begin = useCallback(() => {
    const points = [...pointers.current.values()];
    if (points.length >= 2) gesture.current = { kind: "pinch", start: current.current, mid: midpoint(points[0], points[1]), spread: distance(points[0], points[1]) };
    else if (points.length === 1) gesture.current = { kind: "pan", start: current.current, from: points[0] };
    else gesture.current = null;
  }, []);

  useEffect(() => {
    const element = view.current;
    if (!element) return;
    // The wheel, and a trackpad's pinch (a wheel with ctrlKey): not the page's zoom or scroll. Not passive, to stop it.
    const wheel = (e: WheelEvent) => {
      const m = measureOf(picture.current, element, current.current);
      if (!m) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      setZoom(clamp(zoomAt(current.current, current.current.scale * factor, point(e), m.base), m.base, m.area));
    };
    // Safari's own pinch events (iOS, a Mac's trackpad): the page must not zoom under the viewer.
    const gestureEvent = (e: Event) => e.preventDefault();
    const resized = () => setZoom(FIT);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", gestureEvent);
    element.addEventListener("gesturechange", gestureEvent);
    window.addEventListener("resize", resized);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", gestureEvent);
      element.removeEventListener("gesturechange", gestureEvent);
      window.removeEventListener("resize", resized);
    };
  }, [picture, view, setZoom]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    lastType.current = e.pointerType;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A primary pointer going down means no other is: one whose end never reached here (lifted off the window) is gone.
    if (e.isPrimary) pointers.current.clear();
    if (pointers.current.size === 0) { gestured.current = false; downAt.current = point(e); }
    pointers.current.set(e.pointerId, point(e));
    if (pointers.current.size > 1) gestured.current = true;
    begin();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, point(e));
    const g = gesture.current, m = measure();
    if (!g || !m) return;
    const points = [...pointers.current.values()];
    if (g.kind === "pinch" && points.length >= 2) {
      gestured.current = true;
      setZoom(clamp(pinch(g.start, g.mid, g.spread, midpoint(points[0], points[1]), distance(points[0], points[1]), m.base), m.base, m.area));
    } else if (g.kind === "pan") {
      const at = points[0];
      if (downAt.current && distance(at, downAt.current) > TAP_SLOP_PX) gestured.current = true;
      if (isZoomed(g.start)) setZoom(clamp({ ...g.start, x: g.start.x + at.x - g.from.x, y: g.start.y + at.y - g.from.y }, m.base, m.area));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    // A finger lifted from a pinch: the other one goes on moving the picture from where it is now.
    begin();
    if (pointers.current.size > 0 || gestured.current || e.pointerType === "mouse") return;
    // A tap: the second one in a row zooms (a mouse has its own double click).
    const at = point(e), last = lastTap.current;
    if (last && e.timeStamp - last.time < DOUBLE_TAP_MS && distance(at, last.at) < DOUBLE_TAP_PX) {
      lastTap.current = null;
      gestured.current = true;
      const m = measure();
      if (m) setZoom(toggleAt(current.current, at, m.base, m.area));
    } else {
      lastTap.current = { at, time: e.timeStamp };
    }
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    gestured.current = true;
    begin();
  };

  const onDoubleClick = (e: { clientX: number; clientY: number }) => {
    if (lastType.current !== "mouse") return;
    const m = measure();
    if (m) setZoom(toggleAt(current.current, point(e), m.base, m.area));
  };

  /** `+` / `-` / `0` and the arrows; true when the key was the zoom's. */
  const onKey = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const m = measure();
    if (!m) return false;
    const middle = { x: m.base.left + m.base.width / 2, y: m.base.top + m.base.height / 2 }, z = current.current;
    const pan = { ArrowLeft: [KEY_PAN_PX, 0], ArrowRight: [-KEY_PAN_PX, 0], ArrowUp: [0, KEY_PAN_PX], ArrowDown: [0, -KEY_PAN_PX] }[e.key];
    if (e.key === "+" || e.key === "=") setZoom(clamp(zoomAt(z, Math.min(MAX_SCALE, z.scale * KEY_STEP), middle, m.base), m.base, m.area));
    else if (e.key === "-" || e.key === "_") setZoom(clamp(zoomAt(z, z.scale / KEY_STEP, middle, m.base), m.base, m.area));
    else if (e.key === "0") setZoom(FIT);
    else if (pan && isZoomed(z)) setZoom(clamp({ ...z, x: z.x + pan[0], y: z.y + pan[1] }, m.base, m.area));
    else return false;
    return true;
  };

  return {
    zoom,
    /** Whether the pointers down now (or last) made a gesture rather than a tap: the viewer stays open for it. */
    gestured: () => gestured.current,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onDoubleClick },
    onKey,
  };
}
