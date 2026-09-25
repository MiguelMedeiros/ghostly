import { STAGE, type Chapter } from "./poses";

/**
 * Where a chapter's picture goes on this screen. The film draws every chapter
 * on the 1440×900 landscape stage, cropped to fill the window, with the copy in
 * a fixed-width panel over it. On a window narrower or squarer than the stage
 * was composed for, the panel covers more of the stage and the crop cuts into
 * its sides, so the picture would slide under the copy or off the screen. A
 * framing moves and scales the whole picture (never its parts) just enough to
 * keep it clear of the copy and on screen. It first tries moving the picture
 * away from the copy (right for a panel on the left; left and up for a panel
 * at the bottom right) and only scales it down when there is no room to move:
 * then about the side away from the copy, keeping it inside the window. Where
 * the picture already fits, the framing is the identity.
 *
 * A framing maps stage units to stage units: p' = k·p + (x, y). (Not the
 * hero's `Frame` in poses.ts, which is what the window shows of the stage.)
 */
export type Framing = { k: number; x: number; y: number };
export const IDENTITY: Framing = { k: 1, x: 0, y: 0 };

/** [x0, y0, x1, y1] in landscape stage units. */
type Box = [number, number, number, number];

/**
 * What each chapter draws, over all its steps (camera push-ins included): the
 * boxes a framing keeps clear of the copy. Measured on a 1440×900 window, where
 * stage units are CSS pixels; `e2e/scene-overlap.spec.ts` checks the result.
 * A chapter whose copy sits in a corner lists its picture as several boxes,
 * so what is drawn above the panel does not count as being beside it.
 */
export const ART: Partial<Record<Chapter, Box[]>> = {
  // Boo, the invitation card and the link line, Casper once he has arrived (his entry from off stage is faded).
  invite: [[620, 380, 1310, 775]],
  // The copy is bottom-right: the network and its records, the two ghosts on their ground line (and the address
  // Casper reads, down to his hand), and the clock.
  dht: [
    [175, 125, 1000, 560],
    [170, 540, 830, 750],
    [1040, 180, 1210, 300],
  ],
  agree: [[690, 160, 1255, 755]],
  alive: [[700, 150, 1375, 795]],
  // The layer stack opened, its labels, the two ghosts and the other app's outline.
  open: [[530, 165, 1285, 885]],
};

/** Clear space kept between the picture and the copy panel, and inside the window, in CSS px. */
const GAP = 28;
const EDGE = 16;
/** The story rail's dots run along the bottom of the window. */
const RAIL = 24;
/** A framing never shrinks a picture further than this (windows that small get the cards layout anyway). */
const MIN_K = 0.45;
/** Candidate moves tried along each axis before the picture is scaled down a step. */
const STEPS = 16;

type Rect = { left: number; top: number; right: number; bottom: number };

export function framingFor({ chapter, side, copy, vw, vh, nav }: { chapter: Chapter; side: string; copy: Rect; vw: number; vh: number; nav: number }): Framing {
  const boxes = ART[chapter];
  if (!boxes?.length || vw <= 0 || vh <= 0) return IDENTITY;
  const { w, h } = STAGE.landscape;
  // The stage as drawn: `xMidYMid slice`.
  const s0 = Math.max(vw / w, vh / h);
  const ox = (vw - w * s0) / 2;
  const oy = (vh - h * s0) / 2;
  const bounds = { left: EDGE, top: nav + EDGE, right: vw - EDGE, bottom: vh - RAIL };
  const cornered = side.startsWith("bottom");
  const ax = cornered ? bounds.left : bounds.right;
  const ay = cornered ? bounds.top : (bounds.top + bounds.bottom) / 2;
  const clear = { left: copy.left - GAP, top: copy.top - GAP, right: copy.right + GAP, bottom: copy.bottom + GAP };
  const hits = (r: Rect) => r.left < clear.right && r.right > clear.left && r.top < clear.bottom && r.bottom > clear.top;

  // At scale k: the boxes scaled about the anchor, pulled back inside the window, then moved as little as
  // possible away from the copy (right for a panel on the left; left and up for one in the corner).
  const place = (k: number) => {
    const rects = boxes.map(([x0, y0, x1, y1]) => ({
      left: ax + k * (s0 * x0 + ox - ax),
      top: ay + k * (s0 * y0 + oy - ay),
      right: ax + k * (s0 * x1 + ox - ax),
      bottom: ay + k * (s0 * y1 + oy - ay),
    }));
    const u = {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    // An edge that sticks out is pulled in; a picture larger than the window is centred.
    const nudge = (lo: number, hi: number, min: number, max: number) =>
      hi - lo > max - min ? (min + max) / 2 - (lo + hi) / 2 : lo < min ? min - lo : hi > max ? max - hi : 0;
    const nx = nudge(u.left, u.right, bounds.left, bounds.right);
    const ny = nudge(u.top, u.bottom, bounds.top, bounds.bottom);
    // How far the picture can still travel away from the copy without leaving the window.
    const roomX = cornered ? Math.min(0, bounds.left - (u.left + nx)) : Math.max(0, bounds.right - (u.right + nx));
    const roomY = cornered ? Math.min(0, bounds.top - (u.top + ny)) : 0;
    const clearAt = (dx: number, dy: number) => !rects.some((r) => hits({ left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy }));
    const tries: [number, number][] = [];
    for (let i = 0; i <= STEPS; i++) for (let j = 0; j <= STEPS; j++) tries.push([(roomX * i) / STEPS, (roomY * j) / STEPS]);
    tries.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
    // A picture larger than the window cannot be placed at this scale at all.
    const fits = u.right - u.left <= bounds.right - bounds.left && u.bottom - u.top <= bounds.bottom - bounds.top;
    const shift = fits ? tries.find(([dx, dy]) => clearAt(nx + dx, ny + dy)) : undefined;
    return shift ? { dx: nx + shift[0], dy: ny + shift[1], ok: true } : { dx: nx, dy: ny, ok: false };
  };

  let k = 1;
  let at = place(k);
  while (!at.ok && k > MIN_K) {
    k = Math.round((k - 0.01) * 100) / 100;
    at = place(k);
  }
  // p' = k·p + ((1 − k)(a − o) + d) / s0, from s0·p' + o = a + k(s0·p + o − a) + d.
  const round = (v: number) => Math.round(v * 100) / 100;
  return { k, x: round(((1 - k) * (ax - ox) + at.dx) / s0), y: round(((1 - k) * (ay - oy) + at.dy) / s0) };
}

/** A chapter's framing on the current window, read from its section (the copy panel is measured where it is pinned). */
export function measureFraming(section: HTMLElement | null, chapter: Chapter): Framing {
  const panel = section?.querySelector<HTMLElement>(".scene-copy");
  const sticky = section?.querySelector<HTMLElement>(".scene-sticky");
  if (!section || !panel || !sticky) return IDENTITY;
  const s = sticky.getBoundingClientRect();
  const c = panel.getBoundingClientRect();
  const nav = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
  return framingFor({
    chapter,
    side: section.dataset.copy ?? "left",
    copy: { left: c.left - s.left, top: c.top - s.top, right: c.right - s.left, bottom: c.bottom - s.top },
    vw: s.width,
    vh: s.height,
    nav,
  });
}

export const lerpFraming = (a: Framing, b: Framing, t: number): Framing => ({ k: a.k + (b.k - a.k) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export const sameFraming = (a: Framing, b: Framing) => a.k === b.k && a.x === b.x && a.y === b.y;
