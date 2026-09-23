"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  motionValue,
  useMotionValueEvent,
  useScroll,
  type MotionValue,
} from "motion/react";
import { useCalm } from "@/lib/useCalm";

/**
 * A scene that holds the screen while its story plays: the section is taller
 * than the viewport, its stage sticks, and scroll progress (0…1) drives the
 * picture while the copy steps through. Every step's text is in the DOM for
 * readers and search; with reduced motion the scene becomes a plain sequence.
 */
export type SceneStep = { title: string; body: string; note?: string };

type SceneState = { p: MotionValue<number>; step: number; still: boolean };
const SceneContext = createContext<SceneState | null>(null);

export function useScene(): SceneState {
  const ctx = useContext(SceneContext);
  if (!ctx) throw new Error("useScene outside a SceneFrame");
  return ctx;
}

export function SceneFrame({
  id,
  eyebrow,
  steps,
  visual,
  flip = false,
  length = 85,
  stillAt = 1,
  label,
  children,
}: {
  id: string;
  eyebrow: string;
  steps: SceneStep[];
  visual: React.ReactNode;
  flip?: boolean;
  /** Scroll length per step, in viewport heights. */
  length?: number;
  /** Progress to show when motion is reduced. */
  stillAt?: number;
  label?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useCalm();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [step, setStep] = useState(0);
  const [still] = useState(() => motionValue(stillAt));

  useMotionValueEvent(scrollYProgress, "change", (v) => {
    const next = Math.min(steps.length - 1, Math.max(0, Math.floor(v * steps.length * 0.9999)));
    setStep((prev) => (prev === next ? prev : next));
  });

  // Jumping to the scene by anchor lands on its first step.
  useEffect(() => {
    setStep(Math.min(steps.length - 1, Math.floor(scrollYProgress.get() * steps.length)));
  }, [scrollYProgress, steps.length]);

  const state: SceneState = reduce
    ? { p: still, step: steps.length - 1, still: true }
    : { p: scrollYProgress, step, still: false };

  return (
    <SceneContext.Provider value={state}>
      <section
        ref={ref}
        id={id}
        className="scene"
        data-static={reduce}
        aria-label={label}
        style={reduce ? undefined : { height: `${100 + steps.length * length}vh` }}
      >
        <div className="scene-sticky">
          <div className={`wrap scene-grid ${flip ? "scene-grid--flip" : ""}`}>
            <div className="scene-copy">
              <h2 className="eyebrow">{eyebrow}</h2>
              <ol className="scene-steps">
                {steps.map((s, i) => (
                  <li key={i} className="scene-step" data-active={reduce || i === step}>
                    <h3>{s.title}</h3>
                    <p>{s.body}</p>
                    {s.note && <small>{s.note}</small>}
                  </li>
                ))}
              </ol>
              <div className="scene-progress" aria-hidden="true">
                {steps.map((_, i) => (
                  <span key={i} data-on={i <= step} />
                ))}
              </div>
              {children}
            </div>
            <div className="scene-visual" aria-hidden="true">
              {visual}
            </div>
          </div>
        </div>
      </section>
    </SceneContext.Provider>
  );
}
