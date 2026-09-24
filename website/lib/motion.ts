"use client";

import { useEffect } from "react";
import { useSpring, type MotionValue } from "motion/react";

/**
 * Motion tokens: every animation on the site takes its curve, duration and
 * spring from here (CSS mirrors them as --ease-*, --dur-* in app/site.css).
 * The rules that go with them are in website/MOTION.md.
 */

/** Cubic-bézier curves, as motion `ease` arrays. */
export const EASE = {
  /** Things arriving or settling: fast start, long soft landing. The site's default. */
  out: [0.22, 1, 0.36, 1],
  /** Things travelling from one place to another on their own (loops, demos). */
  inOut: [0.65, 0, 0.35, 1],
  /** Things leaving: a quiet start, gone quickly. */
  in: [0.55, 0, 1, 0.45],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Durations in seconds. Nothing on the site animates for longer than `beat` unless it is scrubbed by scroll or loops. */
export const DUR = {
  /** Hover and press feedback. */
  xs: 0.18,
  /** Small UI changes: a chip, a caption swap. */
  sm: 0.32,
  /** A panel or a card entering. */
  md: 0.6,
  /** A large element or a whole scene fading in. */
  lg: 0.9,
  /** One story beat played in full (cards mode, loops). */
  beat: 1.8,
} as const;

/** Stagger between siblings entering in sequence (words, chips, rows). */
export const STAGGER = 0.07;

/**
 * Springs. `scrub` smooths anything driven by scroll so a wheel tick or a
 * trackpad flick becomes a glide, without taking the scroll away from the
 * reader (no scroll-jacking); it settles in about 0.35 s. `actor` gives the
 * ghosts weight; `ui` is for small interface elements.
 */
export const SPRING = {
  scrub: { stiffness: 170, damping: 34, mass: 0.55, restDelta: 0.0005 },
  actor: { stiffness: 120, damping: 26, mass: 0.8 },
  ui: { stiffness: 380, damping: 32, mass: 0.6 },
} as const;

/**
 * Scroll progress, smoothed. Follows `source` through the `scrub` spring so
 * scroll-driven scenes glide instead of stepping with each wheel tick; a jump
 * larger than a quarter of the range (an anchor link, a reload mid-page) is
 * taken at once rather than swept through.
 */
export function useScrub(source: MotionValue<number>): MotionValue<number> {
  const smooth = useSpring(source.get(), SPRING.scrub);
  useEffect(() => {
    smooth.jump(source.get());
    return source.on("change", (v) => {
      if (Math.abs(v - smooth.get()) > 0.25) smooth.jump(v);
      else smooth.set(v);
    });
  }, [source, smooth]);
  return smooth;
}
