"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useInView, useMotionValue, useMotionValueEvent, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { Ghost, type GhostMood } from "@/components/ghost/Ghost";
import { EXIT, orientationOf, scatter, stepOf, useCards, usePortrait, VIEW_BOX_ORIGIN } from "@/components/home/stage";
import { useCalm } from "@/lib/useCalm";
import { SPRING, useScrub } from "@/lib/motion";
import { BLOCKING, blockingFor, poseAt, ROOMS, STAGE, valueAt, type Chapter, type Frame } from "./poses";
import { IDENTITY, lerpFraming, measureFraming, sameFraming, type Framing } from "./framing";

/**
 * One continuous take. The act pins a full-bleed backdrop behind its chapters
 * and keeps exactly one Boo and one Casper in it; as the chapters scroll over
 * the backdrop, the actors glide between the poses in the blocking table, the
 * room tint changes and the camera pushes in on what the copy names. Without
 * scripts or with reduced motion the backdrop is not rendered and each scene
 * shows its own still ghosts.
 */
export type ActChapter = { id: string; chapter: Chapter; kind?: "pinned" | "free" };

/** `framing`: where the chapter's picture sits on this window (story/framing.ts); the actors are drawn in it too. */
type Range = { chapter: Chapter; start: number; end: number; steps: number; framing: Framing };
type Located = { chapter: Chapter; t: number; steps: number; i: number };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function Act({
  id,
  chapters,
  field = false,
  bubble,
  bubbleAvoid,
  children,
}: {
  id: string;
  chapters: ActChapter[];
  /** A faint node field behind the whole act (Act I: the network is always there). */
  field?: boolean;
  /** A line Boo says in the first chapter. */
  bubble?: string;
  /** Copy the line must stay clear of (a selector inside the act), e.g. the hero's headline and buttons. */
  bubbleAvoid?: string;
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
    <LiveAct id={id} chapters={chapters} field={field} bubble={bubble} bubbleAvoid={bubbleAvoid}>
      {children}
    </LiveAct>
  );
}

function LiveAct({ id, chapters, field, bubble, bubbleAvoid, children }: { id: string; chapters: ActChapter[]; field: boolean; bubble?: string; bubbleAvoid?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
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
        next.push({ chapter: c.chapter, start: top / travel, end, steps, framing: c.kind === "free" ? IDENTITY : measureFraming(el, c.chapter) });
      }
      const prev = rangesRef.current;
      const same = prev.length === next.length && prev.every((r, i) => r.chapter === next[i].chapter && r.start === next[i].start && r.end === next[i].end && r.steps === next[i].steps && sameFraming(r.framing, next[i].framing));
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
        return v < (prev.end + r.start) / 2 ? { chapter: prev.chapter, t: 1, steps: prev.steps, i: i - 1 } : { chapter: r.chapter, t: 0, steps: r.steps, i };
      }
      return { chapter: r.chapter, t: r.end === r.start ? 0 : clamp01((v - r.start) / (r.end - r.start)), steps: r.steps, i };
    }
    const last = rs[rs.length - 1];
    return { chapter: last.chapter, t: 1, steps: last.steps, i: rs.length - 1 };
  };

  // What the window shows of the stage, and where the copy ends: the hero pose is fitted to it (poses.ts fitHero).
  // Read through a ref (the transformers below keep their first closure); `framed` re-runs them when it changes.
  const frameRef = useRef<Frame | null>(null);
  const framed = useMotionValue<number>(0);
  const [frame, setFrame] = useState<Frame | null>(null);
  const table = (chapter: Chapter) => blockingFor(orient, chapter, frameRef.current);
  const pose = (who: "boo" | "casper", v: number) => {
    const at = locate(v);
    // Until the window is measured the fitted pose is unknown: Boo waits unseen instead of standing somewhere he may be cut.
    if (!frameRef.current && orient === "landscape" && chapters[0].chapter === "hero") return { ...poseAt(table(chapters[0].chapter)[who], 0), a: 0 };
    if (!at) return poseAt(table(chapters[0].chapter)[who], 0);
    return poseAt(table(at.chapter)[who], at.t);
  };
  const focus = (v: number): [number, number] => {
    const at = locate(v);
    if (!at) return valueAt(BLOCKING[orient][chapters[0].chapter].focus, 0);
    return valueAt(BLOCKING[orient][at.chapter].focus, at.t);
  };

  // Every actor channel, opacity included, goes through the same spring: no hard cuts inside an act.
  const spring = SPRING.actor;
  const bx = useSpring(useTransform([actP, framed], ([v]) => pose("boo", v as number).x), spring);
  const by = useSpring(useTransform([actP, framed], ([v]) => pose("boo", v as number).y), spring);
  const bs = useSpring(useTransform([actP, framed], ([v]) => pose("boo", v as number).s / 100), spring);
  const ba = useSpring(useTransform([actP, framed], ([v]) => pose("boo", v as number).a), spring);
  const cx = useSpring(useTransform([actP, framed], ([v]) => pose("casper", v as number).x), spring);
  const cy = useSpring(useTransform([actP, framed], ([v]) => pose("casper", v as number).y), spring);
  const cs = useSpring(useTransform([actP, framed], ([v]) => pose("casper", v as number).s / 100), spring);
  const ca = useSpring(useTransform([actP, framed], ([v]) => pose("casper", v as number).a), spring);

  useLayoutEffect(() => {
    const measure = () => {
      const svg = svgRef.current;
      const act = ref.current;
      if (!svg || !act || orient !== "landscape") return;
      const box = svg.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const { w: sw, h: sh } = STAGE.landscape;
      const k = Math.max(box.width / sw, box.height / sh);
      const l = (sw - box.width / k) / 2;
      const t = (sh - box.height / k) / 2;
      const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nav-h")) || 64;
      const copy = bubbleAvoid ? [...act.querySelectorAll(bubbleAvoid)].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 2 && r.height > 2) : [];
      const copyRight = copy.length ? l + (Math.max(...copy.map((r) => r.right)) - box.left) / k : l;
      const next: Frame = { l, t: t + navH / k, r: l + box.width / k, b: t + box.height / k, k, copyRight };
      const prev = frameRef.current;
      if (prev && (Object.keys(next) as (keyof Frame)[]).every((key) => Math.abs(prev[key] - next[key]) < 0.5)) return;
      frameRef.current = next;
      setFrame(next);
      framed.set(framed.get() + 1);
      // The first fit is where he stands, not somewhere he glides to; he fades in there.
      if (!prev) {
        const at = pose("boo", actP.get());
        bx.jump(at.x);
        by.jump(at.y);
        bs.jump(at.s / 100);
      }
    };
    measure();
    // Again once the webfont is in (the copy's width changes with it).
    void document.fonts?.ready.then(measure);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // pose() only reads refs and the orientation, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orient, bubbleAvoid, framed, bx, by, bs]);
  const fx = useTransform(actP, (v) => focus(v)[0]);
  const fy = useTransform(actP, (v) => focus(v)[1]);
  const scale = useTransform(actP, (v) => {
    const at = locate(v);
    return at ? valueAt(BLOCKING[orient][at.chapter].camera, at.t) : 1;
  });
  // Scaling about the viewBox origin, then translating by focus·(1−s), keeps the focal point still.
  const camX = useTransform([scale, fx], ([s, f]) => (f as number) * (1 - (s as number)));
  const camY = useTransform([scale, fy], ([s, f]) => (f as number) * (1 - (s as number)));
  // The chapter's framing; it changes to the next chapter's during the actors' glide, so they arrive in it.
  const framingAt = (v: number): Framing => {
    const at = locate(v);
    if (!at) return IDENTITY;
    const here = rangesRef.current[at.i].framing;
    const next = rangesRef.current[at.i + 1]?.framing;
    return next && at.t > EXIT ? lerpFraming(here, next, (at.t - EXIT) / (1 - EXIT)) : here;
  };
  // Framings change on resize without a scroll: this nudges the framing values to re-read them.
  const measured = useMotionValue<number>(0);
  const framingK = useTransform([actP, measured], ([v]) => framingAt(v as number).k);
  const framingX = useTransform([actP, measured], ([v]) => framingAt(v as number).x);
  const framingY = useTransform([actP, measured], ([v]) => framingAt(v as number).y);
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
    measured.set(measured.get() + 1);
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
        <svg ref={svgRef} className="stage" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice">
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
          <motion.g style={{ x: framingX, y: framingY, scale: framingK, ...VIEW_BOX_ORIGIN }}>
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
              {bubble && <Bubble text={bubble} x={bx} y={by} s={bs} fade={bubbleFade} orient={orient} rest={poseAt(blockingFor(orient, chapters[0].chapter, frame).boo, 0)} avoid={bubbleAvoid} />}
            </motion.g>
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


/** Where Boo's line sits relative to his rest pose, worked out from the part of the stage the screen shows. */
type BubbleLayout = {
  lines: string[];
  fs: number;
  w: number;
  h: number;
  /** The bubble's left edge is at head x + ax · width − align · w + shift, its top at head y + ay · width − h. */
  ax: number;
  align: number;
  shift: number;
  ay: number;
  /** Tail: where its base sits along the bottom edge, and which way its tip leans (−1 left, 0 down, 1 right). */
  tail: number;
  lean: -1 | 0 | 1;
  side: "right" | "above" | "left";
};

const BUBBLE_MIN_PX = 13;
const BUBBLE_MARGIN_PX = 12;

/** Two lines, broken at the space nearest the middle. */
function halves(text: string): string[] {
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? [text] : [text.slice(0, best), text.slice(best + 1)];
}

/**
 * The stage is drawn with `slice`, so a narrow or tall window crops its sides.
 * Try the line right of Boo's head, then above it, then left of it, first on
 * one line and then on two; the first that stays on screen, clear of the nav
 * and of the copy (`avoid`), wins. If none does, it goes above his head, slid
 * sideways into view with the tail still under his head.
 */
function layoutBubble(text: string, g: SVGGElement, orient: "landscape" | "portrait", rest: { x: number; y: number; s: number }, avoid?: string): BubbleLayout {
  const svg = g.ownerSVGElement!;
  const box = svg.getBoundingClientRect();
  const { w: sw, h: sh } = STAGE[orient];
  const k = Math.max(box.width / sw, box.height / sh) || 1;
  const x0 = (sw - box.width / k) / 2;
  const y0 = (sh - box.height / k) / 2;
  const cs = getComputedStyle(svg);
  const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nav-h")) || 64;
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = `${cs.fontWeight} 100px ${cs.fontFamily}`;
  const measure = (s: string) => (ctx ? ctx.measureText(s).width / 100 : s.length * 0.55);
  // The copy, in screen pixels as it stands when the act is at its start (the backdrop is pinned to the act's top).
  const actTop = svg.closest(".act")?.getBoundingClientRect().top ?? box.top;
  const blocks = avoid
    ? [...svg.closest(".act")!.querySelectorAll(avoid)]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 2 && r.height > 2)
        .map((r) => ({ l: r.left - box.left, t: r.top - actTop, r: r.right - box.left, b: r.bottom - actTop }))
    : [];

  const fs = Math.max(18, BUBBLE_MIN_PX / k);
  const gw = rest.s;
  const headX = rest.x + gw / 2;
  const ay = -8 / gw + 0.04;
  const tailH = fs * 0.66;
  const fits = (l: number, t: number, w: number, h: number) => {
    const px = { l: (l - x0) * k, t: (t - y0) * k, r: (l + w - x0) * k, b: (t + h + tailH - y0) * k };
    if (px.l < BUBBLE_MARGIN_PX || px.r > box.width - BUBBLE_MARGIN_PX) return false;
    if (px.t < navH + 8 || px.b > box.height - BUBBLE_MARGIN_PX) return false;
    const m = BUBBLE_MARGIN_PX;
    return blocks.every((b) => px.r + m <= b.l || px.l - m >= b.r || px.b + m <= b.t || px.t - m >= b.b);
  };

  const options = [[text], halves(text)].filter((ls, i) => i === 0 || ls.length > 1);
  for (const lines of options) {
    const w = Math.max(...lines.map(measure)) * fs + fs * 2.8;
    const h = fs * (2.9 + 1.3 * (lines.length - 1));
    const top = rest.y + ay * gw - h;
    const sides = [
      { side: "right", ax: 0.62, align: 0, tail: h * 0.46, lean: -1 },
      { side: "above", ax: 0.5, align: 0.5, tail: w / 2, lean: 0 },
      { side: "left", ax: 0.38, align: 1, tail: w - h * 0.46, lean: 1 },
    ] as const;
    for (const o of sides) {
      const left = rest.x + o.ax * gw - o.align * w;
      if (fits(left, top, w, h)) return { lines, fs, w, h, ax: o.ax, align: o.align, shift: 0, ay, tail: Math.min(o.tail, w - h / 2), lean: o.lean, side: o.side };
    }
  }
  const lines = options[options.length - 1];
  const w = Math.max(...lines.map(measure)) * fs + fs * 2.8;
  const h = fs * (2.9 + 1.3 * (lines.length - 1));
  const m = BUBBLE_MARGIN_PX / k;
  const want = headX - w / 2;
  const left = Math.max(x0 + m, Math.min(x0 + box.width / k - m - w, want));
  const r = Math.min(h / 2, fs * 1.45);
  return { lines, fs, w, h, ax: 0.5, align: 0.5, shift: left - want, ay, tail: Math.max(r, Math.min(w - r, headX - left)), lean: 0, side: "above" };
}

/** Boo's line, typed out once per page load, beside or above his head and kept on screen; it fades as the story moves on. */
function Bubble({
  text,
  x,
  y,
  s,
  fade,
  orient,
  rest,
  avoid,
}: {
  text: string;
  x: MotionValue<number>;
  y: MotionValue<number>;
  s: MotionValue<number>;
  fade: MotionValue<number>;
  orient: "landscape" | "portrait";
  rest: { x: number; y: number; s: number };
  avoid?: string;
}) {
  const ref = useRef<SVGGElement>(null);
  const [shown, setShown] = useState(0);
  const [lay, setLay] = useState<BubbleLayout>(() => {
    const fs = 18;
    const w = text.length * fs * 0.55 + fs * 2.8;
    const h = fs * 2.9;
    return { lines: [text], fs, w, h, ax: 0.62, align: 0, shift: 0, ay: -8 / rest.s + 0.04, tail: h * 0.46, lean: -1, side: "right" };
  });
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
  const { x: rx, y: ry, s: rs } = rest;
  useEffect(() => {
    const place = () => {
      if (ref.current) setLay(layoutBubble(text, ref.current, orient, { x: rx, y: ry, s: rs }, avoid));
    };
    place();
    // Again once the webfont is in and the copy has finished rising in (before the typing starts).
    void document.fonts?.ready.then(place);
    const settle = window.setTimeout(place, 1000);
    window.addEventListener("resize", place);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", place);
    };
  }, [text, orient, rx, ry, rs, avoid]);

  const layRef = useRef(lay);
  layRef.current = lay;
  const { lines, fs, w: bw, h: bh } = lay;
  // Offsets scale with Boo (s is his width / 100) so the line stays on his head while he moves.
  // Read through the ref: a subscribed transformer keeps the closure of its first render.
  const ox = useTransform([x, s], ([gx, gs]) => {
    const l = layRef.current;
    return (gx as number) + l.ax * (gs as number) * 100 - l.align * l.w + l.shift;
  });
  const oy = useTransform([y, s], ([gy, gs]) => {
    const l = layRef.current;
    return (gy as number) + l.ay * (gs as number) * 100 - l.h;
  });
  const tailH = fs * 0.66;
  const base = fs * 0.45;
  const tip = lay.tail + lay.lean * fs * 0.8;
  // The typed prefix, split over the lines.
  let left = shown;
  const typed = lines.map((l, i) => {
    const n = Math.max(0, Math.min(l.length, left));
    left -= l.length + (i < lines.length - 1 ? 1 : 0);
    return l.slice(0, n);
  });
  const caretLine = Math.max(0, typed.findIndex((t, i) => t.length < lines[i].length));
  const first = bh / 2 - ((lines.length - 1) * 1.3 * fs) / 2 + fs * 0.33;
  return (
    <motion.g ref={ref} style={{ x: ox, y: oy, opacity: fade }} className="act-bubble" data-on={shown > 0} data-side={lay.side}>
      <rect width={bw} height={bh} rx={Math.min(bh / 2, fs * 1.45)} fill="rgba(34,211,238,0.14)" />
      <path d={`M${lay.tail - base} ${bh} L${tip} ${bh + tailH} L${lay.tail + base} ${bh} z`} fill="rgba(34,211,238,0.14)" />
      <text textAnchor="middle" fontSize={fs} fill="#22d3ee">
        {lines.map((_, i) => (
          <tspan key={i} x={bw / 2} y={first + i * 1.3 * fs}>
            {typed[i]}
            {shown < text.length && i === caretLine && <tspan className="act-caret">|</tspan>}
          </tspan>
        ))}
      </text>
    </motion.g>
  );
}
