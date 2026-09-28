"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Ghost } from "@/components/ghost/Ghost";
import "@/app/boo.css";

/**
 * The boo: one ghost pops up in the middle of the screen, says "boo!", and
 * floats away, while a soft veil hides the page changing underneath. It plays
 * when you go to another page, and when you jump far on the same page (a mark
 * on the story rail, the logo on the homepage), so the reader lands where they
 * asked instead of watching every scene rewind. Plain scrolling is never taken
 * over. With reduced motion the change simply happens.
 */

type Job = { run: () => void; waitFor?: "navigation" };
const EVENT = "ghostly:boo";

/** Cover the screen with a boo, run `run` behind it, uncover. */
export function boo(run: () => void) {
  window.dispatchEvent(new CustomEvent<Job>(EVENT, { detail: { run } }));
}

/** Jump to an element: a boo when it is far, a smooth scroll when it is near. */
export function jumpTo(target: HTMLElement | number) {
  const top = typeof target === "number" ? target : target.getBoundingClientRect().top + window.scrollY + 1;
  if (Math.abs(top - window.scrollY) < window.innerHeight * 1.5) {
    window.scrollTo({ top, behavior: "smooth" });
    return;
  }
  boo(() => window.scrollTo({ top, behavior: "instant" }));
}

// The beats, in ms. boo.css reads the same numbers (set as --boo-* on the overlay), so JS and CSS never drift.
/** The veil comes up; the change runs once it is fully up. */
const VEIL = 180;
/** The ghost rises from below and lands in the middle (the hop overshoots a little). */
const POP = 300;
/** "boo!" and the puff start here, and take this long. */
const SAY_AT = 150;
const SAY = 240;
/** The ghost stays this long after the change before leaving (from the start). */
const LEAVE_AT = 440;
/** Up and away, and the veil goes. */
const OUT = 280;

const vars = {
  "--boo-veil": `${VEIL}ms`,
  "--boo-pop": `${POP}ms`,
  "--boo-say-at": `${SAY_AT}ms`,
  "--boo-say": `${SAY}ms`,
  "--boo-out": `${OUT}ms`,
} as React.CSSProperties;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

export function BooTransition() {
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
    // Reduced motion, or a boo already on screen: the change simply happens (never a second ghost, never a lost click).
    if (reduce() || busy.current) {
      job.run();
      return;
    }
    busy.current = true;
    const t0 = performance.now();
    setPhase("in");
    await wait(VEIL);
    await frames();
    if (job.waitFor === "navigation") {
      // The ghost hovers until the new page has rendered (the pathname changes), or a second at most.
      setPhase("hold");
      await new Promise<void>((resolve) => {
        release.current = resolve;
        job.run();
        setTimeout(resolve, 1000);
      });
      release.current = null;
      await frames();
    } else {
      job.run();
    }
    await wait(Math.max(0, LEAVE_AT - (performance.now() - t0)));
    setPhase("out");
    await wait(OUT);
    setPhase("idle");
    busy.current = false;
  }, []);

  // The page has changed under the veil: let the ghost go.
  useEffect(() => {
    if (waiting.current && waiting.current !== pathname) {
      waiting.current = null;
      release.current?.();
    }
  }, [pathname]);

  useEffect(() => {
    const onBoo = (e: Event) => play((e as CustomEvent<Job>).detail);
    // Internal links: cover, navigate, uncover when the new page is there.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.dataset.noBoo !== undefined) return;
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
    window.addEventListener(EVENT, onBoo);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener(EVENT, onBoo);
      document.removeEventListener("click", onClick, true);
    };
  }, [play, router]);

  if (phase === "idle") return null;
  return (
    <div className="boo" data-phase={phase} style={vars} aria-hidden="true">
      <div className="boo-veil" />
      <div className="boo-ghost">
        <div className="boo-bob">
          <div className="boo-body">
            <Ghost who="boo" mood="excited" size="100%" float={false} />
          </div>
          <span className="boo-say">boo!</span>
        </div>
      </div>
    </div>
  );
}
