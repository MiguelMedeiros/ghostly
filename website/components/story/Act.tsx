"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useInView, useMotionValueEvent, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { Ghost, type GhostMood } from "@/components/ghost/Ghost";
import { orientationOf, scatter, stepOf, useCards, usePortrait, VIEW_BOX_ORIGIN } from "@/components/home/stage";
import { useCalm } from "@/lib/useCalm";
import { SPRING, useScrub } from "@/lib/motion";
import { BLOCKING, poseAt, ROOMS, STAGE, valueAt, type Chapter } from "./poses";

/**
 * One continuous take. The act pins a full-bleed backdrop behind its chapters
 * and keeps exactly one Boo and one Casper in it; as the chapters scroll over
 * the backdrop, the actors glide between the poses in the blocking table, the
 * room tint changes and the camera pushes in on what the copy names. Without
 * scripts or with reduced motion the backdrop is not rendered and each scene
 * shows its own still ghosts.
 */
export type ActChapter = { id: string; chapter: Chapter; kind?: "pinned" | "free" };

type Range = { chapter: Chapter; start: number; end: number; steps: number };
type Located = { chapter: Chapter; t: number; steps: number };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function Act({
  id,
  chapters,
  field = false,
  bubble,
  children,
}: {
  id: string;
  chapters: ActChapter[];
  /** A faint node field behind the whole act (Act I: the network is always there). */
  field?: boolean;
  /** A line Boo says in the first chapter. */
  bubble?: string;
  children: React.ReactNode;
}) {
  const calm = useCalm();
  const cards = useCards();
  if (calm || cards) {
    return (
      <div id={id} className="act act--static">
        {children}
      </div>
    );
  }
  return (
    <LiveAct id={id} chapters={chapters} field={field} bubble={bubble}>
      {children}
    </LiveAct>
  );
}

function LiveAct({ id, chapters, field, bubble, children }: { id: string; chapters: ActChapter[]; field: boolean; bubble?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const portrait = usePortrait();
  const orient = orientationOf(portrait);
  const inView = useInView(ref, { margin: "10% 0px 10% 0px" });
  const { scrollYProgress: rawActP } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // The camera, the focal point and the field follow the smoothed progress; the actors add their own weight on top.
  const actP = useScrub(rawActP);
  const [ranges, setRanges] = useState<Range[]>([]);
  const rangesRef = useRef<Range[]>([]);

  // Where each chapter sits along the act, as fractions of the act's scroll travel.
  useEffect(() => {
    const measure = () => {
      const act = ref.current;
      if (!act) return;
      const vh = window.innerHeight;
      const actTop = act.getBoundingClientRect().top + window.scrollY;
      const travel = Math.max(1, act.offsetHeight - vh);
      const next: Range[] = [];
      for (const c of chapters) {
        const el = document.getElementById(c.id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top + window.scrollY - actTop;
        const h = el.offsetHeight;
        const steps = el.querySelectorAll(".scene-step").length || 1;
        const end = c.kind === "free" ? (top + h) / travel : (top + h - vh) / travel;
        next.push({ chapter: c.chapter, start: top / travel, end, steps });
      }
      const prev = rangesRef.current;
      const same = prev.length === next.length && prev.every((r, i) => r.chapter === next[i].chapter && r.start === next[i].start && r.end === next[i].end && r.steps === next[i].steps);
      if (same) return;
      rangesRef.current = next;
      setRanges(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [chapters]);

  // Which chapter and sub-progress a global act progress is in. A pinned chapter
  // ends one viewport before the next one starts; in that hand-off the actors
  // already stand at the shared pose, and the room and moods switch halfway.
  const locate = (v: number): Located | null => {
    const rs = rangesRef.current;
    if (!rs.length) return null;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      if (v >= r.end) continue;
      if (i > 0 && v < r.start) {
        const prev = rs[i - 1];
        return v < (prev.end + r.start) / 2 ? { chapter: prev.chapter, t: 1, steps: prev.steps } : { chapter: r.chapter, t: 0, steps: r.steps };
      }
      return { chapter: r.chapter, t: r.end === r.start ? 0 : clamp01((v - r.start) / (r.end - r.start)), steps: r.steps };
    }
    const last = rs[rs.length - 1];
    return { chapter: last.chapter, t: 1, steps: last.steps };
  };

  const pose = (who: "boo" | "casper", v: number) => {
    const at = locate(v);
    if (!at) return poseAt(BLOCKING[orient][chapters[0].chapter][who], 0);
    return poseAt(BLOCKING[orient][at.chapter][who], at.t);
  };
  const focus = (v: number): [number, number] => {
    const at = locate(v);
    if (!at) return valueAt(BLOCKING[orient][chapters[0].chapter].focus, 0);
    return valueAt(BLOCKING[orient][at.chapter].focus, at.t);
  };

  // Every actor channel, opacity included, goes through the same spring: no hard cuts inside an act.
  const spring = SPRING.actor;
  const bx = useSpring(useTransform(actP, (v) => pose("boo", v).x), spring);
  const by = useSpring(useTransform(actP, (v) => pose("boo", v).y), spring);
  const bs = useSpring(useTransform(actP, (v) => pose("boo", v).s / 100), spring);
  const ba = useSpring(useTransform(actP, (v) => pose("boo", v).a), spring);
  const cx = useSpring(useTransform(actP, (v) => pose("casper", v).x), spring);
  const cy = useSpring(useTransform(actP, (v) => pose("casper", v).y), spring);
  const cs = useSpring(useTransform(actP, (v) => pose("casper", v).s / 100), spring);
  const ca = useSpring(useTransform(actP, (v) => pose("casper", v).a), spring);
  const fx = useTransform(actP, (v) => focus(v)[0]);
  const fy = useTransform(actP, (v) => focus(v)[1]);
  const scale = useTransform(actP, (v) => {
    const at = locate(v);
    return at ? valueAt(BLOCKING[orient][at.chapter].camera, at.t) : 1;
  });
  // Scaling about the viewBox origin, then translating by focus·(1−s), keeps the focal point still.
  const camX = useTransform([scale, fx], ([s, f]) => (f as number) * (1 - (s as number)));
  const camY = useTransform([scale, fy], ([s, f]) => (f as number) * (1 - (s as number)));
  const fieldY = useTransform(actP, [0, 1], [0, -80]);
  // Boo's line stays for the first half of the opening chapter, then fades as he starts to move.
  const bubbleFade = useTransform(actP, (v) => {
    const end = rangesRef.current[0]?.end ?? 0;
    return end ? 1 - clamp01((v - end * 0.45) / (end * 0.35)) : 1;
  });

  // Gazes: each ghost looks at the focal point (pupils move up to ±2.2 / ±1.8 units).
  const booLook = useGaze(bx, by, bs, fx, fy);
  const casperLook = useGaze(cx, cy, cs, fx, fy);

  // Moods and the room follow the chapter and step.
  const [scene, setScene] = useState<{ chapter: Chapter; step: number }>({ chapter: chapters[0].chapter, step: 0 });
  useMotionValueEvent(actP, "change", (v) => {
    const at = locate(v);
    if (!at) return;
    const step = stepOf(at.t, at.steps);
    setScene((prev) => (prev.chapter === at.chapter && prev.step === step ? prev : { chapter: at.chapter, step }));
  });
  useEffect(() => {
    // Re-evaluate once the ranges are known.
    const at = locate(actP.get());
    if (at) setScene({ chapter: at.chapter, step: stepOf(at.t, at.steps) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranges]);

  const moods = BLOCKING[orient][scene.chapter].moods;
  const booMood: GhostMood = moods.boo[Math.min(scene.step, moods.boo.length - 1)];
  const casperMood: GhostMood = moods.casper[Math.min(scene.step, moods.casper.length - 1)];
  const { w, h } = STAGE[orient];
  const nodes = useMemo(() => (field ? scatter(portrait ? 40 : 110, 21, w / 2, h / 2, w * 0.55, h * 0.55) : []), [field, portrait, w, h]);
  const edges = useMemo(() => {
    const out: [number, number][] = [];
    nodes.forEach((a, i) => nodes.forEach((b, j) => {
      if (j > i && Math.hypot(a.x - b.x, a.y - b.y) < (portrait ? 70 : 90)) out.push([i, j]);
    }));
    return out;
  }, [nodes, portrait]);

  const room = ROOMS[scene.chapter];

  return (
    <div id={id} ref={ref} className="act" data-chapter={scene.chapter} data-inview={inView} style={{ ["--chapter-bg" as string]: room }}>
      <div className="act-backdrop" aria-hidden="true">
        <svg className="stage" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice">
          <rect className="act-room" width={w} height={h} />
          {field && (
            <motion.g className="act-field" style={{ y: fieldY }}>
              {edges.map(([a, b]) => (
                <line key={`${a}-${b}`} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y} stroke="#22d3ee" strokeOpacity="0.08" />
              ))}
              {[0, 1, 2].map((bucket) => (
                <g key={bucket} className="dht-node" style={{ animationDelay: `${-bucket * 1.3}s` }}>
                  {nodes.filter((_, i) => i % 3 === bucket).map((n, i) => (
                    <circle key={i} cx={n.x} cy={n.y} r={1.6 + n.t * 2} fill="#4c5f7a" />
                  ))}
                </g>
              ))}
            </motion.g>
          )}
          <motion.g style={{ x: camX, y: camY, scale, ...VIEW_BOX_ORIGIN }}>
            <motion.g className="actor" style={{ x: cx, y: cy, scale: cs, opacity: ca, ...VIEW_BOX_ORIGIN }}>
              <g className="stage-bob" style={{ animationDelay: "-1.37s" }}>
                <Ghost who="casper" size={100} mood={casperMood} look={casperLook} float={false} halo phase={1} />
              </g>
            </motion.g>
            <motion.g className="actor" style={{ x: bx, y: by, scale: bs, opacity: ba, ...VIEW_BOX_ORIGIN }}>
              <g className="stage-bob">
                <Ghost who="boo" size={100} mood={booMood} look={booLook} float={false} halo />
              </g>
            </motion.g>
            {bubble && <Bubble text={bubble} x={bx} y={by} s={bs} fade={bubbleFade} portrait={portrait} />}
          </motion.g>
        </svg>
      </div>
      {children}
    </div>
  );
}

/** Pupils toward the focal point. A ghost at (x, y, s) has its eyes near (x + 50s, y + 45s). */
function useGaze(x: MotionValue<number>, y: MotionValue<number>, s: MotionValue<number>, fx: MotionValue<number>, fy: MotionValue<number>) {
  const lx = useTransform([x, s, fx], ([gx, gs, f]) => Math.max(-1, Math.min(1, ((f as number) - ((gx as number) + (gs as number) * 50)) / 420)) * 2.2);
  const ly = useTransform([y, s, fy], ([gy, gs, f]) => Math.max(-1, Math.min(1, ((f as number) - ((gy as number) + (gs as number) * 45)) / 320)) * 1.8);
  return { x: lx, y: ly };
}

/** Boo's line, typed out once per page load, anchored above his head; it fades as the story moves on. */
function Bubble({ text, x, y, s, fade, portrait }: { text: string; x: MotionValue<number>; y: MotionValue<number>; s: MotionValue<number>; fade: MotionValue<number>; portrait: boolean }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let i = 0;
    let tick: number | undefined;
    const start = window.setTimeout(() => {
      tick = window.setInterval(() => {
        i++;
        setShown(i);
        if (i >= text.length && tick !== undefined) window.clearInterval(tick);
      }, 35);
    }, 1200);
    return () => {
      window.clearTimeout(start);
      if (tick !== undefined) window.clearInterval(tick);
    };
  }, [text]);
  const bw = portrait ? 200 : 260;
  const bh = portrait ? 44 : 52;
  const ox = useTransform([x, s], ([gx, gs]) => (gx as number) + (gs as number) * (portrait ? 30 : 70));
  const oy = useTransform([y, s], ([gy, gs]) => (gy as number) - bh - 8 + (portrait ? 0 : (gs as number) * 4));
  return (
    <motion.g style={{ x: ox, y: oy, opacity: fade }} className="act-bubble" data-on={shown > 0}>
      <rect width={bw} height={bh} rx={bh / 2} fill="rgba(34,211,238,0.14)" />
      <path d={`M18 ${bh} l-8 12 l20 -12 z`} fill="rgba(34,211,238,0.14)" />
      <text x={bw / 2} y={bh / 2 + 6} textAnchor="middle" fontSize={portrait ? 15 : 18} fill="#22d3ee">
        {text.slice(0, shown)}
        {shown < text.length && <tspan className="act-caret">|</tspan>}
      </text>
    </motion.g>
  );
}
