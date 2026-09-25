/**
 * The timeline and the two stages of the protocol explainer (ProtocolSteps.tsx).
 *
 * One number drives the picture: `--t`, seconds along a timeline that holds the
 * eight steps end to end. Step i is the stretch START[i] to END[i]; its last
 * moment is its finished frame. Playing a step moves `--t` over its stretch;
 * going back moves it the other way, so the step plays in reverse. Every shape
 * reads `--t` through a few generic rules in app/dev-steps.css with its own
 * times as inline custom properties, so all the times live here.
 *
 * The stages are the app's pairing scene (src/components/pairing/PairingScene.tsx:
 * two ghosts, the DHT mesh between them, the routes packets take) mapped onto
 * two boxes: landscape 800 × 380 and portrait 340 × 330. Labels are 14 units,
 * which stays at 12px or more wherever each stage is shown.
 */

export type P = readonly [number, number];

/** How long each step's animation runs, in seconds, ending on its finished frame. */
export const DURATION = [2.6, 2.4, 3.6, 2.8, 3.0, 3.8, 4.4, 4.2] as const;
export const START = DURATION.map((_, i) => round(DURATION.slice(0, i).reduce((a, b) => a + b, 0)));
export const END = START.map((s, i) => round(s + DURATION[i]));
export const STEPS = DURATION.length;

/** A moment of step i, `local` seconds after it starts. */
export const at = (i: number, local: number) => round(START[i] + local);

/** Casper's app opens the invite: the outline becomes a ghost. */
export const APPEAR = at(1, 1.8);
/** The session is ready: the line goes solid, the ghosts are happy. */
export const LIVE = at(5, 2.6);
/** The line drops (the floor step). */
export const DROP = at(7, 0.45);
/** The line is back. */
export const BACK = at(7, 3.2);
/** Far past the end: "stays". */
export const EVER = 999;

export function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

/** EASE.move (cubic-bezier(0.65, 0, 0.35, 1)) is easeInOutCubic; its inverse, to know when a packet passes a node. */
function invMove(e: number) {
  return e <= 0.5 ? Math.cbrt(e / 4) : 1 - Math.cbrt((1 - e) / 4);
}

/** Cumulative length fractions of a polyline's points. */
function fractions(pts: readonly P[]) {
  const lens = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]));
  const total = lens.reduce((a, b) => a + b, 0);
  let c = 0;
  return [0, ...lens.map((l) => (c += l) / total)];
}

/** When a packet leaving at `a` for `d` seconds passes each point of its route. */
export function passes(pts: readonly P[], a: number, d: number) {
  return fractions(pts).map((f) => round(a + d * invMove(f)));
}

/**
 * A CSS transform that carries a shape along a polyline as `--e` (its eased
 * progress, 0 to 1) grows, at an even speed along the whole route.
 */
export function along(pts: readonly P[]) {
  const f = fractions(pts);
  const xs = [`${pts[0][0]}px`];
  const ys = [`${pts[0][1]}px`];
  pts.slice(1).forEach((p, k) => {
    const dx = p[0] - pts[k][0];
    const dy = p[1] - pts[k][1];
    const span = f[k + 1] - f[k];
    const q = `clamp(0, (var(--e) - ${r4(f[k])}) / ${r4(span)}, 1)`;
    if (dx) xs.push(`${dx}px * ${q}`);
    if (dy) ys.push(`${dy}px * ${q}`);
  });
  return `translate(calc(${xs.join(" + ")}), calc(${ys.join(" + ")}))`;
}

function r4(n: number) {
  return Math.round(n * 10000) / 10000;
}

export const reverse = (pts: readonly P[]) => [...pts].reverse();
export const path = (pts: readonly P[]) => `M${pts.map((p) => p.join(" ")).join(" L")}`;

/* ── The two stages ───────────────────────────────────────── */

// The app's scene, in its own 320 × 150 box (PairingScene.tsx).
const APP = {
  me: [46, 80],
  peer: [274, 80],
  nodes: { n1: [104, 38], n3: [160, 52], n4: [216, 36], n2: [106, 122], n6: [160, 110], n5: [214, 124] },
  dots: [[136, 20], [186, 16], [138, 140], [188, 142], [80, 30], [242, 128]],
  mesh: [
    [[104, 38], [136, 20], [160, 52], [186, 16], [216, 36]],
    [[106, 122], [138, 140], [160, 110], [188, 142], [214, 124]],
    [[104, 38], [106, 122]],
    [[216, 36], [214, 124]],
    [[80, 30], [104, 38]],
    [[242, 128], [214, 124]],
  ],
  up: [[66, 76], [104, 38], [160, 52], [216, 36], [254, 76]],
  low: [[66, 84], [106, 122], [160, 110], [214, 124], [254, 84]],
  line: [[66, 80]],
} as const;

export type NodeId = keyof typeof APP.nodes;

export type Stage = {
  w: number;
  h: number;
  /** Ghost scale (the ghost path is drawn in an 80 × 100 box). */
  s: number;
  me: P;
  peer: P;
  nodes: Record<NodeId, P>;
  dots: P[];
  mesh: P[][];
  /** Boo to Casper, over the top of the mesh and under it. */
  up: P[];
  low: P[];
  /** Where Boo's two records land: the top route up to n3, the low one up to n6. */
  pubUp: P[];
  pubLow: P[];
  line: { y: number; x0: number; x1: number };
  nameY: number;
  label: P;
  tagTop: P;
  tagLow: P;
  /** The invite's way, out of band, under everything: a path and the points a ticket travels. */
  oob: { d: string; pts: P[]; code: P; tag: P };
  chips: { w: number; h: number; ys: number[]; me: number; peer: number };
  lanes: [number, number];
  above: number;
  below: number;
  thumbs: P;
  keyY: number;
  trio: number;
  /** Radius of a packet. */
  pk: number;
  /** A short form of the long labels, for the narrow stage. */
  short: boolean;
};

function stage(o: { w: number; h: number; kx: number; ky: number; oy: number; s: number }, rest: (m: (p: readonly [number, number]) => P) => Omit<Stage, "w" | "h" | "s" | "me" | "peer" | "nodes" | "dots" | "mesh" | "up" | "low" | "pubUp" | "pubLow" | "line">): Stage {
  const m = (p: readonly [number, number]): P => [Math.round(p[0] * o.kx), Math.round(o.oy + p[1] * o.ky)];
  const up = APP.up.map(m);
  const low = APP.low.map(m);
  const [l0] = APP.line.map(m);
  const me = m(APP.me);
  const peer = m(APP.peer);
  return {
    w: o.w,
    h: o.h,
    s: o.s,
    me,
    peer,
    nodes: Object.fromEntries(Object.entries(APP.nodes).map(([k, p]) => [k, m(p)])) as Record<NodeId, P>,
    dots: APP.dots.map(m),
    mesh: APP.mesh.map((line) => line.map(m)),
    up,
    low,
    pubUp: up.slice(0, 3),
    pubLow: low.slice(0, 3),
    // The line runs from one ghost's side to the other's.
    line: { y: l0[1], x0: Math.round(me[0] + 40 * o.s), x1: Math.round(peer[0] - 40 * o.s) },
    ...rest(m),
  };
}

export const LAND: Stage = stage({ w: 800, h: 380, kx: 2.5, ky: 1.7, oy: 44, s: 1.1 }, () => ({
  nameY: 262,
  label: [400, 22],
  tagTop: [400, 52],
  tagLow: [400, 306],
  oob: {
    d: "M160 228 Q176 330 236 330 L564 330 Q624 330 640 228",
    pts: [[160, 228], [172, 290], [200, 322], [236, 330], [564, 330], [600, 322], [628, 290], [640, 228]],
    code: [400, 330],
    tag: [400, 360],
  },
  chips: { w: 116, h: 22, ys: [16, 42, 68, 94], me: 115, peer: 685 },
  lanes: [180, 214],
  above: 156,
  below: 206,
  thumbs: [636, 104],
  keyY: 116,
  trio: 44,
  pk: 5,
  short: false,
}));

export const PORT: Stage = stage({ w: 340, h: 330, kx: 340 / 320, ky: 1.5, oy: 30, s: 0.74 }, () => ({
  nameY: 210,
  label: [170, 16],
  tagTop: [170, 36],
  tagLow: [170, 262],
  oob: {
    d: "M84 172 Q92 282 124 282 L216 282 Q248 282 256 172",
    pts: [[84, 172], [88, 230], [100, 268], [124, 282], [216, 282], [240, 268], [252, 230], [256, 172]],
    code: [170, 282],
    tag: [170, 312],
  },
  chips: { w: 90, h: 20, ys: [8, 32, 56, 80], me: 49, peer: 291 },
  lanes: [150, 180],
  above: 126,
  below: 176,
  thumbs: [274, 90],
  keyY: 104,
  trio: 30,
  pk: 4,
  short: true,
}));
