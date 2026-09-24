"use client";

import { useEffect, useRef, useState } from "react";
import { jumpTo } from "@/components/site/GhostSwarm";
import "@/app/rail.css";

export type RailMark = { id: string; label: string };

// Marks closer than this (px) would share one hit area; they are nudged apart.
const MIN_GAP = 26;
// How long the rail stays lit after the last scroll event.
const SETTLE_MS = 1200;

/**
 * Where you are in the story: a quiet rail docked at the bottom of the screen
 * that fills as you scroll, with one mark per chapter (a button that jumps
 * there) and the name of the chapter you are in. Marks sit where their chapter
 * starts, so the rail also says how long the story is. It rests dim, lights up
 * while you scroll or point at it, and steps aside when the footer arrives.
 * On phones only the progress line is drawn (see rail.css).
 */
export function StoryRail({ marks, label }: { marks: RailMark[]; label: string }) {
  const [at, setAt] = useState<number[]>([]);
  const [shownAt, setShownAt] = useState<number[]>([]);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState(0);
  const [started, setStarted] = useState(false);
  const [docked, setDocked] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [pointed, setPointed] = useState<number | null>(null);
  const tops = useRef<number[]>([]);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const calm = () => document.documentElement.classList.contains("calm");
    const measure = () => {
      const travel = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      tops.current = marks.map((m) => {
        const el = document.getElementById(m.id);
        return el ? el.getBoundingClientRect().top + window.scrollY : 0;
      });
      const raw = tops.current.map((t) => Math.min(1, t / travel));
      setAt(raw);
      setShownAt(spread(raw, MIN_GAP / Math.max(1, track.current?.clientWidth ?? 0)));
      update();
    };
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const travel = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      setProgress(Math.min(1, y / travel));
      // The chapter whose start has passed the upper third of the screen.
      const probe = y + window.innerHeight * 0.35;
      let i = 0;
      tops.current.forEach((t, k) => {
        if (t <= probe) i = k;
      });
      setCurrent(i);
      setStarted(y > 80);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
      if (calm()) return;
      setScrolling(true);
      clearTimeout(settle);
      settle = setTimeout(() => setScrolling(false), SETTLE_MS);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    // Step aside a little before the footer (and the ghost sleeping in it) shows up.
    const footer = document.querySelector("body footer");
    const io = footer
      ? new IntersectionObserver(([e]) => setDocked(e.isIntersecting), { rootMargin: "0px 0px 120px 0px" })
      : null;
    if (footer) io?.observe(footer);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      io?.disconnect();
      clearTimeout(settle);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [marks]);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (el) jumpTo(el);
  };

  const place = shownAt.length === marks.length ? shownAt : at;
  const named = pointed ?? current;

  return (
    <nav
      className="rail"
      aria-label={label}
      data-on={started && !docked}
      data-lit={scrolling || pointed !== null}
      onPointerLeave={() => setPointed(null)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPointed(null);
      }}
    >
      <div className="rail-inner">
        <div className="rail-track" ref={track}>
          <div className="rail-fill" style={{ transform: `scaleX(${remap(progress, at, place)})` }} />
          {marks.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className="rail-mark"
              style={{ left: `${(place[i] ?? 0) * 100}%` }}
              data-past={i <= current}
              aria-current={i === current ? "true" : undefined}
              aria-label={m.label}
              onPointerEnter={() => setPointed(i)}
              onFocus={(e) => {
                // A click focuses too; only keyboard focus should keep the rail lit.
                if (e.currentTarget.matches(":focus-visible")) setPointed(i);
              }}
              onClick={() => jump(m.id)}
            />
          ))}
        </div>
        {/* The buttons carry the names (and aria-current); this is their echo for the eye. */}
        <span className="rail-label mono" aria-hidden="true">
          {marks[named]?.label}
        </span>
      </div>
    </nav>
  );
}

/** Keeps sorted positions in [0, 1] at least `gap` apart, moving them as little as possible. */
function spread(p: number[], gap: number) {
  if (!Number.isFinite(gap) || gap <= 0 || gap * (p.length - 1) > 1) return p;
  const out = [...p];
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  for (let i = out.length - 1; i >= 0; i--) out[i] = Math.max(0, Math.min(out[i], i === out.length - 1 ? 1 : out[i + 1] - gap));
  return out;
}

/** Maps scroll progress onto the nudged marks so the fill reaches each mark with its chapter. */
function remap(x: number, from: number[], to: number[]) {
  if (from.length < 2 || from.length !== to.length) return x;
  const xs = [0, ...from, 1];
  const ys = [0, ...to, 1];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const span = xs[i] - xs[i - 1];
      return span > 0 ? ys[i - 1] + ((x - xs[i - 1]) / span) * (ys[i] - ys[i - 1]) : ys[i];
    }
  }
  return 1;
}
