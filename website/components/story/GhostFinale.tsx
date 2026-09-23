"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { StoryIllustration } from "./StoryIllustration";
import { GhostGlyph } from "../icons";
import { useHaunting } from "../HauntedPage";

export function GhostFinale() {
  const ref = useRef<HTMLElement>(null);
  const nearby = useInView(ref, { once: true, margin: "200px" });
  const inView = useInView(ref);
  const { enabled } = useHaunting();
  return (
    <section
      ref={ref}
      className="ghost-finale"
      aria-labelledby="finale-heading"
    >
      <div className="finale-swarm" aria-hidden="true">
        {Array.from({ length: 16 }, (_, i) => (
          <motion.div
            key={i}
            style={{
              left: `${(i * 29 + 7) % 100}%`,
              top: `${(i * 17 + 12) % 100}%`,
              width: 20 + (i % 5) * 9,
              height: 20 + (i % 5) * 9,
            }}
            animate={
              enabled && inView
                ? {
                    opacity: [0, 0.18, 0.18, 0],
                    y: [20, 0, -30, -60],
                    x: [0, 10, -10, 0],
                    rotate: [0, 5, -5, 0],
                  }
                : { opacity: 0.12, y: 0, x: 0, rotate: 0 }
            }
            transition={{
              duration: 8 + (i % 5) * 2,
              delay: (i % 7) * 0.7,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            <GhostGlyph />
          </motion.div>
        ))}
      </div>
      <div className="finale-heading">
        <p className="chapter-eyebrow">A NEW STORY STARTS WITH YOU</p>
        <h2 id="finale-heading">
          Somebody out there
          <br />
          is waiting for your <em>boo.</em>
        </h2>
        <a
          className="story-cta"
          href="https://app.ghostly.tools"
          target="_blank"
          rel="noopener noreferrer"
        >
          Become a ghost <span>↗</span>
        </a>
        <span className="finale-note">
          Free. Open source. No account required.
        </span>
      </div>
      <div className="finale-world">
        {nearby && <StoryIllustration time={4.8} finale />}
      </div>
      <a href="#beginning" className="finale-replay">
        ↑ Watch their story again
      </a>
      <div className="finale-wordmark" aria-hidden="true">
        ghostly<span>.</span>
      </div>
    </section>
  );
}
