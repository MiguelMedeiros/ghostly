"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { GhostMark } from "@/components/ghost/Ghost";
import { DUR } from "@/lib/motion";
import "@/app/swarm.css";

/**
 * The swarm: a flock of small ghosts crosses the screen, covers it while the
 * page changes underneath, then flies off. It plays when you go to another
 * page, and when you jump far on the same page (a mark on the story rail, the
 * logo on the homepage), so the reader lands where they asked instead of
 * watching every scene rewind. Plain scrolling is never taken over. With
 * reduced motion the change simply happens.
 */

type Job = { run: () => void; waitFor?: "navigation" };
const EVENT = "ghostly:swarm";

/** Cover the screen, run `run` behind the ghosts, uncover. */
export function swarm(run: () => void) {
  window.dispatchEvent(new CustomEvent<Job>(EVENT, { detail: { run } }));
}

/** Jump to an element: a swarm when it is far, a smooth scroll when it is near. */
export function jumpTo(target: HTMLElement | number) {
  const top = typeof target === "number" ? target : target.getBoundingClientRect().top + window.scrollY + 1;
  if (Math.abs(top - window.scrollY) < window.innerHeight * 1.5) {
    window.scrollTo({ top, behavior: "smooth" });
    return;
  }
  swarm(() => window.scrollTo({ top, behavior: "instant" }));
}

// A fixed flock: position, size, colour and delay, generated once (rounded for hydration).
const FLOCK = (() => {
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const colors = ["#22d3ee", "#4ade80", "#a78bfa", "#22d3ee", "#60a5fa"];
  const out: { x: number; y: number; size: number; color: string; delay: number; tilt: number }[] = [];
  const cols = 6;
  const rows = 5;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const x = ((col + 0.5 + (r() - 0.5) * 0.7) / cols) * 100;
      const y = ((row + 0.5 + (r() - 0.5) * 0.7) / rows) * 100;
      out.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        size: Math.round(56 + r() * 70),
        color: colors[Math.floor(r() * colors.length)],
        // Left columns first, a little noise: the flock sweeps across.
        delay: Math.round((col / cols) * 170 + r() * 90),
        tilt: Math.round((r() - 0.5) * 24),
      });
    }
  return out;
})();

// The flock's in and out, in ms: DUR.slow (swarm.css uses the same token), plus the last ghost's delay.
const IN = Math.round(DUR.slow * 1000);
const OUT = Math.round(DUR.slow * 1000);

export function GhostSwarm() {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<"idle" | "in" | "hold" | "out">("idle");
  const busy = useRef(false);
  const waiting = useRef<string | null>(null);
  const release = useRef<(() => void) | null>(null);

  const reduce = () => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };

  const play = useCallback(async (job: Job) => {
    if (busy.current) return;
    if (reduce()) {
      job.run();
      return;
    }
    busy.current = true;
    setPhase("in");
    await new Promise((r) => setTimeout(r, IN + 260));
    setPhase("hold");
    if (job.waitFor === "navigation") {
      // Uncover once the new page has rendered (the pathname changes), or after a second at most.
      await new Promise<void>((resolve) => {
        release.current = resolve;
        job.run();
        setTimeout(resolve, 1200);
      });
      release.current = null;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    } else {
      job.run();
      await new Promise((r) => setTimeout(r, 120));
    }
    setPhase("out");
    await new Promise((r) => setTimeout(r, OUT + 260));
    setPhase("idle");
    busy.current = false;
  }, []);

  // The page has changed under the ghosts: let them go.
  useEffect(() => {
    if (waiting.current && waiting.current !== pathname) {
      waiting.current = null;
      release.current?.();
    }
  }, [pathname]);

  useEffect(() => {
    const onSwarm = (e: Event) => play((e as CustomEvent<Job>).detail);
    // Internal links: cover, navigate, uncover when the new page is there.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.dataset.noSwarm !== undefined) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const samePath = url.pathname === window.location.pathname;
      if (samePath && url.hash) return; // in-page anchors scroll as usual
      e.preventDefault();
      if (samePath) {
        // The logo on the page you are on: back to the top, without rewinding every scene.
        jumpTo(0);
        return;
      }
      waiting.current = window.location.pathname;
      play({ run: () => router.push(url.pathname + url.search + url.hash), waitFor: "navigation" });
    };
    window.addEventListener(EVENT, onSwarm);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener(EVENT, onSwarm);
      document.removeEventListener("click", onClick, true);
    };
  }, [play, router]);

  if (phase === "idle") return null;
  return (
    <div className="swarm" data-phase={phase} aria-hidden="true">
      <div className="swarm-veil" />
      {FLOCK.map((g, i) => (
        <span
          key={i}
          className="swarm-ghost"
          style={
            {
              left: `${g.x}%`,
              top: `${g.y}%`,
              width: g.size,
              height: g.size,
              color: g.color,
              "--d": `${g.delay}ms`,
              "--t": `${g.tilt}deg`,
            } as React.CSSProperties
          }
        >
          <GhostMark />
        </span>
      ))}
    </div>
  );
}
