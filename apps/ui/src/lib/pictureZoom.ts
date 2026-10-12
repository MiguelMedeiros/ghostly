/**
 * The picture viewer's zoom (components/AvatarViewer.tsx), as plain numbers: how far the picture is scaled and moved
 * from where the page laid it out. The viewer draws it as `translate(x, y) scale(scale)` around the picture's center.
 */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A box on the screen, in CSS pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const FIT: Zoom = { scale: 1, x: 0, y: 0 };
/** As large as a picture goes: past this a phone's photo is only blur. */
export const MAX_SCALE = 5;
/** Where a double tap (or `+`) takes a picture that is whole on the screen. */
export const TAP_SCALE = 2.5;

export const isZoomed = (zoom: Zoom) => zoom.scale > 1.001;

/** Where the picture's center is drawn: its laid-out center, moved. */
const center = (base: Box, zoom: Zoom): Point => ({ x: base.left + base.width / 2 + zoom.x, y: base.top + base.height / 2 + zoom.y });

/**
 * The picture scaled to `scale` (within 1..MAX_SCALE) with the point under `at` (on the screen) left under it, as a
 * pinch's fingers or the mouse's wheel expect.
 */
export function zoomAt(zoom: Zoom, scale: number, at: Point, base: Box): Zoom {
  const next = Math.min(MAX_SCALE, Math.max(1, scale));
  const c = center(base, zoom), ratio = next / zoom.scale;
  return { scale: next, x: zoom.x + (at.x - c.x) * (1 - ratio), y: zoom.y + (at.y - c.y) * (1 - ratio) };
}

/**
 * What a pinch made of the zoom it started from: the point between the fingers when they went down is under the
 * point between them now, at the scale their spread changed by.
 */
export function pinch(start: Zoom, startMid: Point, startSpread: number, mid: Point, spread: number, base: Box): Zoom {
  const scale = Math.min(MAX_SCALE, Math.max(1, start.scale * (startSpread > 0 ? spread / startSpread : 1)));
  const c = center(base, start);
  // The picture's own point under the fingers at the start (from its center, unscaled) …
  const px = (startMid.x - c.x) / start.scale, py = (startMid.y - c.y) / start.scale;
  // … drawn under them now.
  const cx = base.left + base.width / 2, cy = base.top + base.height / 2;
  return { scale, x: mid.x - cx - px * scale, y: mid.y - cy - py * scale };
}

/** One axis of `clamp`: the picture centered when it fits, and its edges never inside the view when it does not. */
function clampAxis(offset: number, start: number, size: number, scale: number, viewStart: number, viewSize: number): number {
  const drawn = size * scale, mid = start + size / 2;
  if (drawn <= viewSize) return 0;
  // Its near edge no further in than the view's, nor its far edge.
  const most = viewStart - (mid - drawn / 2), least = viewStart + viewSize - (mid + drawn / 2);
  return Math.min(most, Math.max(least, offset));
}

/**
 * Kept on the screen: at 1 the picture is where the page put it; larger, it is never moved so far that a blank band
 * shows between its edge and the view's on an axis where it is larger than the view, and centered on one where not.
 */
export function clamp(zoom: Zoom, base: Box, view: Box): Zoom {
  const scale = Math.min(MAX_SCALE, Math.max(1, zoom.scale));
  if (scale <= 1.001) return FIT;
  return {
    scale,
    x: clampAxis(zoom.x, base.left, base.width, scale, view.left, view.width),
    y: clampAxis(zoom.y, base.top, base.height, scale, view.top, view.height),
  };
}

/** A double tap: back to whole when zoomed, else in to TAP_SCALE around the tap. */
export const toggleAt = (zoom: Zoom, at: Point, base: Box, view: Box): Zoom =>
  isZoomed(zoom) ? FIT : clamp(zoomAt(zoom, TAP_SCALE, at, base), base, view);

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Where the page laid the picture out, from where it is drawn now (its box on the screen with this zoom). */
export function laidOut(drawn: Box, zoom: Zoom): Box {
  const width = drawn.width / zoom.scale, height = drawn.height / zoom.scale;
  const cx = drawn.left + drawn.width / 2 - zoom.x, cy = drawn.top + drawn.height / 2 - zoom.y;
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}
