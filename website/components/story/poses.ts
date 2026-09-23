import type { GhostMood } from "@/components/ghost/Ghost";

/**
 * The film's blocking, in stage units. Landscape stages are 1440×900 (safe
 * area x 160–1280, y 150–750); portrait stages are 390×844 (action zone
 * y 70–480, the caption sheet covers the rest). Every chapter reads its
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

const L: Record<Chapter, ChapterBlocking> = {
  // Copy panels: invite left, dht bottom-right, agree bottom-right, alive left.
  hero: {
    boo: [
      [0, { x: 900, y: 330, s: 300 }],
      [0.2, { x: 900, y: 330, s: 300 }],
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
    boo: [
      [0, { x: 640, y: 470, s: 240 }],
      [0.94, { x: 640, y: 470, s: 240 }],
      [1, { x: 200, y: 560, s: 150 }],
    ],
    casper: [
      [0, { x: 1500, y: 470, s: 240, a: 0 }],
      [0.5, { x: 1500, y: 470, s: 240, a: 0 }],
      [0.6, { x: 1060, y: 460, s: 240, a: 1 }],
      [0.94, { x: 1060, y: 460, s: 240, a: 1 }],
      [1, { x: 700, y: 560, s: 150, a: 1 }],
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
      [1, { x: 660, y: 96, s: 170 }],
    ],
    casper: [
      [0, { x: 700, y: 560, s: 150, a: 0.35 }],
      [0.5, { x: 700, y: 560, s: 150, a: 0.35 }],
      [0.56, { x: 700, y: 560, s: 150, a: 1 }],
      [0.94, { x: 700, y: 560, s: 150, a: 1 }],
      [1, { x: 1080, y: 96, s: 170, a: 1 }],
    ],
    focus: [[0, [560, 340]], [0.3, [560, 340]], [0.5, [420, 280]], [0.62, [560, 340]], [0.72, [275, 640]], [0.78, [1150, 200]], [1, [1150, 200]]],
    camera: [[0, 1], [0.5, 1], [0.6, 1.12], [0.72, 1.12], [0.8, 1], [1, 1]],
    moods: { boo: ["curious", "talk", "happy", "calm"], casper: ["calm", "calm", "excited", "calm"] },
  },
  agree: {
    boo: [
      [0, { x: 660, y: 96, s: 170 }],
      [0.94, { x: 660, y: 96, s: 170 }],
      [1, { x: 690, y: 360, s: 220 }],
    ],
    casper: [
      [0, { x: 1080, y: 96, s: 170 }],
      [0.94, { x: 1080, y: 96, s: 170 }],
      [1, { x: 1170, y: 360, s: 220 }],
    ],
    focus: [[0, [760, 420]], [0.34, [950, 400]], [0.68, [1000, 650]], [1, [1000, 650]]],
    camera: [[0, 1], [0.66, 1], [0.78, 1.06], [0.94, 1.06], [1, 1]],
    moods: { boo: ["calm", "wink", "happy"], casper: ["calm", "calm", "happy"] },
  },
  alive: {
    boo: [
      [0, { x: 690, y: 360, s: 220 }],
      [0.36, { x: 690, y: 360, s: 220 }],
      [0.5, { x: 730, y: 360, s: 220 }],
      [1, { x: 730, y: 360, s: 220 }],
    ],
    casper: [
      [0, { x: 1170, y: 360, s: 220 }],
      [0.36, { x: 1170, y: 360, s: 220 }],
      [0.5, { x: 1130, y: 360, s: 220 }],
      [1, { x: 1130, y: 360, s: 220 }],
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
    boo: [[0, { x: 110, y: 150, s: 170 }], [0.8, { x: 20, y: 260, s: 150 }], [1, { x: 20, y: 260, s: 150 }]],
    casper: [[0, { x: 420, y: 260, s: 150, a: 0 }], [1, { x: 420, y: 260, s: 150, a: 0 }]],
    focus: [[0, [195, 60]], [1, [195, 400]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["lonely"], casper: ["calm"] },
  },
  invite: {
    boo: [[0, { x: 20, y: 260, s: 150 }], [0.94, { x: 20, y: 260, s: 150 }], [1, { x: 10, y: 330, s: 120 }]],
    casper: [
      [0, { x: 420, y: 260, s: 150, a: 0 }],
      [0.5, { x: 420, y: 260, s: 150, a: 0 }],
      [0.6, { x: 220, y: 260, s: 150, a: 1 }],
      [0.94, { x: 220, y: 260, s: 150, a: 1 }],
      [1, { x: 260, y: 330, s: 120, a: 1 }],
    ],
    focus: [[0, [130, 200]], [0.36, [195, 140]], [0.62, [290, 330]], [0.7, [195, 450]], [1, [195, 450]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["curious", "happy", "happy"], casper: ["calm", "surprised", "happy"] },
  },
  dht: {
    boo: [[0, { x: 10, y: 330, s: 120 }], [0.7, { x: 10, y: 330, s: 120 }], [0.715, { x: 10, y: 312, s: 120 }], [0.73, { x: 10, y: 330, s: 120 }], [0.94, { x: 10, y: 330, s: 120 }], [1, { x: 10, y: 80, s: 110 }]],
    casper: [
      [0, { x: 260, y: 330, s: 120, a: 0.35 }],
      [0.5, { x: 260, y: 330, s: 120, a: 0.35 }],
      [0.56, { x: 260, y: 330, s: 120, a: 1 }],
      [0.94, { x: 260, y: 330, s: 120, a: 1 }],
      [1, { x: 270, y: 80, s: 110, a: 1 }],
    ],
    focus: [[0, [195, 230]], [0.5, [140, 180]], [0.62, [195, 230]], [0.72, [70, 400]], [0.78, [340, 90]], [1, [340, 90]]],
    camera: [[0, 1], [0.5, 1], [0.6, 1.06], [0.72, 1.06], [0.8, 1], [1, 1]],
    moods: { boo: ["curious", "talk", "happy", "calm"], casper: ["calm", "calm", "excited", "calm"] },
  },
  agree: {
    boo: [[0, { x: 10, y: 80, s: 110 }], [0.94, { x: 10, y: 80, s: 110 }], [1, { x: 0, y: 190, s: 130 }]],
    casper: [[0, { x: 270, y: 80, s: 110 }], [0.94, { x: 270, y: 80, s: 110 }], [1, { x: 260, y: 190, s: 130 }]],
    focus: [[0, [80, 300]], [0.34, [195, 300]], [0.68, [195, 330]], [1, [195, 330]]],
    camera: [[0, 1], [1, 1]],
    moods: { boo: ["calm", "wink", "happy"], casper: ["calm", "calm", "happy"] },
  },
  alive: {
    boo: [[0, { x: 0, y: 190, s: 130 }], [0.36, { x: 0, y: 190, s: 130 }], [0.5, { x: 20, y: 190, s: 130 }], [1, { x: 20, y: 190, s: 130 }]],
    casper: [[0, { x: 260, y: 190, s: 130 }], [0.36, { x: 260, y: 190, s: 130 }], [0.5, { x: 240, y: 190, s: 130 }], [1, { x: 240, y: 190, s: 130 }]],
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
  agree: "#0b0e14",
  alive: "#030507",
  open: "#0b0716",
};

export const STAGE = {
  landscape: { w: 1440, h: 900 },
  portrait: { w: 390, h: 844 },
} as const;

/** The pose at a sub-progress, linearly interpolated between keys. */
export function poseAt(keys: Key<Pose>[], t: number): Required<Pose> {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
  const [a, pa] = keys[i];
  const [b, pb] = keys[Math.min(i + 1, keys.length - 1)];
  const k = b === a ? 0 : Math.max(0, Math.min(1, (t - a) / (b - a)));
  const mix = (u: number, v: number) => u + (v - u) * k;
  return { x: mix(pa.x, pb.x), y: mix(pa.y, pb.y), s: mix(pa.s, pb.s), a: mix(pa.a ?? 1, pb.a ?? 1) };
}

export function valueAt<T extends number | [number, number]>(keys: Key<T>[], t: number): T {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
  const [a, va] = keys[i];
  const [b, vb] = keys[Math.min(i + 1, keys.length - 1)];
  const k = b === a ? 0 : Math.max(0, Math.min(1, (t - a) / (b - a)));
  if (typeof va === "number") return (va + ((vb as number) - va) * k) as T;
  const [x1, y1] = va as [number, number];
  const [x2, y2] = vb as [number, number];
  return [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k] as T;
}
