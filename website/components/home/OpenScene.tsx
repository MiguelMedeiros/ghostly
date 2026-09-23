"use client";

import Link from "next/link";
import { motion, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { Stage, StageGhost, useAt } from "./stage";

const COLORS = ["#22d3ee", "#60a5fa", "#a78bfa", "#fbbf24", "#4ade80"];
const W = 150; // half width of a slab
const D = 60; // half depth (isometric)
const H = 16; // thickness

function Slab({ p, i, label, n }: { p: MotionValue<number>; i: number; label: string; n: number }) {
  const closed = 400 - i * (H + 4);
  const open = 440 - i * 78;
  const y = useAt(p, [0.1, 0.55], [closed, open]);
  const labelOn = useAt(p, [0.4 + i * 0.04, 0.55 + i * 0.04], [0, 1]);
  const c = COLORS[i];
  const last = i === n - 1;
  return (
    <motion.g style={{ y }}>
      <path d={`M${300 - W} 0 L300 ${D} L300 ${D + H} L${300 - W} ${H} Z`} fill={c} fillOpacity={last ? 0.08 : 0.35} stroke={c} strokeOpacity="0.6" />
      <path d={`M${300 + W} 0 L300 ${D} L300 ${D + H} L${300 + W} ${H} Z`} fill={c} fillOpacity={last ? 0.05 : 0.2} stroke={c} strokeOpacity="0.6" />
      <path
        d={`M300 ${-D} L${300 + W} 0 L300 ${D} L${300 - W} 0 Z`}
        fill={last ? "#060a10" : c}
        fillOpacity={last ? 1 : 0.16}
        stroke={c}
        strokeWidth="1.5"
        strokeDasharray={last ? "6 6" : undefined}
      />
      <motion.g style={{ opacity: labelOn }}>
        <line x1={300 + W + 6} y1={0} x2={300 + W + 30} y2={0} stroke={c} strokeOpacity="0.6" />
        <text x={300 + W + 36} y={4} fontSize="12.5" fill="#e8edf5" className="mono">
          {label}
        </text>
      </motion.g>
    </motion.g>
  );
}

function Visual({ layers }: { layers: string[] }) {
  const { p } = useScene();
  const ghosts = useAt(p, [0, 0.2], [1, 0]);
  return (
    <Stage viewBox="0 0 640 520">
      {layers.map((l, i) => (
        <Slab key={l} p={p} i={i} label={l} n={layers.length} />
      ))}
      <motion.g style={{ opacity: ghosts }}>
        <StageGhost x={200} y={200} size={80} who="boo" mood="happy" look={{ x: 1, y: 0.5 }} />
        <StageGhost x={320} y={206} size={80} who="casper" mood="happy" phase={1} look={{ x: -1, y: 0.5 }} />
      </motion.g>
    </Stage>
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
    <SceneFrame id="open" eyebrow={eyebrow} label={label} steps={steps} visual={<Visual layers={layers} />} length={90} stillAt={1}>
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
