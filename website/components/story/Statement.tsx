"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { useCalm } from "@/lib/useCalm";

/**
 * A second of silence between the acts: one sentence gets the whole screen,
 * revealed word by word as it scrolls into place. It repeats a verified line
 * from the story, so it is hidden from readers who already have the copy.
 */
export function Statement({ before, accent, after }: { before: string; accent: string; after: string }) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const fade = useTransform(scrollYProgress, [0.78, 0.95], [1, 0]);
  const words = [
    ...before.trim().split(/\s+/).map((w) => ({ w, accent: false })),
    ...accent.trim().split(/\s+/).map((w) => ({ w, accent: true })),
    ...after.trim().split(/\s+/).map((w) => ({ w, accent: false })),
  ];

  return (
    <section ref={ref} className="statement" aria-hidden="true" data-static={calm}>
      <div className="statement-sticky">
        <motion.p className="wrap statement-text" style={calm ? { opacity: 1 } : { opacity: fade }}>
          {words.map((item, i) => (
            <Word key={i} p={scrollYProgress} i={i} n={words.length} accent={item.accent} calm={calm}>
              {item.w}
            </Word>
          ))}
        </motion.p>
      </div>
    </section>
  );
}

function Word({ p, i, n, accent, calm, children }: { p: ReturnType<typeof useScroll>["scrollYProgress"]; i: number; n: number; accent: boolean; calm: boolean; children: string }) {
  // Each word gets its own slice of the .15–.55 window, in order.
  const start = 0.15 + (0.4 * i) / n;
  const end = start + 0.4 / n + 0.08;
  const clip = useTransform(p, [start, end], ["inset(0 0 100% 0)", "inset(0 0 0% 0)"]);
  const y = useTransform(p, [start, end], ["0.35em", "0em"]);
  return (
    <>
      <span className="statement-word">
        <motion.span className={accent ? "accent" : undefined} style={calm ? { clipPath: "inset(0 0 0% 0)", y: 0 } : { clipPath: clip, y }}>
          {children}
        </motion.span>
      </span>{" "}
    </>
  );
}
