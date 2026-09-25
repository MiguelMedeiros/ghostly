"use client";

import { useEffect, useRef } from "react";
import { animate as tween, motion, useInView, useMotionValue, useScroll, useTransform, type MotionValue } from "motion/react";
import { useCalm } from "@/lib/useCalm";
import { useScrub } from "@/lib/motion";
import { useCards } from "@/components/home/stage";
import "@/app/statement.css";

/**
 * A second of silence between the acts: one sentence gets the whole screen.
 * Each word fades in, un-blurs and rises into place as the block scrolls up
 * (p .15 to .5 of the section), the accent word landing last; the sentence then
 * holds and fades as it leaves. It repeats a verified line from the story,
 * so it is hidden from readers who already have the copy.
 */
export function Statement({ before, accent, after }: { before: string; accent: string; after: string }) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const cards = useCards();
  const still = calm || cards;
  const { scrollYProgress: rawProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const scrollYProgress = useScrub(rawProgress);
  // Touch devices: no pin; the sentence reveals once when it is on screen.
  const local = useMotionValue<number>(REVEAL[0]);
  const inView = useInView(ref, { amount: 0.5, once: true });
  useEffect(() => {
    if (!cards || calm || !inView) return;
    const controls = tween(local, REVEAL[1], { duration: 2.2, ease: "linear" });
    return () => controls.stop();
  }, [cards, calm, inView, local]);
  const p = still ? local : scrollYProgress;
  const fade = useTransform(scrollYProgress, (v) => (still ? 1 : 1 - clamp01((v - FADE[0]) / (FADE[1] - FADE[0]))));
  const words = [
    ...before.trim().split(/\s+/).map((w) => ({ w, accent: false })),
    ...accent.trim().split(/\s+/).map((w) => ({ w, accent: true })),
    ...after.trim().split(/\s+/).map((w) => ({ w, accent: false })),
  ].filter((item) => item.w.length > 0);
  const slots = schedule(words);

  return (
    <section ref={ref} className="statement" aria-hidden="true" data-static={still}>
      <div className="statement-sticky">
        <motion.p className="wrap statement-text" style={calm ? undefined : { opacity: fade }}>
          {words.map((item, i) => (
            <Word key={i} p={p} start={slots[i].start} end={slots[i].end} accent={item.accent} calm={calm}>
              {item.w}
            </Word>
          ))}
        </motion.p>
      </div>
    </section>
  );
}

/** The plain words stagger in reading order; the accent word(s) land last, with a longer beat. */
const REVEAL = [0.15, 0.5] as const;
const PLAIN_LAST_START = 0.33;
const PLAIN_DURATION = 0.07;
const ACCENT_START = 0.4;
const ACCENT_STAGGER = 0.02;
// The pin releases at p .63 (170vh section); the sentence is gone before its top reaches the nav.
const FADE = [0.64, 0.75] as const;

function schedule(words: { accent: boolean }[]): { start: number; end: number }[] {
  const plain = words.filter((w) => !w.accent).length;
  const accents = words.length - plain;
  if (words[0]?.accent) {
    // The accent opens the sentence (pt-BR "Não há …"): reading order, the accent with the longer beat first.
    const accentEnd = REVEAL[0] + 0.14;
    const plainStart = accentEnd - 0.04;
    const plainStep = plain > 1 ? (REVEAL[1] - PLAIN_DURATION - plainStart) / (plain - 1) : 0;
    let pi = 0;
    let ai = 0;
    return words.map((w) => {
      if (w.accent) return { start: round(REVEAL[0] + ACCENT_STAGGER * ai++), end: round(accentEnd) };
      const start = plainStart + plainStep * pi++;
      return { start: round(start), end: round(start + PLAIN_DURATION) };
    });
  }
  const plainStep = plain > 1 ? (PLAIN_LAST_START - REVEAL[0]) / (plain - 1) : 0;
  const accentDuration = REVEAL[1] - ACCENT_START - ACCENT_STAGGER * Math.max(0, accents - 1);
  let pi = 0;
  let ai = 0;
  return words.map((w) => {
    if (w.accent) {
      const start = ACCENT_START + ACCENT_STAGGER * ai++;
      return { start: round(start), end: round(start + accentDuration) };
    }
    const start = REVEAL[0] + plainStep * pi++;
    return { start: round(start), end: round(start + PLAIN_DURATION) };
  });
}

function Word({ p, start, end, accent, calm, children }: { p: MotionValue<number>; start: number; end: number; accent: boolean; calm: boolean; children: string }) {
  const k = useTransform(p, (v) => clamp01((v - start) / (end - start)));
  const opacity = useTransform(k, (t) => round(t));
  const filter = useTransform(k, (t) => (t >= 1 ? "none" : `blur(${(8 * (1 - easeOut(t))).toFixed(2)}px)`));
  const y = useTransform(k, (t) => `${(0.35 * (1 - easeOut(t))).toFixed(3)}em`);
  return (
    <>
      <motion.span className={accent ? "statement-word accent" : "statement-word"} style={calm ? undefined : { opacity, filter, y }}>
        {children}
      </motion.span>{" "}
    </>
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
