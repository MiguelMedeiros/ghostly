"use client";

import { useEffect, useState } from "react";
import { Ghost, GhostMark } from "@/components/ghost/Ghost";
import { Particles } from "@/components/site/Particles";
import { APP_URL } from "@/content/shell";
import type { HomeCopy } from "@/content/home";

// Boo scans the dark for someone: left, right, up, then back to you.
const GAZE = [
  { x: -1, y: -0.2 },
  { x: -0.6, y: -0.8 },
  { x: 1, y: -0.3 },
  { x: 0.8, y: 0.5 },
  { x: 0, y: 0.2 },
];

export function Hero({ t }: { t: HomeCopy["hero"] }) {
  const [gaze, setGaze] = useState(0);
  const [casper, setCasper] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setGaze((g) => (g + 1) % GAZE.length), 1400);
    const peek = window.setTimeout(() => setCasper(true), 3200);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(peek);
    };
  }, []);

  return (
    <section className="hero" id="top">
      <div className="hero-bg bg-grid" aria-hidden="true" />
      <Particles count={24} />
      <div className="hero-glow hero-glow--a" aria-hidden="true" />
      <div className="hero-glow hero-glow--b" aria-hidden="true" />

      <div className="wrap hero-inner">
        <p className="hero-badge">
          <GhostMark /> {t.badge}
        </p>
        <p className="hero-wordmark" aria-hidden="true">
          {"Ghostly".split("").map((c, i) => (
            <span key={i} style={{ animationDelay: `${0.1 + i * 0.06}s` }} className="text-gradient-animated">
              {c}
            </span>
          ))}
        </p>

        <div className="hero-stage" aria-hidden="true">
          <div className="hero-boo">
            <div className="bubble bubble--boo">{t.booSays}</div>
            <Ghost who="boo" mood="curious" look={GAZE[gaze]} size={112} />
          </div>
          <div className="hero-casper" data-peek={casper}>
            <Ghost who="casper" mood="surprised" look={{ x: -1, y: 0 }} size={70} phase={2} />
          </div>
        </div>

        <h1 className="h-display hero-title">
          <span>{t.title1}</span> <span className="accent">{t.title2}</span>
        </h1>
        <p className="lead hero-lead">{t.lead}</p>

        <div className="hero-actions">
          <a className="btn btn--primary btn--lg" href={APP_URL}>
            <GhostMark /> {t.open} <span aria-hidden="true">↗</span>
          </a>
          <a className="btn" href="#download">
            {t.download} <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="hero-micro">{t.micro}</p>
        <div className="hero-follow">
          <a href="#invite" className="link-arrow">
            {t.follow} <span aria-hidden="true">↓</span>
          </a>
          <a href="#next" className="hero-skip">
            {t.skip}
          </a>
        </div>
      </div>
    </section>
  );
}
