"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { Ghost, type GhostMood } from "@/components/ghost/Ghost";

/** Clamp-mapped scroll value: `at(p, [0.2, 0.4], [0, 1])`. */
export function useAt(p: MotionValue<number>, input: number[], output: number[]) {
  return useTransform(p, input, output, { clamp: true });
}

/** A ghost placed in a stage's SVG coordinates. */
export function StageGhost({
  x,
  y,
  size,
  who,
  mood,
  look,
  phase,
  style,
}: {
  x: number;
  y: number;
  size: number;
  who: "boo" | "casper" | "shade";
  mood?: GhostMood;
  look?: { x: number; y: number };
  phase?: number;
  style?: React.ComponentProps<typeof motion.g>["style"];
}) {
  return (
    <motion.g style={style}>
      <g transform={`translate(${x} ${y})`}>
        <g className="stage-bob" style={{ animationDelay: `${-(phase ?? 0) * 1.37}s` }}>
          <Ghost who={who} mood={mood} look={look} size={size} phase={phase} float={false} />
        </g>
      </g>
    </motion.g>
  );
}

export function Stage({ children, viewBox = "0 0 600 520", className = "" }: { children: React.ReactNode; viewBox?: string; className?: string }) {
  return (
    <svg className={`stage ${className}`} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="presentation">
      {children}
    </svg>
  );
}

/** Deterministic scatter for network nodes. */
export function scatter(n: number, seed: number, cx: number, cy: number, rx: number, ry: number) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: n }, () => {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(0.15 + r() * 0.85);
    return { x: cx + Math.cos(a) * rx * d, y: cy + Math.sin(a) * ry * d, t: r() };
  });
}
