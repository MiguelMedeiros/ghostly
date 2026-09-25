import type { GhostMood } from "@/components/ghost/Ghost";
import { ease } from "@/lib/motion";

/**
 * The film's blocking, in stage units. Landscape stages are 1440×900 (safe
 * area x 160-1280, y 150-750); portrait stages are 390×844 (action zone
 * y 70-480, the caption sheet covers the rest). Every chapter reads its
 * actors, camera and focal point from here, and the act backdrop interpolates
 * between them, so the exit of one chapter is the entry of the next by
 * construction. `s` is the ghost's width; a ghost is 1.25× as tall.
 */
export type Pose = { x: number; y: number; s: number; a?: number };
export type Key<T> = [at: number, value: T];

export type ChapterBlocking = {
  boo: Key<Pose>[];
  casper: Key<Pose>[];
  /** Where the story is looking, per sub-progress; drives gazes and the key light. */
  focus: Key<[number, number]>[];
  /** Camera push-in about the focal point, per sub-progress (1 = no zoom). */
  camera: Key<number>[];
  /** Mood per step, for each actor. */
  moods: { boo: GhostMood[]; casper: GhostMood[] };
};

export type Chapter = "hero" | "invite" | "dht" | "agree" | "alive" | "open";
export type Orientation = "landscape" | "portrait";

/** Boo's opening pose on a 1440×900 window, the one the hero was drawn for. */
const HERO_REST: Pose = { x: 900, y: 330, s: 300 };

const L: Record<Chapter, ChapterBlocking> = {
  // Copy panels: invite left, dht bottom-right, agree bottom-right, alive left.
  hero: {
    // Drawn at a 1440×900 window; fitHero moves and shrinks this rest pose to the window the page is in.
    boo: [
      [0, HERO_REST],
      [0.2, HERO_REST],
      [0.8, { x: 640, y: 470, s: 240 }],
      [1, { x: 640, y: 470, s: 240 }],
    ],
    casper: [[0, { x: 1500, y: 470, s: 240, a: 0 }], [1, { x: 1500, y: 470, s: 240, a: 0 }]],
    focus: [[0, [1050, 480]], [1, [760, 620]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["lonely"], casper: ["calm"] },
  },
  invite: {
    // s0 the card grows from Boo's hem; s1 it flies to Casper, who enters late; s2 the link and the check.
    // Boo nods when Casper arrives (s1) and again when his chip pops (s2); Casper nods at his own chip.
    boo: [
      [0, { x: 640, y: 470, s: 240 }],
      [0.51, { x: 640, y: 470, s: 240 }],
      [0.53, { x: 640, y: 456, s: 240 }],
      [0.55, { x: 640, y: 470, s: 240 }],
      [0.69, { x: 640, y: 470, s: 240 }],
      [0.705, { x: 640, y: 456, s: 240 }],
      [0.72, { x: 640, y: 470, s: 240 }],
      [0.94, { x: 640, y: 470, s: 240 }],
      [1, { x: 200, y: 560, s: 150 }],
    ],
    casper: [
      [0, { x: 1500, y: 470, s: 240, a: 0 }],
      [0.4, { x: 1500, y: 470, s: 240, a: 0 }],
      [0.5, { x: 1060, y: 460, s: 240, a: 1 }],
      [0.73, { x: 1060, y: 460, s: 240, a: 1 }],
      [0.745, { x: 1060, y: 446, s: 240, a: 1 }],
      [0.76, { x: 1060, y: 460, s: 240, a: 1 }],
      [0.94, { x: 1060, y: 460, s: 240, a: 1 }],
      [1, { x: 610, y: 560, s: 150, a: 1 }],
    ],
    focus: [[0, [820, 620]], [0.36, [900, 480]], [0.62, [1180, 560]], [0.7, [960, 800]], [1, [960, 800]]],
    camera: [[0, 1], [0.74, 1], [0.84, 1.1], [0.94, 1.1], [1, 1]],
    moods: { boo: ["curious", "happy", "happy"], casper: ["calm", "surprised", "happy"] },
  },
  dht: {
    boo: [
      [0, { x: 200, y: 560, s: 150 }],
      [0.7, { x: 200, y: 560, s: 150 }],
      [0.715, { x: 200, y: 536, s: 150 }],
      [0.73, { x: 200, y: 560, s: 150 }],
      [0.94, { x: 200, y: 560, s: 150 }],
      // Act I ends here: the two rise toward the next act and fade before the backdrop scrolls away.
      [1, { x: 735, y: 150, s: 170, a: 0 }],
    ],
    // Casper dims into a flashback (Boo alone at the network) and returns when the invitation opens the records.
    casper: [
      [0, { x: 610, y: 560, s: 150, a: 1 }],
      [0.06, { x: 610, y: 560, s: 150, a: 0.35 }],
      [0.5, { x: 610, y: 560, s: 150, a: 0.35 }],
      [0.56, { x: 610, y: 560, s: 150, a: 1 }],
      [0.94, { x: 610, y: 560, s: 150, a: 1 }],
      [1, { x: 1055, y: 150, s: 170, a: 0 }],
    ],
    focus: [[0, [560, 340]], [0.3, [560, 340]], [0.5, [420, 280]], [0.62, [560, 340]], [0.72, [275, 640]], [0.78, [1150, 200]], [1, [1150, 200]]],
    camera: [[0, 1], [0.5, 1], [0.6, 1.12], [0.72, 1.12], [0.8, 1], [1, 1]],
    moods: { boo: ["curious", "talk", "happy", "calm"], casper: ["calm", "calm", "excited", "calm"] },
  },
  agree: {
    // Landscape heads never above y 190 (portrait 150): a 64px nav sits over a stage that 2:1 viewports crop by 90.
    // Act II opens as it pins: the two settle in from a little above while they fade in, so nothing of them
    // shows while the statement has the screen. Casper nods when the plan lands (step 2).
    boo: [
      [0, { x: 735, y: 160, s: 170, a: 0 }],
      [0.04, { x: 735, y: 190, s: 170, a: 1 }],
      [0.94, { x: 735, y: 190, s: 170 }],
      [1, { x: 690, y: 360, s: 220 }],
    ],
    casper: [
      [0, { x: 1055, y: 160, s: 170, a: 0 }],
      [0.04, { x: 1055, y: 190, s: 170, a: 1 }],
      [0.72, { x: 1055, y: 190, s: 170 }],
      [0.735, { x: 1055, y: 178, s: 170 }],
      [0.75, { x: 1055, y: 190, s: 170 }],
      [0.94, { x: 1055, y: 190, s: 170 }],
      [1, { x: 1170, y: 360, s: 220 }],
    ],
    focus: [[0, [820, 500]], [0.34, [980, 480]], [0.68, [1080, 680]], [1, [1080, 680]]],
    camera: [[0, 1], [0.66, 1], [0.78, 1.06], [0.94, 1.06], [1, 1]],
    moods: { boo: ["calm", "wink", "happy"], casper: ["calm", "calm", "happy"] },
  },
  alive: {
    // The act ends here: the two fade out as the reading room arrives instead of being cut by the act's edge.
    boo: [
      [0, { x: 690, y: 360, s: 220 }],
      [0.36, { x: 690, y: 360, s: 220 }],
      [0.5, { x: 730, y: 360, s: 220 }],
      [0.94, { x: 730, y: 360, s: 220 }],
      [1, { x: 730, y: 360, s: 220, a: 0 }],
    ],
    casper: [
      [0, { x: 1170, y: 360, s: 220 }],
      [0.36, { x: 1170, y: 360, s: 220 }],
      [0.5, { x: 1130, y: 360, s: 220 }],
      [0.94, { x: 1130, y: 360, s: 220 }],
      [1, { x: 1130, y: 360, s: 220, a: 0 }],
    ],
    focus: [[0, [1030, 200]], [0.34, [1030, 200]], [0.4, [1030, 520]], [0.66, [1030, 520]], [0.72, [1030, 740]], [1, [1030, 740]]],
    camera: [[0, 1], [0.36, 1], [0.48, 1.08], [0.62, 1.08], [0.72, 1], [1, 1]],
    moods: { boo: ["calm", "talk", "happy"], casper: ["calm", "happy", "happy"] },
  },
  open: {
    boo: [[0, { x: 700, y: 330, s: 120 }], [1, { x: 700, y: 330, s: 120 }]],
    casper: [[0, { x: 820, y: 336, s: 120 }], [1, { x: 820, y: 336, s: 120 }]],
    focus: [[0, [760, 520]], [0.5, [760, 440]], [1, [760, 440]]],
    camera: [[0, 1], [0.1, 1], [0.55, 1.06], [1, 1.06]],
    moods: { boo: ["happy", "curious"], casper: ["happy", "happy"] },
  },
};

const P: Record<Chapter, ChapterBlocking> = {
  hero: {
    boo: [[0, { x: 110, y: 150, s: 170 }], [0.5, { x: 110, y: 150, s: 170 }], [0.9, { x: 20, y: 260, s: 150 }], [1, { x: 20, y: 260, s: 150 }]],
    casper: [[0, { x: 420, y: 260, s: 150, a: 0 }], [1, { x: 420, y: 260, s: 150, a: 0 }]],
    focus: [[0, [195, 60]], [1, [195, 400]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["lonely"], casper: ["calm"] },
  },
  invite: {
    boo: [[0, { x: 20, y: 260, s: 150 }], [0.94, { x: 20, y: 260, s: 150 }], [1, { x: 10, y: 330, s: 120 }]],
    casper: [
      [0, { x: 420, y: 260, s: 150, a: 0 }],
      [0.4, { x: 420, y: 260, s: 150, a: 0 }],
      [0.5, { x: 220, y: 260, s: 150, a: 1 }],
      [0.94, { x: 220, y: 260, s: 150, a: 1 }],
      [1, { x: 260, y: 330, s: 120, a: 1 }],
    ],
    focus: [[0, [130, 200]], [0.36, [195, 140]], [0.62, [290, 330]], [0.7, [195, 450]], [1, [195, 450]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["curious", "happy", "happy"], casper: ["calm", "surprised", "happy"] },
  },
  dht: {
    boo: [[0, { x: 10, y: 330, s: 120 }], [0.7, { x: 10, y: 330, s: 120 }], [0.715, { x: 10, y: 312, s: 120 }], [0.73, { x: 10, y: 330, s: 120 }], [0.94, { x: 10, y: 330, s: 120 }], [1, { x: 10, y: 150, s: 110 }]],
    casper: [
      [0, { x: 260, y: 330, s: 120, a: 1 }],
      [0.06, { x: 260, y: 330, s: 120, a: 0.35 }],
      [0.5, { x: 260, y: 330, s: 120, a: 0.35 }],
      [0.56, { x: 260, y: 330, s: 120, a: 1 }],
      [0.94, { x: 260, y: 330, s: 120, a: 1 }],
      [1, { x: 270, y: 150, s: 110, a: 1 }],
    ],
    focus: [[0, [195, 230]], [0.5, [140, 180]], [0.62, [195, 230]], [0.72, [70, 400]], [0.78, [340, 90]], [1, [340, 90]]],
    camera: [[0, 1], [0.5, 1], [0.6, 1.06], [0.72, 1.06], [0.8, 1], [1, 1]],
    moods: { boo: ["curious", "talk", "happy", "calm"], casper: ["calm", "calm", "excited", "calm"] },
  },
  agree: {
    boo: [[0, { x: 10, y: 150, s: 110 }], [0.94, { x: 10, y: 150, s: 110 }], [1, { x: 10, y: 190, s: 130 }]],
    casper: [[0, { x: 270, y: 150, s: 110 }], [0.94, { x: 270, y: 150, s: 110 }], [1, { x: 250, y: 190, s: 130 }]],
    focus: [[0, [80, 340]], [0.34, [195, 340]], [0.68, [195, 400]], [1, [195, 400]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["calm", "wink", "happy"], casper: ["calm", "calm", "happy"] },
  },
  alive: {
    boo: [[0, { x: 10, y: 190, s: 130 }], [0.36, { x: 10, y: 190, s: 130 }], [0.5, { x: 30, y: 190, s: 130 }], [0.94, { x: 30, y: 190, s: 130 }], [1, { x: 30, y: 190, s: 130, a: 0 }]],
    casper: [[0, { x: 250, y: 190, s: 130 }], [0.36, { x: 250, y: 190, s: 130 }], [0.5, { x: 230, y: 190, s: 130 }], [0.94, { x: 230, y: 190, s: 130 }], [1, { x: 230, y: 190, s: 130, a: 0 }]],
    focus: [[0, [195, 80]], [0.34, [195, 80]], [0.4, [195, 300]], [0.66, [195, 300]], [0.72, [195, 430]], [1, [195, 430]]],
    camera: [[0, 1], [0.36, 1], [0.48, 1.06], [0.62, 1.06], [0.72, 1], [1, 1]],
    moods: { boo: ["calm", "talk", "happy"], casper: ["calm", "happy", "happy"] },
  },
  open: {
    boo: [[0, { x: 130, y: 150, s: 70 }], [1, { x: 130, y: 150, s: 70 }]],
    casper: [[0, { x: 200, y: 154, s: 70 }], [1, { x: 200, y: 154, s: 70 }]],
    focus: [[0, [195, 300]], [1, [195, 260]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["happy", "curious"], casper: ["happy", "happy"] },
  },
};

export const BLOCKING: Record<Orientation, Record<Chapter, ChapterBlocking>> = { landscape: L, portrait: P };

/** Chapter rooms: the backdrop fill while a chapter plays. */
export const ROOMS: Record<Chapter, string> = {
  hero: "#05070b",
  invite: "#05070b",
  dht: "#070a1f",
  agree: "#030507",
  alive: "#030507",
  open: "#0b0716",
};

export const STAGE = {
  landscape: { w: 1440, h: 900 },
  portrait: { w: 390, h: 844 },
} as const;

/** A glide longer than this (stage units) starts with a small step back; shorter moves (nods) do not. */
const ANTICIPATED = 60;
/** How far back, as a fraction of the glide, and over which first part of it. */
const ANTICIPATION = 0.06;
const ANTICIPATION_END = 0.35;

/**
 * The pose at a sub-progress, between keys on the move curve. A glide between
 * two places starts with a small step the other way (anticipation) and lands
 * softly; the actor spring in Act.tsx adds the follow-through. Opacity and
 * size go on the same curve, with no anticipation.
 */
export function poseAt(keys: Key<Pose>[], t: number): Required<Pose> {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
  const [a, pa] = keys[i];
  const [b, pb] = keys[Math.min(i + 1, keys.length - 1)];
  const k = b === a ? 0 : Math.max(0, Math.min(1, (t - a) / (b - a)));
  const e = ease.move(k);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const far = Math.hypot(dx, dy) > ANTICIPATED;
  const dip = far && k < ANTICIPATION_END ? Math.sin((Math.PI * k) / ANTICIPATION_END) * ANTICIPATION : 0;
  const mix = (u: number, v: number) => u + (v - u) * e;
  return { x: pa.x + dx * (e - dip), y: pa.y + dy * (e - dip), s: mix(pa.s, pb.s), a: mix(pa.a ?? 1, pb.a ?? 1) };
}

/** A value at a sub-progress, between keys on the move curve (the camera, the focal point). */
export function valueAt<T extends number | [number, number]>(keys: Key<T>[], t: number): T {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
  const [a, va] = keys[i];
  const [b, vb] = keys[Math.min(i + 1, keys.length - 1)];
  const k = ease.move(b === a ? 0 : Math.max(0, Math.min(1, (t - a) / (b - a))));
  if (typeof va === "number") return (va + ((vb as number) - va) * k) as T;
  const [x1, y1] = va as [number, number];
  const [x2, y2] = vb as [number, number];
  return [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k] as T;
}

/**
 * What a window shows of a landscape stage, in stage units: the visible box
 * below the nav (`slice` crops the sides of narrow windows and the top and
 * bottom of wide ones), how many pixels one unit takes (`k`), and the right
 * edge of the hero copy.
 */
export type Frame = { l: number; t: number; r: number; b: number; k: number; copyRight: number };

// A ghost of width s draws its glow from x − 0.2s to x + 1.2s and from y − 0.175s to
// y + 1.325s (the halo ellipse in Ghost.tsx); the idle bob lifts it by another 0.08s.
const GLOW = { l: 0.2, r: 1.2, t: 0.255, b: 1.325 };

/**
 * Boo's hero pose, fitted to the window. He keeps the drawn pose where it fits
 * and otherwise shrinks and slides into the strip right of the copy, so that
 * his whole glow stays on screen, clear of the copy, with room above his head
 * for his line (up to two lines of the Act bubble). The same rule covers
 * squarish, tall and very wide windows: nothing depends on one size.
 */
export function fitHero(p: Pose, f: Frame): Pose {
  const m = 16 / f.k;
  const fs = Math.max(18, 13 / f.k);
  const left = Math.max(f.l + m, f.copyRight + 8 / f.k);
  const right = f.r - m;
  const bottom = f.b - m;
  // The bubble ends 8 − 0.04s above his pose's top and is at most 4.2 font sizes tall; it stays 8px under the nav.
  const line = 8 / f.k + fs * 4.2 + 8;
  const s = Math.max(
    60,
    Math.min(p.s, (right - left) / (GLOW.l + GLOW.r), (bottom - f.t) / (GLOW.t + GLOW.b), (bottom - f.t - line) / (GLOW.b - 0.04)),
  );
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  // Keep his place as far as the window allows: same left edge, same middle height.
  const x = clamp(p.x, left + GLOW.l * s, right - GLOW.r * s);
  const y = clamp(p.y + (p.s - s) * 0.625, f.t + Math.max(GLOW.t * s, line - 0.04 * s), bottom - GLOW.b * s);
  return { ...p, x: Math.round(x), y: Math.round(y), s: Math.round(s) };
}

/** A chapter's blocking for a window: the hero's rest pose is fitted to it, everything else is the table. */
export function blockingFor(orient: Orientation, chapter: Chapter, frame: Frame | null): ChapterBlocking {
  const b = BLOCKING[orient][chapter];
  if (!frame || orient !== "landscape" || chapter !== "hero") return b;
  const rest = fitHero(HERO_REST, frame);
  return { ...b, boo: b.boo.map(([t, v]) => [t, v === HERO_REST ? rest : v] as Key<Pose>) };
}
