"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { GhostMark, Ghost } from "@/components/ghost/Ghost";
import { Particles } from "@/components/site/Particles";
import { useCalm } from "@/lib/useCalm";
import { usePortrait } from "./stage";
import { APP_URL } from "@/content/shell";
import type { HomeCopy } from "@/content/home";

/**
 * Act 0: one sentence in the dark and a small ghost asking into it. Boo is the
 * act's actor — the backdrop draws him at his hero pose and carries him into
 * the invitation when you scroll; the copy slides away as you leave. Without
 * scripts, or with reduced motion, a still Boo stands in for the actor.
 */
export function Hero({ t }: { t: HomeCopy["hero"] }) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const portrait = usePortrait();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  // On phones the copy sits in the lower half, where Boo will glide: it leaves before he moves (poses.ts P.hero).
  const range = portrait ? [0.1, 0.4] : [0.2, 0.7];
  const y = useTransform(scrollYProgress, range, [0, -48]);
  const opacity = useTransform(scrollYProgress, range, [1, 0]);

  return (
    <section ref={ref} className="hero" id="hero">
      <div className="hero-bg bg-grid" aria-hidden="true" />
      <div className="hero-light" aria-hidden="true" />
      <Particles count={14} />

      {/* Only when the act backdrop is not drawing the actor. */}
      <div className="hero-still" aria-hidden="true">
        <div className="bubble bubble--boo">{t.booSays}</div>
        <Ghost who="boo" mood="lonely" look={{ x: 0.6, y: -0.4 }} size={160} float={!calm} />
      </div>

      <motion.div className="wrap hero-inner" style={calm ? { y: 0, opacity: 1 } : { y, opacity }}>
        <p className="sr-only">Boo: {t.booSays}</p>
        <h1 className="h-display hero-title">
          <span className="hero-line" style={{ animationDelay: "0.05s" }}>
            {t.title1}
          </span>
          <span className="hero-line accent" style={{ animationDelay: "0.14s" }}>
            {t.title2}
          </span>
        </h1>
        <p className="lead hero-lead hero-rise" style={{ animationDelay: "0.35s" }}>
          {t.lead}
        </p>
        <div className="hero-actions hero-rise" style={{ animationDelay: "0.42s" }}>
          <a className="btn btn--primary btn--lg" href={APP_URL}>
            <GhostMark /> {t.open} <span aria-hidden="true">↗</span>
          </a>
          <a className="btn" href="#download">
            {t.download} <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="hero-micro caption hero-rise" style={{ animationDelay: "0.5s" }}>
          <span>{t.badge}</span>
          <span>{t.micro}</span>
        </p>
        <div className="hero-follow hero-rise" style={{ animationDelay: "0.55s" }}>
          <a href="#invite" className="link-arrow">
            {t.follow} <span aria-hidden="true">↓</span>
          </a>
          <a href="#next" className="hero-skip">
            {t.skip}
          </a>
        </div>
      </motion.div>
    </section>
  );
}
