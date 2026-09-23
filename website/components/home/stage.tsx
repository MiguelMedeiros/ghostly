"use client";

import { useEffect, useId, useState } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { Ghost, type GhostMood } from "@/components/ghost/Ghost";
import { STAGE, type Orientation } from "@/components/story/poses";

/** Clamp-mapped scroll value: `useAt(p, [0.2, 0.4], [0, 1])`. */
export function useAt(p: MotionValue<number>, input: number[], output: number[]) {
  return useTransform(p, input, output, { clamp: true });
}

/** Every scene keeps p∈[0,.06] for its entrance and [.94,1] for its exit. */
export const ENTER = 0.06;
export const EXIT = 0.94;

/** Which step (0…n-1) a scene progress is in. */
export function stepOf(p: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(((p - ENTER) / (EXIT - ENTER)) * n)));
}

/** The scene progress at fraction f of step i — the inverse of stepOf. */
export function stepAt(i: number, f: number, n: number): number {
  return ENTER + ((i + f) / n) * (EXIT - ENTER);
}

/**
 * Map a range inside step i to an output: `useStep(p, 1, 3, [0.2, 0.6], [0, 1])`
 * is 0 until 20% into step 1, 1 from 60% on. Ranges may cross step edges
 * (`[-0.1, 0.3]`) for beats that bridge two steps.
 */
export function useStep(p: MotionValue<number>, i: number, n: number, range: number[], output: number[]) {
  return useTransform(p, range.map((f) => stepAt(i, f, n)), output, { clamp: true });
}

/** Landscape stages until 860px; portrait below. SSR assumes landscape. */
export function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 860px)");
    const update = () => setPortrait(q.matches);
    update();
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, []);
  return portrait;
}

export const orientationOf = (portrait: boolean): Orientation => (portrait ? "portrait" : "landscape");

/** A ghost placed in stage units; `who` colours it, `s` is its width. */
export function StageGhost({
  x,
  y,
  size,
  who,
  mood,
  look,
  phase,
  tilt,
  style,
  className = "",
}: {
  x: number;
  y: number;
  size: number;
  who: "boo" | "casper" | "shade";
  mood?: GhostMood;
  look?: { x: number; y: number };
  phase?: number;
  tilt?: number;
  style?: React.ComponentProps<typeof motion.g>["style"];
  className?: string;
}) {
  return (
    <motion.g style={style} className={className}>
      <g transform={`translate(${x} ${y})`}>
        <g className="stage-bob" style={{ animationDelay: `${-(phase ?? 0) * 1.37}s` }}>
          <Ghost who={who} mood={mood} look={look} size={size} phase={phase} float={false} tilt={tilt} halo />
        </g>
      </g>
    </motion.g>
  );
}

export type Camera = {
  scale: MotionValue<number>;
  fx: MotionValue<number>;
  fy: MotionValue<number>;
};

/**
 * A full-bleed stage. `slice` crops to fill the viewport (the story mode);
 * `meet` shows the whole picture (static figures). A camera pushes in about
 * its focal point so that point stays where it is on screen.
 */
export function Stage({
  children,
  portrait = false,
  fit = "slice",
  camera,
  className = "",
  light,
}: {
  children: React.ReactNode;
  portrait?: boolean;
  fit?: "slice" | "meet";
  camera?: Camera;
  className?: string;
  /** Key light on the focal point, in the acting ghost's colour. */
  light?: { color: string; opacity?: MotionValue<number> | number };
}) {
  const { w, h } = STAGE[orientationOf(portrait)];
  return (
    <svg className={`stage ${className}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio={`xMidYMid ${fit}`} role="presentation">
      {camera ? (
        <CameraGroup camera={camera} light={light}>
          {children}
        </CameraGroup>
      ) : (
        children
      )}
    </svg>
  );
}

function CameraGroup({ camera, light, children }: { camera: Camera; light?: React.ComponentProps<typeof Stage>["light"]; children: React.ReactNode }) {
  const id = useId().replace(/:/g, "");
  const x = useTransform([camera.scale, camera.fx], ([s, fx]) => (fx as number) * (1 - (s as number)));
  const y = useTransform([camera.scale, camera.fy], ([s, fy]) => (fy as number) * (1 - (s as number)));
  return (
    <motion.g style={{ x, y, scale: camera.scale }}>
      {light && (
        <>
          <defs>
            <radialGradient id={`light-${id}`}>
              <stop offset="0" stopColor={light.color} stopOpacity="1" />
              <stop offset="0.55" stopColor={light.color} stopOpacity="0.35" />
              <stop offset="1" stopColor={light.color} stopOpacity="0" />
            </radialGradient>
          </defs>
          <motion.circle className="key-light" r="420" fill={`url(#light-${id})`} style={{ cx: camera.fx, cy: camera.fy, opacity: light.opacity ?? 0.16 }} />
        </>
      )}
      {children}
    </motion.g>
  );
}

/** Deterministic scatter for network nodes. */
export function scatter(n: number, seed: number, cx: number, cy: number, rx: number, ry: number) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: n }, () => {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(0.15 + r() * 0.85);
    const round = (v: number) => Math.round(v * 100) / 100;
    return { x: round(cx + Math.cos(a) * rx * d), y: round(cy + Math.sin(a) * ry * d), t: round(r()) };
  });
}
