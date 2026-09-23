"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { scatter, Stage, StageGhost, useAt } from "./stage";

const NODES = scatter(46, 3, 300, 210, 250, 170);
// Where Boo's records land: three distinct, far-apart nodes.
const PICKS = [
  { x: 150, y: 130 },
  { x: 320, y: 70 },
  { x: 470, y: 230 },
].map((t) => NODES.reduce((best, n) => (Math.hypot(n.x - t.x, n.y - t.y) < Math.hypot(best.x - t.x, best.y - t.y) ? n : best)));
const EDGES = (() => {
  const edges: [number, number][] = [];
  NODES.forEach((a, i) => {
    NODES.forEach((b, j) => {
      if (j <= i) return;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 78) edges.push([i, j]);
    });
  });
  return edges;
})();

const BOO = { x: 70, y: 440 };
const CASPER = { x: 530, y: 440 };

function Record({ p, i, target }: { p: MotionValue<number>; i: number; target: { x: number; y: number } }) {
  const start = 0.27 + i * 0.05;
  const x = useAt(p, [start, start + 0.12], [BOO.x, target.x]);
  const y = useAt(p, [start, start + 0.06, start + 0.12], [BOO.y - 20, Math.min(BOO.y, target.y) - 70, target.y]);
  const appear = useAt(p, [start - 0.01, start + 0.02, 0.8, 0.95], [0, 1, 1, 0]);
  const open = useAt(p, [0.55 + i * 0.03, 0.62 + i * 0.03], [0, 1]);
  const closed = useTransform(open, (v) => 1 - v);
  return (
    <motion.g style={{ x, y, opacity: appear }}>
      <rect x="-15" y="-11" width="30" height="22" rx="5" fill="#0f1823" stroke="#22d3ee" strokeWidth="1.5" />
      <motion.g style={{ opacity: closed }}>
        <rect x="-5" y="-3" width="10" height="8" rx="1.5" fill="#22d3ee" />
        <path d="M-3 -3 v-3 a3 3 0 0 1 6 0 v3" stroke="#22d3ee" strokeWidth="1.5" fill="none" />
      </motion.g>
      <motion.path d="M-6 0 l4 4 l8 -8" stroke="#4ade80" strokeWidth="2.4" fill="none" strokeLinecap="round" style={{ opacity: open }} />
    </motion.g>
  );
}

function Visual({ tags }: { tags: { sealed: string; ttl: string } }) {
  const { p, step } = useScene();
  const net = useAt(p, [0, 0.12], [0.15, 1]);
  const beams = useAt(p, [0.5, 0.62, 0.8, 0.92], [0, 1, 1, 0.2]);
  const clock = useAt(p, [0.76, 0.98], [0, 1]);
  const clockOn = useAt(p, [0.72, 0.78], [0, 1]);
  const passerby = useAt(p, [0.52, 0.6, 0.78, 0.86], [0, 1, 1, 0]);
  const casper = useAt(p, [0.45, 0.55], [0.35, 1]);

  return (
    <Stage>
      <defs>
        <radialGradient id="dht-glow" cx="50%" cy="45%" r="55%">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.12" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="300" cy="210" rx="290" ry="200" fill="url(#dht-glow)" />
      <motion.g style={{ opacity: net }}>
        {EDGES.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y} stroke="#1e293b" strokeWidth="1" />
        ))}
        {NODES.map((n, i) => (
          <circle
            key={i}
            cx={n.x}
            cy={n.y}
            r={2.2 + n.t * 2.2}
            fill={PICKS.includes(n) ? "#22d3ee" : "#3b4b63"}
            className="dht-node"
            style={{ animationDelay: `${-n.t * 4}s` }}
          />
        ))}
      </motion.g>

      {/* Casper's invitation tells him where to look. */}
      {PICKS.map((n, i) => (
        <motion.line
          key={i}
          x1={CASPER.x}
          y1={CASPER.y - 20}
          x2={n.x}
          y2={n.y}
          stroke="#4ade80"
          strokeWidth="1.6"
          strokeDasharray="3 6"
          style={{ opacity: beams }}
        />
      ))}

      {PICKS.map((n, i) => (
        <Record key={i} p={p} i={i} target={n} />
      ))}

      <motion.g style={{ opacity: passerby }}>
        <StageGhost x={470} y={40} size={46} who="shade" mood="curious" look={{ x: -1, y: 0.6 }} phase={2} />
        <text x="432" y="36" fontSize="16" fill="#6b7a90" className="mono">? ?</text>
        <text x="410" y="112" fontSize="10" fill="#6b7a90" className="mono">{tags.sealed}</text>
      </motion.g>

      <motion.g style={{ opacity: clockOn }}><g transform="translate(70 70)">
        <circle r="30" fill="#0d1117" stroke="#1e293b" strokeWidth="6" />
        <motion.circle r="30" fill="none" stroke="#fbbf24" strokeWidth="6" strokeLinecap="round" transform="rotate(-90)" style={{ pathLength: clock }} />
        <path d="M0 -14 V0 L9 6" stroke="#e8edf5" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <text x="0" y="52" textAnchor="middle" fontSize="11" fill="#fbbf24" className="mono">{tags.ttl}</text>
      </g></motion.g>

      <StageGhost
        x={BOO.x - 50}
        y={BOO.y - 70}
        size={84}
        who="boo"
        phase={0}
        mood={step === 1 ? "talk" : step === 3 ? "calm" : "happy"}
        look={step === 1 ? { x: 0.6, y: -1 } : { x: 0.8, y: -0.3 }}
      />
      <StageGhost
        x={CASPER.x - 34}
        y={CASPER.y - 70}
        size={84}
        who="casper"
        phase={1}
        mood={step === 2 ? "happy" : "curious"}
        look={step >= 2 ? { x: -0.6, y: -1 } : { x: -1, y: 0 }}
        style={{ opacity: casper }}
      />
    </Stage>
  );
}

export function DhtScene({ eyebrow, label, steps, tags }: { eyebrow: string; label: string; steps: SceneStep[]; tags: { sealed: string; ttl: string } }) {
  return <SceneFrame id="dht" eyebrow={eyebrow} label={label} steps={steps} visual={<Visual tags={tags} />} flip stillAt={0.66} />;
}
