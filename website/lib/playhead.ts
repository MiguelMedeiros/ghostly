"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motionValue, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { SCRUB } from "./motion";

/**
 * The story's playhead: one smoothed scroll position that every scroll-driven
 * scene on the page draws from, so the chapters' pictures, the actors and the
 * copy stay in step with each other.
 *
 * The scroll itself is never touched (no scroll-jacking, no snapping). What
 * the playhead adds on top of it:
 * - It follows the scroll through a critically damped glide (`SCRUB.follow`),
 *   so a wheel tick is a glide, not a step.
 * - Inside a beat (a window a scene registers with `useBeats`) it moves no
 *   faster than `SCRUB.pace`, so a flick that crosses beats still plays each
 *   one; the whole catch-up is capped at `SCRUB.catchUp`.
 *   Beats only count while their scene is actually on screen (the scroll is
 *   inside its pinned range): a scene that has scrolled away is not replayed.
 * - When the scroll stops inside a beat, the beat finishes (scrolling down) or
 *   goes back to its start (scrolling up), so a stop never shows a half-drawn
 *   picture. Carrying on in the same direction, the picture holds until the
 *   scroll passes it; turning back reverses it at once.
 * - A scroll that moves more than `SCRUB.jump` viewports at once (a link, the
 *   rail, the swarm, a reload mid-page) is taken at once: nothing rewinds.
 */
/**
 * A beat, in page pixels: `from`/`to` where it runs, `seen` the scroll range in which its scene is pinned on
 * screen. `stop: false` keeps its pace but lets a stop rest inside it (for a scene that is not pinned, whose copy
 * scrolls away on its own, like the hero).
 */
export type Beat = { from: number; to: number; seen: [number, number]; stop?: boolean };

class Playhead {
  readonly y: MotionValue<number>;
  /** Bumped when the layout may have moved: progress hooks measure again. */
  readonly layout: MotionValue<number>;
  private beats = new Map<string, Beat[]>();
  private raw = 0;
  private dir = 1;
  private goal = 0;
  private vel = 0;
  private held: number | null = null;
  private heldDir = 0;
  private frame = 0;
  private last = 0;
  private restTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.raw = window.scrollY;
    this.goal = this.raw;
    this.y = motionValue(this.raw);
    this.layout = motionValue(0);
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("scrollend", this.onRest);
    window.addEventListener("resize", this.onLayout);
    new ResizeObserver(this.onLayout).observe(document.body);
  }

  register(key: string, beats: Beat[] | null) {
    if (beats?.length) this.beats.set(key, beats);
    else this.beats.delete(key);
  }

  private onLayout = () => {
    this.layout.set(this.layout.get() + 1);
    // The page may have changed length under the scroll: follow the scroll where it now is.
    this.onScroll();
  };

  private onScroll = () => {
    const v = window.scrollY;
    const moved = v - this.raw;
    if (moved) this.dir = Math.sign(moved);
    this.raw = v;
    if (Math.abs(moved) > SCRUB.jump * window.innerHeight) {
      this.held = null;
      this.goal = v;
      this.vel = 0;
      this.y.set(v);
      return;
    }
    // A finished (or rewound) beat holds while the scroll carries on its way toward it.
    if (this.held !== null && this.dir === this.heldDir && (this.dir > 0 ? v < this.held : v > this.held)) this.goal = this.held;
    else {
      this.held = null;
      this.goal = v;
    }
    clearTimeout(this.restTimer);
    this.restTimer = setTimeout(this.onRest, SCRUB.rest);
    this.kick();
  };

  /** The scroll stopped: a beat it stopped inside finishes, or goes back to its start. */
  private onRest = () => {
    clearTimeout(this.restTimer);
    const v = this.raw;
    const beat = this.all().find((b) => b.stop !== false && b.from < v && v < b.to);
    if (!beat) return;
    this.held = this.dir > 0 ? beat.to : beat.from;
    this.heldDir = this.dir;
    this.goal = this.held;
    this.kick();
  };

  private all(): Beat[] {
    return [...this.beats.values()].flat();
  }

  /** Beats on screen now (the scroll is in their scene's pinned range, or has not gone far past it). */
  private live(): Beat[] {
    const v = this.raw;
    const slack = SCRUB.seen * window.innerHeight;
    return this.all().filter((b) => v >= b.seen[0] - slack && v <= b.seen[1] + slack);
  }

  /**
   * How fast the playhead may move at `at` toward the goal, in px/s: inside a beat, the beat's pace; before one,
   * no faster than braking at `SCRUB.decel` allows over the distance left to it. Continuous along the way, so the
   * playhead eases into a beat instead of braking in it.
   */
  private allowed(at: number, live: Beat[]): number {
    const dir = Math.sign(this.goal - at);
    const lo = Math.min(at, this.goal);
    const hi = Math.max(at, this.goal);
    const ahead = live.filter((b) => b.to > lo && b.from < hi);
    if (!ahead.length) return Infinity;
    // The time the beats between here and the goal take at the pace; above the cap, they all go faster.
    const vh = window.innerHeight;
    let inBeats = 0;
    for (const b of ahead) inBeats += Math.min(hi, b.to) - Math.max(lo, b.from);
    const pace = SCRUB.pace * vh * Math.max(1, inBeats / (SCRUB.pace * vh) / SCRUB.catchUp);
    const decel = SCRUB.decel * vh;
    const d = Math.min(...ahead.map((b) => Math.max(0, dir > 0 ? b.from - at : at - b.to)));
    return Math.sqrt(pace * pace + 2 * decel * d);
  }

  private kick() {
    if (this.frame) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    const dt = Math.min(1 / 30, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    let y = this.y.get();
    const gap = this.goal - y;
    if (Math.abs(gap) < 0.5 && Math.abs(this.vel) < 8) {
      this.vel = 0;
      this.y.set(this.goal);
      this.frame = 0;
      return;
    }
    // A critically damped follow toward the goal, no faster than the beats on the way allow.
    const w = 2 / SCRUB.follow;
    this.vel += (w * w * gap - 2 * w * this.vel) * dt;
    const max = this.allowed(y, this.live());
    if (Math.abs(this.vel) > max) this.vel = Math.sign(this.vel) * max;
    y += this.vel * dt;
    // Never past the goal.
    if ((gap > 0 && y > this.goal) || (gap < 0 && y < this.goal)) {
      y = this.goal;
      this.vel = 0;
    }
    this.y.set(y);
    this.frame = requestAnimationFrame(this.tick);
  };
}

let shared: Playhead | null = null;
function playhead(): Playhead {
  shared ??= new Playhead();
  return shared;
}

/** Where a scroll progress starts and ends for an element, like motion's `useScroll` offsets. */
export type Offset = "pinned" | "leaving" | "crossing";

function span(el: HTMLElement, offset: Offset): [number, number] {
  const top = el.getBoundingClientRect().top + window.scrollY;
  const h = el.offsetHeight;
  const vh = window.innerHeight;
  // pinned: ["start start", "end end"]; leaving: ["start start", "end start"]; crossing: ["start end", "end start"].
  if (offset === "pinned") return [top, top + Math.max(1, h - vh)];
  if (offset === "leaving") return [top, top + h];
  return [top - vh, top + h];
}

/**
 * An element's scroll progress (0…1), read from the playhead instead of the
 * raw scroll. `offset`: "pinned" runs while the element holds the screen
 * (start at the top, end when its bottom reaches the bottom), "leaving" while
 * it scrolls off the top, "crossing" while any of it is on screen.
 */
export function usePlayheadProgress(ref: React.RefObject<HTMLElement | null>, offset: Offset): MotionValue<number> {
  // Unmeasured, every element reads 0 (as on the server), so hydration matches.
  const range = useRef<[number, number]>([Infinity, Infinity]);
  const measured = useMotionValue<number>(0);
  const [y, layout] = usePlayheadValues();
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const next = span(el, offset);
      const [a, b] = range.current;
      if (next[0] === a && next[1] === b) return;
      range.current = next;
      measured.set(measured.get() + 1);
    };
    measure();
    const off = layout.on("change", measure);
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => {
      off();
      ro.disconnect();
    };
  }, [ref, offset, layout, measured]);
  return useTransform([y, measured], ([v]) => {
    const [a, b] = range.current;
    if (!Number.isFinite(a)) return 0;
    return Math.max(0, Math.min(1, ((v as number) - a) / Math.max(1, b - a)));
  });
}

// The server has no scroll: a still value until the client's playhead takes over.
const serverY = motionValue(0);
const serverLayout = motionValue(0);

function usePlayheadValues(): [MotionValue<number>, MotionValue<number>] {
  const [values] = useState<[MotionValue<number>, MotionValue<number>]>(() => (typeof window === "undefined" ? [serverY, serverLayout] : [playhead().y, playhead().layout]));
  return values;
}

/**
 * Register a scene's beats, in page pixels. `measure` is called again when the
 * layout moves; return null while the scene is not playing (cards, stills).
 */
export function useBeats(key: string, measure: () => Beat[] | null, deps: React.DependencyList) {
  const fn = useRef(measure);
  useEffect(() => {
    fn.current = measure;
  });
  useEffect(() => {
    const p = playhead();
    const update = () => p.register(key, fn.current());
    update();
    const off = p.layout.on("change", update);
    return () => {
      off();
      p.register(key, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
}
