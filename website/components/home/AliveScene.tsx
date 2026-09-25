"use client";

import { useId } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { StaticActors } from "@/components/story/StaticActors";
import { ease } from "@/lib/motion";
import { scatter, Stage, useStep } from "./stage";

/**
 * Chapter 4: the connection comes alive. Step 0 recalls the DHT: a faint node
 * cloud above the heads and the dashed rendezvous thread that introduced the
 * two. Step 1 draws the live pipe between the hems and plays one conversation
 * over it with a single item in flight at a time: a message goes over, a
 * payment comes back, a file goes over. Step 2 puts the STUN mast under the
 * pipe. Scroll drives every beat; nothing travels when the reader stops.
 */
type Layout = {
  /** The pipe path, its gradient extent, the track the items ride and their radius. */
  pipe: string;
  pipeX: [number, number];
  track: [number, number];
  trackY: number;
  pipeW: number;
  r: number;
  label: [number, number];
  cloud: { n: number; cx: number; cy: number; rx: number; ry: number };
  caption: [number, number];
  /** The rendezvous thread and the box its reveal mask covers. */
  arc: string;
  arcBox: [number, number, number, number];
  thread: [number, number];
  stun: [number, number];
  stunScale: number;
  /** STUN caption offset from the mast and its anchor; how far the ping ring grows. */
  stunCaption: [number, number, "middle" | "start"];
  helpers: [string, string];
  ping: number;
  /** How much of the pipe label stays once the STUN step needs its room (portrait: none). */
  labelKeep: number;
  font: number;
};

// Landscape: actors at x 690-950 and 1130-1390 (cloth ends 928 / starts 1152 after the slide),
// heads at y ≈ 382, eyes ≈ 459, hems ≈ 584. The pipe sits in the gap between the bodies.
const L: Layout = {
  pipe: "M952 520 H1128",
  pipeX: [952, 1128],
  track: [972, 1108],
  trackY: 520,
  pipeW: 18,
  r: 16,
  label: [1040, 660],
  cloud: { n: 24, cx: 1030, cy: 270, rx: 260, ry: 60 },
  caption: [1030, 200],
  arc: "M800 378 C 850 215, 1210 215, 1280 378",
  arcBox: [780, 200, 520, 200],
  thread: [1030, 332],
  stun: [1030, 740],
  stunScale: 1,
  stunCaption: [0, 30, "middle"],
  helpers: ["M1020 728 Q 900 720 840 596", "M1040 728 Q 1160 720 1240 596"],
  ping: 4,
  labelKeep: 1,
  font: 13,
};
// Portrait: actors at x 30-160 and 230-360, heads at y ≈ 203, hems ≈ 323; the gap is too narrow
// for a pipe, so two drops hang from the hem centres to a bus bar under them. The sheet starts ≈ 480.
// Short phones (360×640) hide stage y < ~145 under the nav: the caption's glyphs start at y ≈ 152.
const P: Layout = {
  pipe: "M95 336 V378 Q95 392 109 392 H281 Q295 392 295 378 V336",
  pipeX: [95, 295],
  track: [113, 277],
  trackY: 392,
  pipeW: 14,
  r: 14,
  label: [195, 430],
  cloud: { n: 14, cx: 195, cy: 162, rx: 150, ry: 18 },
  caption: [195, 160],
  arc: "M75 200 C 115 162, 275 162, 315 200",
  arcBox: [60, 150, 270, 60],
  thread: [195, 190],
  stun: [195, 448],
  stunScale: 0.85,
  stunCaption: [22, 4, "start"],
  helpers: ["M183 454 Q 110 462 84 398", "M207 454 Q 280 462 306 398"],
  ping: 3,
  labelKeep: 0,
  font: 11,
};

type Kind = "chat" | "bolt" | "file";
/** One conversation, in step-1 fractions: a message over, sats back, a file over. Never two in flight; the trips fill the step so each one reads at scroll speed. */
const CONVERSATION: { kind: Kind; dir: 1 | -1; at: [number, number] }[] = [
  { kind: "chat", dir: 1, at: [0.26, 0.46] },
  { kind: "bolt", dir: -1, at: [0.48, 0.68] },
  { kind: "file", dir: 1, at: [0.7, 0.9] },
];
const COLOR: Record<Kind, string> = { chat: "#22d3ee", bolt: "#fbbf24", file: "#a78bfa" };
const ICON: Record<Kind, string> = {
  chat: "M-6 -3.5 h12 v7 h-7 l-3.5 3.5 v-3.5 h-1.5 z",
  bolt: "M1.5 -8 L-5 1 H0 L-1.5 8 L5 -1 H0 Z",
  file: "M-4.5 -7 h6 l3.5 3.5 v10.5 h-9.5 z",
};

/** One item's trip along the pipe: it grows out of one end and shrinks into the other. */
function Item({ p, n, kind, dir, at, C }: { p: MotionValue<number>; n: number; kind: Kind; dir: 1 | -1; at: [number, number]; C: Layout }) {
  const t = useStep(p, 1, n, at, [0, 1], ease.move);
  const x = useTransform(t, (v) => {
    const f = dir === 1 ? v : 1 - v;
    return C.track[0] + f * (C.track[1] - C.track[0]);
  });
  const size = useTransform(t, (v) => Math.max(0, Math.min(1, Math.min(v, 1 - v) / 0.12)));
  const color = COLOR[kind];
  return (
    <motion.g style={{ x, y: C.trackY, scale: size, opacity: size }}>
      <circle r={C.r} fill="#060a10" stroke={color} strokeWidth="2" />
      <path d={ICON[kind]} fill={color} transform={`scale(${(C.r * 0.08).toFixed(2)})`} />
    </motion.g>
  );
}

/** STUN finds the route; it never carries the conversation. A mast under the pipe, one ping, helper lines to each device. */
function Stun({ p, n, C }: { p: MotionValue<number>; n: number; C: Layout }) {
  const mast = useStep(p, 2, n, [0.1, 0.28], [0, 1], ease.enter);
  const rise = useTransform(mast, (v) => (1 - v) * 14);
  const helpers = useStep(p, 2, n, [0.28, 0.46], [0, 1]);
  const ping = useStep(p, 2, n, [0.46, 0.7], [0, 1], ease.exit);
  const ringScale = useTransform(ping, (v) => 1 + v * C.ping);
  const ringFade = useTransform(ping, (v) => 1 - v);
  const [cx, cy, anchor] = C.stunCaption;
  return (
    <>
      <motion.g style={{ opacity: helpers }}>
        {C.helpers.map((d) => (
          <path key={d} d={d} stroke="#6b7a90" strokeDasharray="2 5" fill="none" />
        ))}
      </motion.g>
      <motion.g style={{ opacity: mast, y: rise }}>
        <g transform={`translate(${C.stun[0]} ${C.stun[1]})`}>
          <g transform={`scale(${C.stunScale})`}>
            <path d="M0 -20 L-14 12 H14 Z" fill="#172231" stroke="#6b7a90" />
            <circle cy="-26" r="6" fill="#6b7a90" />
            <motion.circle cy="-26" r="6" fill="none" stroke="#6b7a90" style={{ scale: ringScale, opacity: ringFade }} />
          </g>
          <text x={cx} y={cy} textAnchor={anchor} fontSize={C.font} letterSpacing="1" fill="#6b7a90" className="mono">
            STUN
          </text>
        </g>
      </motion.g>
    </>
  );
}

function Visual({ labels }: { labels: { pipe: string; thread: string } }) {
  const { p, n, portrait, camera } = useScene();
  const C = portrait ? P : L;
  const id = useId().replace(/:/g, "");
  // The caption may sit inside the cloud band (portrait): keep the dots out of its box.
  const cloud = scatter(C.cloud.n, 9, C.cloud.cx, C.cloud.cy, C.cloud.rx, C.cloud.ry).filter(
    (node) => !(Math.abs(node.x - C.caption[0]) < C.font * 5.4 && node.y > C.caption[1] - C.font - 4 && node.y < C.caption[1] + 4),
  );

  // s0: the thread draws through the cloud and gets its name; all of it dims when the pipe takes over.
  const reveal = useStep(p, 0, n, [0.08, 0.5], [0, 1], ease.move);
  const threadOn = useStep(p, 0, n, [0.08, 0.2], [0, 1]);
  const nameOn = useStep(p, 0, n, [0.5, 0.62], [0, 1]);
  const dim = useStep(p, 1, n, [0, 0.2], [1, 0.15]);
  const threadOpacity = useTransform([threadOn, dim], ([a, b]) => (a as number) * (b as number));
  const nameOpacity = useTransform([nameOn, dim], ([a, b]) => (a as number) * (b as number));

  // s1: the pipe draws between the hems, then the conversation plays over it. An undrawn path still
  // shows its round caps as a dot, so the pipe stays invisible until it starts.
  const pipeOn = useStep(p, 1, n, [0.04, 0.07], [0, 1]);
  const pipe = useStep(p, 1, n, [0.05, 0.22], [0, 1], ease.move);
  const pipeLabelIn = useStep(p, 1, n, [0.16, 0.26], [0, 1]);
  // Portrait lets the label go before the mast rises, so the two never share the spot half-faded.
  const pipeLabelKeep = useStep(p, 2, n, [0, 0.08], [1, C.labelKeep]);
  const pipeLabel = useTransform([pipeLabelIn, pipeLabelKeep], ([a, b]) => (a as number) * (b as number));
  const light = useStep(p, 1, n, [0.05, 0.5], [0.05, 0.2]);
  const core = Math.max(0, C.pipeW - 7);
  const glow = C.pipeW * 2.4;

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: "#4ade80", opacity: light }}>
      <defs>
        <linearGradient id={`pipe-${id}`} x1={C.pipeX[0]} x2={C.pipeX[1]} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#4ade80" />
        </linearGradient>
        {/* motion's pathLength rewrites stroke-dasharray, so the dashed thread is revealed by a solid path drawing inside a mask. */}
        <mask id={`thread-${id}`} maskUnits="userSpaceOnUse" x={C.arcBox[0]} y={C.arcBox[1]} width={C.arcBox[2]} height={C.arcBox[3]}>
          <motion.path d={C.arc} fill="none" stroke="#fff" strokeWidth="12" strokeLinecap="round" style={{ pathLength: reveal }} />
        </mask>
      </defs>
      <StaticActors chapter="alive" />

      {/* The DHT that introduced them: a node cloud above the heads. */}
      <motion.g style={{ opacity: dim }}>
        {[0, 1, 2].map((bucket) => (
          <g key={bucket} className="dht-node" style={{ animationDelay: `${-bucket * 1.3}s` }}>
            {cloud.filter((_, i) => i % 3 === bucket).map((node, i) => (
              <circle key={i} cx={node.x} cy={node.y} r={2 + node.t * 2} fill="#3b4b63" />
            ))}
          </g>
        ))}
        <text x={C.caption[0]} y={C.caption[1]} textAnchor="middle" fontSize={C.font} letterSpacing="2" fill="#6b7a90" className="mono">
          MAINLINE DHT
        </text>
      </motion.g>

      {/* The rendezvous thread, head to head through the cloud. */}
      <motion.g style={{ opacity: threadOpacity }}>
        <path d={C.arc} fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 7" mask={`url(#thread-${id})`} />
      </motion.g>
      <motion.text x={C.thread[0]} y={C.thread[1]} textAnchor="middle" fontSize={C.font} fill="#22d3ee" className="mono" style={{ opacity: nameOpacity }}>
        {labels.thread}
      </motion.text>

      {/* The live connection: glow, tube, dark core, then one item at a time. */}
      <motion.g style={{ opacity: pipeOn }}>
        <motion.path d={C.pipe} fill="none" stroke={`url(#pipe-${id})`} strokeWidth={glow} strokeLinecap="round" strokeOpacity="0.22" style={{ pathLength: pipe }} />
        <motion.path d={C.pipe} fill="none" stroke={`url(#pipe-${id})`} strokeWidth={C.pipeW} strokeLinecap="round" style={{ pathLength: pipe }} />
        <motion.path d={C.pipe} fill="none" stroke="#060a10" strokeWidth={core} strokeLinecap="butt" style={{ pathLength: pipe }} />
      </motion.g>
      {CONVERSATION.map((item) => (
        <Item key={item.kind} p={p} n={n} C={C} {...item} />
      ))}
      <motion.text x={C.label[0]} y={C.label[1]} textAnchor="middle" fontSize={C.font} fill="#e8edf5" className="mono" style={{ opacity: pipeLabel }}>
        {labels.pipe} · WebRTC
      </motion.text>

      <Stun p={p} n={n} C={C} />
    </Stage>
  );
}

export function AliveScene({ eyebrow, label, steps, labels }: { eyebrow: string; label: string; steps: SceneStep[]; labels: { pipe: string; thread: string } }) {
  return <SceneFrame id="alive" chapter="alive" eyebrow={eyebrow} label={label} steps={steps} stills={[0.22, 0.6, 0.83]} copyAt="left" length={90} visual={<Visual labels={labels} />} />;
}
