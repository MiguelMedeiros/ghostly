"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { animate as tween, motion, motionValue, useInView, useMotionValue, useMotionValueEvent, useScroll, useTransform, type MotionValue } from "motion/react";
import { useCalm } from "@/lib/useCalm";
import { DUR, EASE, useScrub } from "@/lib/motion";
import { EXIT, orientationOf, stepAt, stepOf, useCards, usePortrait, type Camera } from "@/components/home/stage";
import { BLOCKING, ROOMS, STAGE, valueAt, type Chapter } from "./poses";

/**
 * A chapter of the story: a full-bleed stage that holds the screen while its
 * steps play, with the copy in a floating panel over the picture. Scroll
 * progress (0…1) drives the picture; the copy steps through. Every step's text
 * is in the DOM for readers and search. With reduced motion, or without
 * scripts, the chapter becomes an illustrated article: one still per step.
 */
export type SceneStep = { title: string; body: string; note?: string };
export type CopyAt = "left" | "right" | "bottom-left" | "bottom-right";

type SceneState = {
  p: MotionValue<number>;
  step: number;
  n: number;
  still: boolean;
  portrait: boolean;
  camera: Camera;
  focus: { x: MotionValue<number>; y: MotionValue<number> };
};
const SceneContext = createContext<SceneState | null>(null);

export function useScene(): SceneState {
  const ctx = useContext(SceneContext);
  if (!ctx) throw new Error("useScene outside a SceneFrame");
  return ctx;
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Camera and focal point for a chapter, from the blocking table. */
function useBlocking(p: MotionValue<number>, chapter: Chapter, portrait: boolean, calm: boolean) {
  const b = BLOCKING[orientationOf(portrait)][chapter];
  const scale = useTransform(p, (v) => (calm ? 1 : valueAt(b.camera, v)));
  const fx = useTransform(p, (v) => valueAt(b.focus, v)[0]);
  const fy = useTransform(p, (v) => valueAt(b.focus, v)[1]);
  return { camera: { scale, fx, fy }, focus: { x: fx, y: fy } };
}

export function SceneFrame({
  id,
  chapter,
  eyebrow,
  steps,
  stills,
  visual,
  copyAt = "left",
  length = 70,
  label,
  seams = true,
  children,
}: {
  id: string;
  chapter: Chapter;
  eyebrow: string;
  steps: SceneStep[];
  /** Progress to freeze each step at, for the static figures. */
  stills: number[];
  visual: React.ReactNode;
  copyAt?: CopyAt;
  /** Scroll length per step, in viewport heights. */
  length?: number;
  label?: string;
  /** Inside an act the picture and copy fade at both ends so the hand-off happens on the bare backdrop; a chapter on its own keeps them. */
  seams?: boolean;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const cards = useCards();
  // The article shape: reduced motion (stills) and touch devices (each still plays its beat once).
  const article = calm || cards;
  const portrait = usePortrait();
  const n = steps.length;
  const inView = useInView(ref, { margin: "20% 0px 20% 0px" });
  const { scrollYProgress: rawProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const scrollYProgress = useScrub(rawProgress);

  // Server HTML and the first paint carry the story pose, not the scroll-0 pose.
  const [p] = useState(() => motionValue(stills[Math.min(1, n - 1)]));
  const [step, setStep] = useState(1 < n ? 1 : 0);
  useEffect(() => {
    if (article) return;
    const sync = (v: number) => {
      p.set(v);
      const next = stepOf(v, n);
      setStep((prev) => (prev === next ? prev : next));
    };
    sync(scrollYProgress.get());
    return scrollYProgress.on("change", sync);
  }, [article, n, p, scrollYProgress]);

  const { camera, focus } = useBlocking(p, chapter, portrait, calm);

  // The chapter's furniture (its picture and its panel) fades in as the chapter
  // pins and is gone before the actors start their glide at EXIT, so a hand-off
  // shows only the backdrop and the two ghosts. While it is invisible it takes
  // no clicks.
  const enter = useTransform(p, [0, 0.04], [0, 1]);
  const leave = useTransform(p, [EXIT - 0.04, EXIT], [1, 0]);
  const furniture = useTransform([enter, leave], ([a, b]) => (seams ? Math.min(a as number, b as number) : 1));
  const [hidden, setHidden] = useState(false);
  useMotionValueEvent(furniture, "change", (v) => setHidden(v < 0.05));
  const state = useMemo<SceneState>(() => ({ p, step, n, still: false, portrait, camera, focus }), [p, step, n, portrait, camera, focus]);

  const jump = (i: number) => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const travel = el.offsetHeight - window.innerHeight;
    window.scrollTo({ top: top + travel * stepAt(i, 0.2, n), behavior: "smooth" });
  };

  const room = ROOMS[chapter];
  const style = { "--chapter-bg": room, "--chapter-rgb": hexToRgb(room) } as React.CSSProperties;

  if (article) {
    // An illustrated article: each paragraph with its own frame (a still, or a beat that plays once in view).
    return (
      <SceneContext.Provider value={{ ...state, still: true }}>
      <section ref={ref} id={id} className="scene scene--static" data-chapter={chapter} aria-label={label} style={style}>
        <div className="wrap scene-static">
          <h2 className="eyebrow">{eyebrow}</h2>
          <ol className="scene-static-steps">
            {steps.map((s, i) => (
              <li key={i} className="scene-static-step">
                <div className="scene-static-copy">
                  <h3 className="h-scene">{s.title}</h3>
                  <p className="body">{s.body}</p>
                  {s.note && <p className="note">{s.note}</p>}
                </div>
                <StaticFigure state={{ ...state, still: true, step: i }} at={stills[i] ?? stills[stills.length - 1]} from={stepAt(i, 0, n)} play={!calm} chapter={chapter} portrait={portrait}>
                  {visual}
                </StaticFigure>
              </li>
            ))}
          </ol>
          {children && <div className="scene-static-extra">{children}</div>}
        </div>
      </section>
      </SceneContext.Provider>
    );
  }

  return (
    <SceneContext.Provider value={state}>
      <section
        ref={ref}
        id={id}
        className="scene"
        data-chapter={chapter}
        data-inview={inView}
        data-copy={copyAt}
        aria-label={label}
        style={{ ...style, height: `${100 + n * length}svh` }}
      >
        <div className="scene-sticky">
          <motion.div className="scene-visual" aria-hidden="true" style={{ opacity: furniture }}>
            {visual}
          </motion.div>
          <motion.div className="scene-wash" aria-hidden="true" style={{ opacity: furniture }} />
          <motion.div className="scene-copy" data-hidden={hidden} style={{ opacity: furniture }}>
            <h2 className="eyebrow" id={`${id}-eyebrow`}>
              {eyebrow}
            </h2>
            <ol className="scene-steps">
              {steps.map((s, i) => (
                <li key={i} className="scene-step" data-active={i === step} aria-current={i === step ? "step" : undefined}>
                  <h3 className="h-scene">{s.title}</h3>
                  <p className="body">{s.body}</p>
                  {s.note && <p className="note">{s.note}</p>}
                </li>
              ))}
            </ol>
            <div className="scene-progress" role="group" aria-labelledby={`${id}-eyebrow`}>
              {steps.map((s, i) => (
                <button key={i} type="button" data-on={i <= step} aria-current={i === step ? "step" : undefined} onClick={() => jump(i)}>
                  <span className="sr-only">
                    {i + 1}: {s.title}
                  </span>
                </button>
              ))}
            </div>
            {children}
          </motion.div>
        </div>
      </section>
    </SceneContext.Provider>
  );
}

/**
 * One frame of the scene for the article. With `play`, the frame starts at the
 * step's opening pose and plays through to its still once, when it comes into
 * view (touch devices); otherwise it is simply the still (reduced motion).
 */
function StaticFigure({ state, at, from, play, chapter, portrait, children }: { state: SceneState; at: number; from: number; play: boolean; chapter: Chapter; portrait: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const p = useMotionValue(play ? Math.min(from, at) : at);
  const inView = useInView(ref, { amount: 0.55, once: true });
  useEffect(() => {
    if (!play || !inView) return;
    const controls = tween(p, at, { duration: DUR.beat, ease: EASE.out });
    return () => controls.stop();
  }, [play, inView, at, p]);
  const b = BLOCKING[orientationOf(portrait)][chapter];
  // A landscape still is a whole stage in a figure: a slight push about the centre keeps the safe area and lifts the labels above 11px.
  const scale = useTransform(p, (): number => (portrait ? 1 : 1.25));
  const fx = useTransform(p, (v): number => (portrait ? valueAt(b.focus, v)[0] : STAGE.landscape.w / 2));
  const fy = useTransform(p, (v): number => (portrait ? valueAt(b.focus, v)[1] : 470));
  const value = useMemo<SceneState>(() => ({ ...state, p, camera: { scale, fx, fy }, focus: { x: fx, y: fy } }), [state, p, scale, fx, fy]);
  return (
    <SceneContext.Provider value={value}>
      <figure ref={ref} className="scene-static-figure" aria-hidden="true">
        {children}
      </figure>
    </SceneContext.Provider>
  );
}
