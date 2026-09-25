"use client";

import { useEffect } from "react";

/**
 * Idle loops rest while they are off screen, page-wide: the ghosts' hem morph
 * (SMIL, which CSS cannot pause), their bob and blink, the network twinkles and
 * the rising particles. One observer watches every outermost ghost, every
 * stage and every particle field; what is not on screen gets `data-offscreen`
 * (CSS pauses its animations) and, for an svg, its SMIL timeline paused. New
 * elements (the deck mounts late, the swarm comes and goes) are picked up by a
 * mutation observer. Nothing here changes what is drawn; it only stops the
 * clock on things nobody can see.
 */
const LOOPS = "svg.ghost:not(svg svg), svg.stage, .particles";

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
            if (el instanceof SVGSVGElement) el.unpauseAnimations();
          } else {
            el.setAttribute("data-offscreen", "");
            if (el instanceof SVGSVGElement) el.pauseAnimations();
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
