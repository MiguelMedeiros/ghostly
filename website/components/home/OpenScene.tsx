"use client";

import Link from "next/link";
import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { Ghost } from "@/components/ghost/Ghost";
import { Stage, useStep } from "./stage";

const COLORS = ["#22d3ee", "#60a5fa", "#a78bfa", "#fbbf24", "#4ade80"];
type Layout = { cx: number; cy: number; W: number; D: number; H: number; gap: number; ghost: number };
const L: Layout = { cx: 760, cy: 560, W: 210, D: 84, H: 22, gap: 92, ghost: 120 };
const P: Layout = { cx: 195, cy: 330, W: 110, D: 44, H: 12, gap: 52, ghost: 70 };

function Slab({ p, n, i, label, count, C, portrait }: { p: MotionValue<number>; n: number; i: number; label: string; count: number; C: Layout; portrait: boolean }) {
  const closed = C.cy - i * (C.H + 4);
  const open = C.cy + (count - 1) * (C.gap / 2) - i * C.gap;
  // The stack opens over the first step; labels arrive one by one as it does.
  const y = useStep(p, 0, n, [0.1, 0.95], [closed, open]);
  const labelOn = useStep(p, 0, n, [0.45 + i * 0.09, 0.6 + i * 0.09], [0, 1]);
  const labelX = useStep(p, 0, n, [0.45 + i * 0.09, 0.6 + i * 0.09], [24, 0]);
  const shadow = useStep(p, 0, n, [0.1, 0.95], [0, 0.55]);
  const c = COLORS[i];
  const last = i === count - 1;
  return (
    <motion.g style={{ y }}>
      {i > 0 && <motion.ellipse cx={C.cx} cy={C.gap * 0.85} rx={C.W * 0.9} ry={C.D * 0.55} fill="#000" style={{ opacity: shadow }} />}
      <path d={`M${C.cx - C.W} 0 L${C.cx} ${C.D} L${C.cx} ${C.D + C.H} L${C.cx - C.W} ${C.H} Z`} fill={c} fillOpacity={last ? 0.08 : 0.35} stroke={c} strokeOpacity="0.6" />
      <path d={`M${C.cx + C.W} 0 L${C.cx} ${C.D} L${C.cx} ${C.D + C.H} L${C.cx + C.W} ${C.H} Z`} fill={c} fillOpacity={last ? 0.05 : 0.2} stroke={c} strokeOpacity="0.6" />
      <path d={`M${C.cx} ${-C.D} L${C.cx + C.W} 0 L${C.cx} ${C.D} L${C.cx - C.W} 0 Z`} fill={last ? "#060a10" : c} fillOpacity={last ? 1 : 0.16} stroke={c} strokeWidth="1.5" strokeDasharray={last ? "6 6" : undefined} />
      {!portrait && (
        <motion.g style={{ opacity: labelOn, x: labelX }}>
          <line x1={C.cx + C.W + 8} y1={0} x2={C.cx + C.W + 40} y2={0} stroke={c} strokeOpacity="0.6" />
          <text x={C.cx + C.W + 48} y={5} fontSize="14" fill="#e8edf5" className="mono">
            {label}
          </text>
        </motion.g>
      )}
    </motion.g>
  );
}

function Visual({ layers }: { layers: string[] }) {
  const { p, n, portrait, camera, step } = useScene();
  const C = portrait ? P : L;
  const count = layers.length;
  const top = count - 1;
  const closedTop = C.cy - top * (C.H + 4) - C.D;
  const openTop = C.cy + (count - 1) * (C.gap / 2) - top * C.gap - C.D;
  // The ghosts stand on the top slab and ride up with it.
  const ride = useStep(p, 0, n, [0.1, 0.95], [closedTop, openTop]);
  const g = C.ghost;
  const booY = useTransform(ride, (v) => v - g * 1.25 + 8);
  // Another app — a dashed outline, not a character — comes to stand on your app.
  const other = useStep(p, 1, n, [0.3, 0.6], [0, 1]);
  const otherX = useStep(p, 1, n, [0.3, 0.6], [C.cx + C.W + 60, C.cx + g * 0.25]);
  const light = useStep(p, 0, n, [0.2, 0.9], [0.04, 0.12]);

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: "#a78bfa", opacity: light }}>
      {layers.map((l, i) => (
        <Slab key={l} p={p} n={n} i={i} label={l} count={count} C={C} portrait={portrait} />
      ))}
      <motion.g style={{ y: booY }}>
        <ellipse cx={C.cx - g * 0.75} cy={g * 1.25 - 4} rx={g * 0.42} ry={g * 0.08} fill="#000" opacity="0.45" />
        <ellipse cx={C.cx + g * 0.25} cy={g * 1.25} rx={g * 0.42} ry={g * 0.08} fill="#000" opacity="0.45" />
        <g transform={`translate(${C.cx - g * 1.25} 0)`}>
          <Ghost who="boo" size={g} mood={step === 0 ? "curious" : "happy"} look={{ x: 0.3, y: 1 }} float={false} halo />
        </g>
        <g transform={`translate(${C.cx - g * 0.2} 6)`}>
          <Ghost who="casper" size={g} mood="happy" look={{ x: step === 1 ? 1 : -0.3, y: step === 1 ? 0.2 : 1 }} float={false} halo phase={1} />
        </g>
        <motion.g style={{ opacity: other, x: otherX }}>
          <g transform={`translate(${g * 0.9} 6) scale(${g / 80})`}>
            <path
              d="M8 66 L8 40 C8 21 20 8 40 8 C60 8 72 21 72 40 L72 66 C70 79 58 79 56 66 C54 79 42 79 40 66 C38 79 26 79 24 66 C22 79 10 79 8 66 Z"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1.8"
              strokeDasharray="4 4"
            />
          </g>
        </motion.g>
      </motion.g>
    </Stage>
  );
}

/** In portrait the layer names live in the caption sheet, revealed with their slabs. */
function Legend({ layers }: { layers: string[] }) {
  const { p, n, portrait } = useScene();
  if (!portrait) return null;
  return (
    <ol className="open-legend">
      {layers.map((l, i) => (
        <LegendItem key={l} p={p} n={n} i={i} color={COLORS[i]}>
          {l}
        </LegendItem>
      ))}
    </ol>
  );
}
function LegendItem({ p, n, i, color, children }: { p: MotionValue<number>; n: number; i: number; color: string; children: string }) {
  const on = useStep(p, 0, n, [0.45 + i * 0.09, 0.6 + i * 0.09], [0.25, 1]);
  return (
    <motion.li style={{ opacity: on, ["--c" as string]: color }}>
      <span aria-hidden="true" />
      {children}
    </motion.li>
  );
}

export function OpenScene({
  eyebrow,
  label,
  steps,
  layers,
  cta,
  catalog,
  devHref,
  catalogHref,
}: {
  eyebrow: string;
  label: string;
  steps: SceneStep[];
  layers: string[];
  cta: string;
  catalog: string;
  devHref: string;
  catalogHref: string;
}) {
  return (
    <SceneFrame id="open" chapter="open" eyebrow={eyebrow} label={label} steps={steps} stills={[0.3, 0.9]} copyAt="left" length={90} visual={<Visual layers={layers} />}>
      <Legend layers={layers} />
      <div className="open-actions">
        <Link className="btn btn--primary" href={devHref}>
          {cta} →
        </Link>
        <Link className="btn" href={catalogHref}>
          {catalog}
        </Link>
      </div>
    </SceneFrame>
  );
}
