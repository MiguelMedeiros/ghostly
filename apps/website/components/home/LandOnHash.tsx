"use client";

import { useEffect } from "react";

/** How long after the page starts a change of height still sends it back to the section. */
const SETTLE_MS = 4000;

const TOUCHED = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * A link to a section (ghostly.tools/#download) lands on that section. The
 * browser goes to it while the page is still the server's markup, and the
 * story chapters take their shape for this window after that (stage.tsx: the
 * server assumes a wide window with a mouse), so on a phone everything below
 * a chapter moves down and the page stopped short of the section. While the
 * page settles, each change of its height sends it to the section again; it
 * stops the moment the reader scrolls, taps or types. A reload or a step back
 * keeps the place the browser restores.
 */
export function LandOnHash() {
  useEffect(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.type !== "navigate") return;
    let id = window.location.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {}
    if (!id || !document.getElementById(id)) return;

    // Looked up each time: a chapter that takes another shape is a new element with the same id.
    const land = () => document.getElementById(id)?.scrollIntoView({ block: "start" });
    const ro = new ResizeObserver(land);
    // A block that rises into place as it shows (Reveal) was measured before it rose: land again once it has.
    const risen = (e: TransitionEvent) => {
      const el = document.getElementById(id);
      if (el && e.target instanceof Node && e.target.contains(el)) land();
    };
    const stop = () => {
      ro.disconnect();
      window.clearTimeout(timer);
      document.removeEventListener("transitionend", risen);
      for (const type of TOUCHED) window.removeEventListener(type, stop);
      window.removeEventListener("hashchange", stop);
    };
    const timer = window.setTimeout(stop, SETTLE_MS);
    for (const type of TOUCHED) window.addEventListener(type, stop, { passive: true });
    window.addEventListener("hashchange", stop);
    document.addEventListener("transitionend", risen);
    ro.observe(document.body);
    return stop;
  }, []);
  return null;
}
