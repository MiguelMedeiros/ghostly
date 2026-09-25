"use client";

/**
 * Motion tokens: every animation on the site takes its curve, duration and
 * spring from here (CSS mirrors them as --ease-*, --dur-* in app/site.css).
 * The rules that go with them are in website/MOTION.md.
 */

/** Cubic-bézier curves, as motion `ease` arrays. Three curves, one job each. */
export const EASE = {
  /** Arriving: fast start, long soft landing. Entrances, settles, hover in. */
  enter: [0.22, 1, 0.36, 1],
  /** Leaving: a quiet start, gone quickly. Exits, hover out. */
  exit: [0.55, 0, 1, 0.45],
  /** Travelling from A to B while on screen: a beat in a chapter, a loop, a demo. */
  move: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Durations in seconds. Nothing on the site animates for longer than `beat` unless it is scrubbed by scroll or loops. */
export const DUR = {
  /** Hover, press, focus: feedback. 140 ms. */
  fast: 0.14,
  /** A small change: a chip, a caption swap, a card. 280 ms. */
  base: 0.28,
  /** A large element or a whole scene arriving. 560 ms. */
  slow: 0.56,
  /** One story beat played in full (cards mode, loops). */
  beat: 1.8,
} as const;

/** Stagger between siblings entering in sequence (words, chips, rows); after `STAGGER_MAX` siblings the rest arrive together. */
export const STAGGER = 0.06;
export const STAGGER_MAX = 6;

/**
 * Springs. `body` is the one spring for physical things (the ghosts, the
 * pointer ghost): just under critical damping, so a stop carries a hint of
 * follow-through. `ui` is for small interface elements. Scroll-driven scenes
 * are smoothed by the playhead instead (`SCRUB`).
 */
export const SPRING = {
  body: { stiffness: 130, damping: 19, mass: 0.9 },
  ui: { stiffness: 380, damping: 32, mass: 0.6 },
} as const;

/**
 * The story's playhead (lib/playhead.ts): how the pictures follow the scroll.
 * The scroll is the reader's; these only shape how the pictures catch up.
 */
export const SCRUB = {
  /** Outside a beat the playhead follows the scroll with a critically damped glide of about this time (s). */
  follow: 0.12,
  /**
   * Inside a beat it moves at most this many viewport heights a second, so a flick still shows every beat it
   * crosses: a step's action (0.57 of a 70-viewport step) plays in about 0.8 s, a 4% fade in a blink.
   */
  pace: 0.72,
  /** However many beats a flick crossed, catching up takes at most this long (s): past it, every beat plays faster. */
  catchUp: 1.2,
  /** How hard it may slow down on its way into a beat, in viewport heights per second squared: it eases in, never brakes. */
  decel: 30,
  /** The scroll counts as stopped after this long without moving (ms), where the browser has no `scrollend`. */
  rest: 140,
  /** A scroll that moves more than this many viewport heights at once is a jump: it is taken at once, nothing replays. */
  jump: 1.5,
  /** A scene's beats still count until it has scrolled this many viewport heights past its pinned range (most of it is on screen). */
  seen: 0.4,
} as const;

/**
 * The hero's opening, in seconds from the first paint: the headline leads, the
 * rest of the copy follows as one group, then Boo arrives from below, then his
 * line is typed, then the cue to follow him nudges once. CSS mirrors the copy
 * part in app/home.css (--hero-*).
 */
export const HERO = {
  /** The headline starts rising. */
  headline: 0.05,
  /** The lead, buttons and micro line follow as a group. */
  copy: 0.32,
  /** Boo starts up from below his place. */
  arriveAfter: 0.7,
  /** How far below, in stage units. */
  arriveFrom: 70,
  /** His line starts typing, once the body spring has set him down. */
  lineAfter: 1.7,
  /** Per character. */
  typeMs: 30,
  /** The follow cue nudges once, after the line has been read. */
  cueAfter: 3.6,
} as const;

/**
 * A story beat inside a step of a chapter, as fractions of the step. The
 * step's copy changes at the step's edge; its picture moves between
 * `establish` and `settle` (the subject arrives or is singled out, then does
 * its one thing), and nothing moves after `settle`, so a reader who stops
 * scrolling there sees the finished picture. The playhead treats that window
 * as the beat: a stop inside it finishes it (or rewinds it, scrolling up).
 */
export const BEAT = { establish: 0.04, settle: 0.86 } as const;

/** A cubic-bézier as a function of progress, for `useTransform` ranges. */
export function bezier([x1, y1, x2, y2]: readonly [number, number, number, number]): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-5) break;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    return sampleY(Math.max(0, Math.min(1, t)));
  };
}

/** The three curves as functions (motion's `ease` option on a transform, or maths in a scene). */
export const ease = {
  enter: bezier(EASE.enter),
  exit: bezier(EASE.exit),
  move: bezier(EASE.move),
} as const;
