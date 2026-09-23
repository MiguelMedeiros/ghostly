"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { StaticActors } from "@/components/story/StaticActors";
import { Stage, useStep } from "./stage";

type Card = { title: string; link: string; qr: string; code: string; forOne: string };

// A fixed pseudo-QR: decoration only, it encodes nothing.
const QR = (() => {
  let s = 11;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const cells: [number, number][] = [];
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const finder = (x < 3 && y < 3) || (x > 5 && y < 3) || (x < 3 && y > 5);
      if (!finder && r() > 0.5) cells.push([x, y]);
    }
  return cells;
})();

function InviteCard({ t }: { t: Card }) {
  return (
    <g>
      <rect x="-86" y="-104" width="172" height="208" rx="18" fill="#0f1823" stroke="#22d3ee" strokeOpacity="0.55" />
      <text x="-66" y="-74" fontSize="15" fontWeight="700" fill="#e8edf5">
        {t.title}
      </text>
      <text x="-66" y="-56" fontSize="10" fill="#6b7a90">
        {t.forOne}
      </text>
      <g transform="translate(-66 -42)">
        <rect width="62" height="62" rx="6" fill="#e8edf5" />
        {[[0, 0], [42, 0], [0, 42]].map(([x, y]) => (
          <g key={`${x}-${y}`} transform={`translate(${x + 4} ${y + 4})`}>
            <rect width="16" height="16" rx="3" fill="#060a10" />
            <rect x="4" y="4" width="8" height="8" rx="1.5" fill="#e8edf5" />
          </g>
        ))}
        {QR.map(([x, y]) => (
          <rect key={`${x}.${y}`} x={4 + x * 6} y={4 + y * 6} width="5" height="5" rx="1" fill="#060a10" />
        ))}
      </g>
      <text x="6" y="-28" fontSize="9" className="mono" fill="#22d3ee">
        {t.qr}
      </text>
      <text x="-66" y="28" fontSize="9" className="mono" fill="#6b7a90">
        {t.link}
      </text>
      <g transform="translate(-66 32)">
        <rect width="132" height="24" rx="7" fill="#172231" />
        <text x="9" y="16" fontSize="9.5" className="mono" fill="#a3b0c2">
          app.ghostly.tools/#/chat/…
        </text>
      </g>
      <text x="-66" y="72" fontSize="9" className="mono" fill="#6b7a90">
        {t.code}
      </text>
      <g transform="translate(-66 76)">
        <rect width="132" height="24" rx="7" fill="#172231" />
        <text x="9" y="16" fontSize="9.5" className="mono" fill="#4ade80">
          pair1/k7Qx…
        </text>
      </g>
    </g>
  );
}

// Where things are, per orientation. The actors' poses live in poses.ts.
const L = { grow: [860, 590], fly: [1180, 560], chest: [1180, 610], link: [700, 1240, 800], check: [960, 800], arc: "M860 560 C 960 300, 1100 330, 1180 520", growScale: 1.25, flyScale: 0.75 };
const P = { grow: [200, 300], fly: [295, 330], chest: [295, 345], link: [60, 330, 450], check: [195, 450], arc: "M200 280 C 230 150, 280 170, 295 300", growScale: 0.8, flyScale: 0.55 };

function Visual({ card }: { card: Card }) {
  const { p, n, portrait, camera } = useScene();
  const C = portrait ? P : L;
  // s0: the card grows from Boo's hem. s1: it flies to Casper and folds into his chest. s2: the link, then the check.
  const grow = useStep(p, 0, n, [0.1, 0.8], [0.15, C.growScale]);
  const shrink = useStep(p, 1, n, [0, 0.65], [C.growScale, C.flyScale]);
  const fold = useStep(p, 1, n, [0.85, 1], [1, 0]);
  const x = useStep(p, 1, n, [0, 0.65], [C.grow[0], C.fly[0]]);
  const yArc = useStep(p, 1, n, [0, 0.65], [0, 1]);
  const yFly = useStep(p, 1, n, [0.85, 1], [C.fly[1], C.chest[1]]);
  const cardOpacity = useStep(p, 0, n, [0.08, 0.2], [0, 1]);
  const arc = useStep(p, 1, n, [0, 0.65], [0, 1]);
  const arcFade = useStep(p, 1, n, [0.7, 1], [0.35, 0]);
  const link = useStep(p, 2, n, [0, 0.4], [0, 1]);
  const check = useStep(p, 2, n, [0.42, 0.5, 0.58], [0, 1.25, 1]);
  const light = useStep(p, 2, n, [0.4, 0.6], [0.08, 0.2]);

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: "#22d3ee", opacity: light }}>
      <defs>
        <linearGradient id="inv-link" x1={C.link[0]} x2={C.link[1]} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#4ade80" />
        </linearGradient>
      </defs>
      <StaticActors chapter="invite" />
      {/* The private channel the invitation travels through. */}
      <motion.path d={C.arc} fill="none" stroke="#22d3ee" strokeWidth="2" strokeDasharray="4 8" style={{ pathLength: arc, opacity: arcFade }} />
      {/* The connection, once both confirmed it. */}
      <motion.path d={`M${C.link[0]} ${C.link[2]} L${C.link[1]} ${C.link[2]}`} fill="none" stroke="url(#inv-link)" strokeWidth={portrait ? 4 : 6} strokeLinecap="round" style={{ pathLength: link, opacity: link }} />
      <motion.g style={{ x: C.check[0], y: C.check[1], scale: check }}>
        <circle r={portrait ? 14 : 20} fill="#060a10" stroke="#4ade80" strokeWidth="2.5" />
        <path d={portrait ? "M-6 0 l4 4 l8 -8" : "M-9 0 l6 6 l12 -12"} stroke="#4ade80" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>
      <motion.g style={{ x, y: useYArc(yArc, yFly, C), scale: useCardScale(grow, shrink, fold, p, n), opacity: cardOpacity }}>
        <InviteCard t={card} />
      </motion.g>
    </Stage>
  );
}

// The card's y: along the arc's height during the flight, then down into Casper's chest.
function useYArc(arc: MotionValue<number>, fly: MotionValue<number>, C: typeof L) {
  return useTransform([arc, fly], ([a, f]) => {
    const t = a as number;
    const lift = Math.sin(t * Math.PI) * (C === L ? 220 : 130);
    const base = C.grow[1] + (C.fly[1] - C.grow[1]) * t - lift;
    return t >= 1 ? (f as number) : base;
  });
}
function useCardScale(grow: MotionValue<number>, shrink: MotionValue<number>, fold: MotionValue<number>, p: MotionValue<number>, n: number) {
  const inStep1 = useStep(p, 1, n, [0, 0.001], [0, 1]);
  return useTransform([grow, shrink, fold, inStep1], ([g, s, f, s1]) => ((s1 as number) > 0.5 ? (s as number) : (g as number)) * (f as number));
}

export function InviteScene({ eyebrow, label, steps, card }: { eyebrow: string; label: string; steps: SceneStep[]; card: Card }) {
  return <SceneFrame id="invite" chapter="invite" eyebrow={eyebrow} label={label} steps={steps} stills={[0.25, 0.5, 0.92]} copyAt="left" visual={<Visual card={card} />} />;
}
