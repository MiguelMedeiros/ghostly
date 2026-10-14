"use client";

import { useEffect } from "react";

/**
 * Idle loops rest while they are off screen, page-wide: the ghosts' hem morph
 * (SMIL, which CSS cannot pause), their bob and blink, the network twinkles,
 * the rising particles and the footer's sleeping ghost. One observer watches
 * every outermost ghost, every stage, every particle field and the sleeper;
 * what is not on screen gets `data-offscreen` (CSS pauses its animations) and,
 * for an svg, its SMIL timeline paused, with those of the svgs inside it: a
 * ghost drawn in a stage has a clock of its own, which the stage's pause does
 * not stop (the home film's 11 kept the page laying out 60 times a second at
 * every scroll position). New
 * elements (the deck mounts late, the boo comes and goes) are picked up by a
 * mutation observer. Nothing here changes what is drawn; it only stops the
 * clock on things nobody can see.
 */
const LOOPS = "svg.ghost:not(svg svg), svg.stage, .particles, .footer-sleeper";

/** Pauses or resumes an svg's SMIL clock and those of the svgs inside it. */
function smil(svg: SVGSVGElement, run: boolean) {
  for (const s of [svg, ...svg.querySelectorAll("svg")]) {
    if (run) s.unpauseAnimations();
    else s.pauseAnimations();
  }
}

export function IdleLoops() {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new WeakSet<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target;
          if (e.isIntersecting) {
            el.removeAttribute("data-offscreen");
            if (el instanceof SVGSVGElement) smil(el, true);
          } else {
            el.setAttribute("data-offscreen", "");
            if (el instanceof SVGSVGElement) smil(el, false);
          }
        }
      },
      // A little early, so a loop is running by the time its element is in view.
      { rootMargin: "25% 0px 25% 0px" },
    );
    const scan = () => {
      document.querySelectorAll(LOOPS).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        io.observe(el);
      });
      // A ghost that comes into a stage already off screen rests with it.
      document.querySelectorAll<SVGSVGElement>("svg[data-offscreen] svg").forEach((s) => {
        if (!s.animationsPaused()) s.pauseAnimations();
      });
    };
    scan();
    let queued = 0;
    const mo = new MutationObserver(() => {
      if (!queued) queued = requestAnimationFrame(() => {
        queued = 0;
        scan();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
  }, []);
  return null;
}
