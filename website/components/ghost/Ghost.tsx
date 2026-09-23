"use client";

import { useId } from "react";
import { useCalm } from "@/lib/useCalm";

/**
 * Boo and Casper: the original Ghostly silhouette (round head, eyes set wide,
 * a hem that folds like light cloth). The hem ripples, the eyes blink and look
 * around; nothing else about the character changes from scene to scene.
 */
export type GhostMood =
  | "happy"
  | "talk"
  | "surprised"
  | "wink"
  | "sleep"
  | "calm"
  | "curious";

export const GHOST_COLORS = {
  boo: "#22d3ee",
  casper: "#4ade80",
  shade: "#94a3b8",
} as const;

type Props = {
  who?: keyof typeof GHOST_COLORS;
  color?: string;
  mood?: GhostMood;
  /** Where the pupils point, -1…1 on each axis. */
  look?: { x: number; y: number };
  size?: number | string;
  className?: string;
  /** Soft bob up and down. */
  float?: boolean;
  /** Accessible name; leave empty for a decorative ghost. */
  title?: string;
  /** Stagger for the idle loops so two ghosts never move in unison. */
  phase?: number;
};

// The hem hangs in four rounded folds, like light cloth. Each frame nudges the
// depth and sway of every fold a little; the body morphs between frames.
function bodyPath(frame: number): string {
  const folds = [8, 24, 40, 56, 72];
  const top = 66;
  let d = `M8 ${top} L8 40 C8 21 20 8 40 8 C60 8 72 21 72 40 L72 ${top}`;
  for (let i = folds.length - 1; i > 0; i--) {
    const a = folds[i];
    const b = folds[i - 1];
    const depth = 13 + Math.sin(frame * 1.7 + i * 1.3) * 2.6;
    const sway = Math.sin(frame + i * 0.8) * 1.6;
    d += ` C${(a - 2 + sway).toFixed(2)} ${(top + depth).toFixed(2)} ${(b + 2 + sway).toFixed(2)} ${(top + depth).toFixed(2)} ${b} ${top}`;
  }
  return d + " Z";
}

const FRAMES = [0, 1.6, 3.2, 4.8].map(bodyPath);
const STILL = FRAMES[0];

export function Ghost({
  who = "boo",
  color,
  mood = "happy",
  look = { x: 0, y: 0 },
  size = 96,
  className = "",
  float = true,
  title,
  phase = 0,
}: Props) {
  const reduce = useCalm();
  const id = useId().replace(/:/g, "");
  const fill = color ?? GHOST_COLORS[who];
  const lx = Math.max(-1, Math.min(1, look.x)) * 2.2;
  const ly = Math.max(-1, Math.min(1, look.y)) * 1.8;
  const closed = mood === "sleep";
  const delay = `${-phase * 1.37}s`;

  return (
    <svg
      viewBox="0 0 80 100"
      width={size}
      height={typeof size === "number" ? size * 1.25 : undefined}
      className={`ghost ${float ? "ghost--float" : ""} ${className}`}
      style={{ ["--ghost" as string]: fill, animationDelay: delay }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <radialGradient id={`sheen-${id}`} cx="35%" cy="25%" r="75%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="45%" stopColor="#fff" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.12" />
        </radialGradient>
      </defs>
      {[fill, `url(#sheen-${id})`].map((paint, i) => (
        <path key={i} d={STILL} fill={paint} style={i ? { mixBlendMode: "soft-light" } : undefined}>
          {!reduce && (
            <animate
              attributeName="d"
              dur="3.2s"
              begin={delay}
              repeatCount="indefinite"
              values={[...FRAMES, FRAMES[0]].join(";")}
              calcMode="spline"
              keySplines={Array(FRAMES.length).fill("0.45 0 0.55 1").join(";")}
            />
          )}
        </path>
      ))}

      <g className={`ghost-eyes ${closed ? "" : "ghost-eyes--blink"}`} style={{ animationDelay: delay }}>
        {closed ? (
          <>
            <path d="M23 37 Q29 41 35 37" stroke="#0b1622" strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M45 37 Q51 41 57 37" stroke="#0b1622" strokeWidth="3" fill="none" strokeLinecap="round" />
          </>
        ) : (
          <>
            {mood === "wink" ? (
              <path d="M23 37 Q29 32 35 37" stroke="#0b1622" strokeWidth="3" fill="none" strokeLinecap="round" />
            ) : (
              <ellipse cx="29" cy="36" rx={mood === "surprised" ? 7 : 6} ry={mood === "surprised" ? 7.5 : 6.5} fill="#0b1622" />
            )}
            <ellipse cx="51" cy="36" rx={mood === "surprised" ? 7 : 6} ry={mood === "surprised" ? 7.5 : 6.5} fill="#0b1622" />
            <g className="ghost-pupils" style={{ transform: `translate(${lx}px, ${ly}px)` }}>
              {mood !== "wink" && <circle cx="30.5" cy="34" r="2" fill="#fff" />}
              <circle cx="52.5" cy="34" r="2" fill="#fff" />
            </g>
          </>
        )}
      </g>

      {mood === "happy" || mood === "wink" ? (
        <path d="M33 50 Q40 57 47 50" stroke="#0b1622" strokeWidth="3" fill="none" strokeLinecap="round" />
      ) : mood === "talk" ? (
        <ellipse cx="40" cy="52" rx="4.5" ry="4" fill="#0b1622" className="ghost-mouth-talk" />
      ) : mood === "surprised" ? (
        <ellipse cx="40" cy="54" rx="4.5" ry="6" fill="#0b1622" />
      ) : mood === "curious" ? (
        <ellipse cx="41" cy="53" rx="3.2" ry="3.6" fill="#0b1622" />
      ) : mood === "sleep" ? (
        <ellipse cx="40" cy="52" rx="3" ry="2.4" fill="#0b1622" />
      ) : (
        <path d="M35 51 Q40 54 45 51" stroke="#0b1622" strokeWidth="3" fill="none" strokeLinecap="round" />
      )}

      {mood === "happy" && (
        <g opacity="0.35" fill="#f472b6">
          <ellipse cx="21" cy="46" rx="4" ry="2.2" />
          <ellipse cx="59" cy="46" rx="4" ry="2.2" />
        </g>
      )}
    </svg>
  );
}

/** The original 24px mark (logo, bullets, tiny ghosts). */
export function GhostMark({ className = "", title }: { className?: string; title?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z" />
      <circle cx="9" cy="9" r="1.5" fill="var(--bg, #060a10)" />
      <circle cx="15" cy="9" r="1.5" fill="var(--bg, #060a10)" />
    </svg>
  );
}
