"use client";

import { useEffect, useRef, useState } from "react";
import { jumpTo } from "@/components/site/GhostSwarm";
import "@/app/rail.css";

export type RailMark = { id: string; label: string };

/**
 * Where you are in the story: a thin rail under the nav that fills as you
 * scroll, with one mark per chapter (a button that jumps there) and the name
 * of the chapter you are in. Marks sit where their chapter starts, so the rail
 * also says how long the story is.
 */
export function StoryRail({ marks, label }: { marks: RailMark[]; label: string }) {
  const [at, setAt] = useState<number[]>([]);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState(0);
  const [shown, setShown] = useState(false);
  const tops = useRef<number[]>([]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const travel = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      tops.current = marks.map((m) => {
        const el = document.getElementById(m.id);
        return el ? el.getBoundingClientRect().top + window.scrollY : 0;
      });
      setAt(tops.current.map((t) => Math.min(1, t / travel)));
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
      setShown(y > 80);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [marks]);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (el) jumpTo(el);
  };

  return (
    <nav className="rail" aria-label={label} data-on={shown}>
      <div className="rail-inner">
        <div className="rail-track">
          <div className="rail-fill" style={{ transform: `scaleX(${progress})` }} />
          {marks.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className="rail-mark"
              style={{ left: `${(at[i] ?? 0) * 100}%` }}
              data-past={i <= current}
              aria-current={i === current ? "true" : undefined}
              aria-label={m.label}
              title={m.label}
              onClick={() => jump(m.id)}
            />
          ))}
        </div>
        <span className="rail-label mono" aria-live="polite">
          {marks[current]?.label}
        </span>
      </div>
    </nav>
  );
}
