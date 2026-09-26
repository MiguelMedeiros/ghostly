// Motion as pure functions of the film's time: every frame is drawn from `t` alone, so any frame renders the same
// whichever worker draws it and in whatever order.
import { BEAT } from "../timeline.js";

export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

export const ease = {
  linear: (p: number) => p,
  outCubic: (p: number) => 1 - (1 - p) ** 3,
  inCubic: (p: number) => p ** 3,
  inOutCubic: (p: number) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  outExpo: (p: number) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  inExpo: (p: number) => (p <= 0 ? 0 : 2 ** (10 * p - 10)),
  outBack: (p: number, s = 1.9) => 1 + (s + 1) * (p - 1) ** 3 + s * (p - 1) ** 2,
  /** A damped spring settling on 1: the overshoot of a pop. */
  spring: (p: number, bounces = 2.2) => (p >= 1 ? 1 : 1 - Math.cos(p * Math.PI * bounces) * Math.exp(-5 * p)),
};

/** Progress 0→1 of a motion that starts at `start` and lasts `dur` seconds. */
export const prog = (t: number, start: number, dur: number) => clamp((t - start) / dur);
/** A value moving from `a` to `b` over [start, start + dur], eased. */
export const tween = (t: number, start: number, dur: number, a: number, b: number, e: (p: number) => number = ease.outCubic) => lerp(a, b, e(prog(t, start, dur)));
/** Between `from` (inclusive) and `to` (exclusive). */
export const within = (t: number, from: number, to: number) => t >= from && t < to;
/** A kick's pulse: 1 on each beat from `from`, decaying to 0 before the next. */
export const pulse = (t: number, from: number, every = BEAT, decay = 7) => {
  if (t < from) return 0;
  const since = (t - from) % every;
  return Math.exp(-decay * since / every * 1.2);
};
/** In, hold, out: 0→1 over `inDur` from `a`, 1 until `b`, then 1→0 over `outDur`. */
export const life = (t: number, a: number, b: number, inDur = 0.18, outDur = 0.14, e = ease.outCubic) =>
  t < b ? e(prog(t, a, inDur)) : 1 - ease.inCubic(prog(t, b, outDur));
