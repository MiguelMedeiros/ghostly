"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { GhostShape } from "../icons";
import { useHaunting } from "../HauntedPage";

/** A single scroll timeline moves both peers and their shared object together. */
export function Scene({
  technical = false,
  compact = false,
}: {
  technical?: boolean;
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { enabled } = useHaunting();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const left = useTransform(scrollYProgress, [0, 0.45, 1], [-30, 0, 40]);
  const right = useTransform(scrollYProgress, [0, 0.45, 1], [30, 0, -40]);
  const lift = useTransform(scrollYProgress, [0, 1], [18, -18]);
  return (
    <div
      ref={ref}
      className={`p-scene ${compact ? "compact" : ""}`}
      aria-hidden="true"
    >
      <div className="p-orbit orbit-one" />
      <div className="p-orbit orbit-two" />
      <div className="p-scene-line" />
      <motion.div className="p-peer peer-a" style={{ x: enabled ? left : 0 }}>
        <svg viewBox="0 0 24 24">
          <GhostShape lookX={0.4} />
        </svg>
        <span>YOU</span>
      </motion.div>
      <motion.div className="p-scene-center" style={{ y: enabled ? lift : 0 }}>
        {technical ? (
          <div className="p-stack">
            <span>your experience</span>
            <strong>negotiated capabilities</strong>
            <span>adapters ↔ adapters</span>
          </div>
        ) : (
          <div className="p-message">
            <span className="p-message-dot" /> a little hello.
            <span className="p-message-check">✓✓</span>
          </div>
        )}
      </motion.div>
      <motion.div className="p-peer peer-b" style={{ x: enabled ? right : 0 }}>
        <svg viewBox="0 0 24 24">
          <GhostShape lookX={-0.4} />
        </svg>
        <span>YOUR PERSON</span>
      </motion.div>
      <div className="p-scene-caption">
        {technical
          ? "SAME AGREEMENT. DIFFERENT IMPLEMENTATIONS."
          : "A PRIVATE CONNECTION. A WORLD OF POSSIBILITIES."}
      </div>
    </div>
  );
}

const story = [
  {
    title: "A link between you.",
    body: "Make an invitation. Share it privately. Your contact joins, and you confirm the connection together.",
    note: "No phone number. No public profile required.",
    symbol: "↗",
    label: "Private invitation",
    detail: "you → your person",
  },
  {
    title: "Find each other. Then agree.",
    body: "Your devices find a way to connect and agree on the things they both support. The connection adapts. Your conversation stays yours.",
    note: "An invitation contains secrets. Only share it with the person you want to meet.",
    symbol: "↔",
    label: "A shared language",
    detail: "chat · files · sats",
  },
  {
    title: "Make something of it.",
    body: "A late-night message. A photo you just took. A few sats to say thanks. Small things, directly between you.",
    note: "Files and payments need support at both ends. Calls and local apps use compatible legacy chats.",
    symbol: "✳",
    label: "More than hello",
    detail: "one connection · many possibilities",
  },
];

export function ConnectionStory() {
  return (
    <section className="p-story" id="story" aria-labelledby="story-title">
      <div className="p-wrap">
        <p className="p-eyebrow">01 — FIND YOUR PERSON</p>
        <h2 id="story-title">
          Good things start
          <br />
          with a little <em>boo.</em>
        </h2>
      </div>
      <div className="p-wrap p-chapters">
        {story.map((step, i) => (
          <StoryStep key={step.title} step={step} index={i} />
        ))}
      </div>
    </section>
  );
}
function StoryStep({
  step,
  index,
}: {
  step: (typeof story)[number];
  index: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const { enabled } = useHaunting();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "center center"],
  });
  const scale = useTransform(scrollYProgress, [0, 1], [0.87, 1]);
  const rotate = useTransform(scrollYProgress, [0, 1], [index % 2 ? 5 : -5, 0]);
  return (
    <article className="p-story-step" ref={ref}>
      <div className="p-story-copy">
        <span className="p-step-number">0{index + 1}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <small>{step.note}</small>
      </div>
      <motion.div
        className={`p-story-art art-${index}`}
        style={{ scale: enabled ? scale : 1, rotate: enabled ? rotate : 0 }}
        aria-hidden="true"
      >
        <div className="p-art-halo" />
        <div className="p-art-ticket">
          <span>{step.symbol}</span>
          <strong>{step.label}</strong>
          <small>{step.detail}</small>
        </div>
        <svg className="p-art-ghost" viewBox="0 0 24 24">
          <GhostShape lookX={0.5} lookY={-0.3} />
        </svg>
      </motion.div>
    </article>
  );
}

/** The layers settle into one shared session as this chapter enters the viewport. */
export function AdapterAssembly() {
  const ref = useRef<HTMLDivElement>(null);
  const { enabled } = useHaunting();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "center center"],
  });
  const spread = useTransform(scrollYProgress, [0, 1], [28, 0]);
  const tilt = useTransform(scrollYProgress, [0, 1], [-4, 0]);
  return (
    <div
      ref={ref}
      className="p-assembly"
      aria-label="Reference app, negotiated capabilities, authenticated session and supported adapters"
    >
      <motion.div
        className="p-code-diagram"
        style={{ rotate: enabled ? tilt : 0 }}
      >
        <motion.span style={{ y: enabled ? spread : 0 }}>
          reference app
        </motion.span>
        <strong>chat/1 · files/2 · payments/1</strong>
        <span>authenticated session</span>
        <motion.div style={{ y: enabled ? spread : 0 }}>
          WebRTC <b>↔</b> Iroh <b>↔</b> HyperDHT
        </motion.div>
      </motion.div>
    </div>
  );
}
