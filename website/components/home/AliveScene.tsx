"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { StaticActors } from "@/components/story/StaticActors";
import { scatter, Stage, useStep } from "./stage";

type Layout = { x0: number; x1: number; y: number; arc: string; cloud: [number, number, number, number, number]; label: [number, number]; stun: [number, number]; r: number };
const L: Layout = { x0: 900, x1: 1180, y: 520, arc: "M780 360 C 820 180, 1240 180, 1280 360", cloud: [24, 1030, 200, 260, 60], label: [1030, 120], stun: [1030, 740], r: 14 };
const P: Layout = { x0: 70, x1: 320, y: 300, arc: "M60 210 C 90 100, 300 100, 330 210", cloud: [14, 195, 140, 150, 34], label: [195, 96], stun: [195, 440], r: 11 };

const PACKETS: { kind: "chat" | "file" | "bolt" | "cam"; dir: 1 | -1; offset: number }[] = [
  { kind: "chat", dir: 1, offset: 0 },
  { kind: "file", dir: 1, offset: 0.33 },
  { kind: "bolt", dir: -1, offset: 0.15 },
  { kind: "chat", dir: -1, offset: 0.6 },
  { kind: "cam", dir: 1, offset: 0.7 },
];

function Packet({ p, n, kind, dir, offset, C }: { p: MotionValue<number>; n: number; kind: string; dir: 1 | -1; offset: number; C: Layout }) {
  // Scroll drives the flow: a few laps across the pipe while the scene plays; nothing moves when you stop.
  const lap = useStep(p, 1, n, [0.4, 1], [0, 2.4]);
  const t = useTransform(lap, (v) => {
    const f = (v + offset) % 1;
    return dir === 1 ? f : 1 - f;
  });
  const x = useTransform(t, (v) => C.x0 + 24 + v * (C.x1 - C.x0 - 48));
  const spawn = useTransform(t, (v) => {
    const from = dir === 1 ? v : 1 - v;
    return Math.min(1, from / 0.08);
  });
  const on = useStep(p, 1, n, [0.4, 0.48], [0, 1]);
  const color = kind === "bolt" ? "#fbbf24" : kind === "file" ? "#a78bfa" : dir === 1 ? "#22d3ee" : "#4ade80";
  return (
    <motion.g style={{ x, y: C.y, opacity: on, scale: spawn }}>
      <circle r={C.r} fill="#060a10" stroke={color} strokeWidth="2" />
      {kind === "chat" && <path d="M-6 -3.5 h12 v7 h-7 l-3.5 3.5 v-3.5 h-1.5 z" fill={color} />}
      {kind === "file" && <path d="M-4.5 -7 h6 l3.5 3.5 v10.5 h-9.5 z" fill={color} />}
      {kind === "bolt" && <path d="M1.5 -8 L-5 1 H0 L-1.5 8 L5 -1 H0 Z" fill={color} />}
      {kind === "cam" && <path d="M-7 -4.5 h9 v9 h-9 z M2.5 -1 l4.5 -3.5 v9 l-4.5 -3.5 z" fill={color} />}
    </motion.g>
  );
}

function Visual({ labels }: { labels: { pipe: string; thread: string } }) {
  const { p, n, portrait, camera } = useScene();
  const C = portrait ? P : L;
  const cloud = scatter(C.cloud[0], 9, C.cloud[1], C.cloud[2], C.cloud[3], C.cloud[4]);
  // s0: the rendezvous thread above, then it fades. s1: the pipe draws and lights up. s2: STUN below.
  const threadIn = useStep(p, 0, n, [0.05, 0.4], [0, 1]);
  const thread = useStep(p, 1, n, [0, 0.3], [1, 0.18]);
  const cloudFade = useStep(p, 1, n, [0, 0.3], [1, 0.4]);
  const pipe = useStep(p, 1, n, [0.05, 0.4], [0, 1]);
  const pipeW = useStep(p, 1, n, [0.05, 0.4], [0, portrait ? 14 : 20]);
  const core = useTransform(pipeW, (w) => Math.max(0, w - 7));
  const glowW = useTransform(pipeW, (w) => w * 2.4);
  const stun = useStep(p, 2, n, [0.1, 0.35], [0, 1]);
  const ping = useStep(p, 2, n, [0.3, 0.9], [0, 1]);
  const light = useStep(p, 1, n, [0.05, 0.5], [0.05, 0.2]);

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: "#4ade80", opacity: light }}>
      <defs>
        <linearGradient id="alive-pipe" x1={C.x0} x2={C.x1} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#4ade80" />
        </linearGradient>
      </defs>
      <StaticActors chapter="alive" />

      <motion.g style={{ opacity: cloudFade }}>
        {[0, 1, 2].map((bucket) => (
          <g key={bucket} className="dht-node" style={{ animationDelay: `${-bucket * 1.3}s` }}>
            {cloud.filter((_, i) => i % 3 === bucket).map((node, i) => (
              <circle key={i} cx={node.x} cy={node.y} r={2 + node.t * 2} fill="#3b4b63" />
            ))}
          </g>
        ))}
        <text x={C.label[0]} y={C.label[1]} textAnchor="middle" fontSize={portrait ? 11 : 12} letterSpacing="2" fill="#6b7a90" className="mono">
          MAINLINE DHT
        </text>
      </motion.g>

      {/* The rendezvous thread up through the DHT */}
      <motion.path d={C.arc} fill="none" stroke="#22d3ee" strokeWidth="2" strokeDasharray="3 7" style={{ pathLength: threadIn, opacity: thread }} />
      <motion.text x={C.cloud[1]} y={C.cloud[2] + (portrait ? 44 : 62)} textAnchor="middle" fontSize={portrait ? 11 : 12} fill="#22d3ee" className="mono" style={{ opacity: thread }}>
        {labels.thread}
      </motion.text>

      {/* The live connection: glow, tube, dark core, traffic. */}
      <motion.line x1={C.x0} y1={C.y} x2={C.x1} y2={C.y} stroke="url(#alive-pipe)" strokeLinecap="round" strokeOpacity="0.22" style={{ strokeWidth: glowW, pathLength: pipe }} />
      <motion.line x1={C.x0} y1={C.y} x2={C.x1} y2={C.y} stroke="url(#alive-pipe)" strokeLinecap="round" style={{ strokeWidth: pipeW, pathLength: pipe }} />
      <motion.line x1={C.x0 + 8} y1={C.y} x2={C.x1 - 8} y2={C.y} stroke="#060a10" strokeLinecap="round" style={{ strokeWidth: core, pathLength: pipe }} />
      {PACKETS.map((k, i) => (
        <Packet key={i} p={p} n={n} {...k} C={C} />
      ))}
      <motion.text x={(C.x0 + C.x1) / 2} y={C.y + (portrait ? 34 : 46)} textAnchor="middle" fontSize={portrait ? 11 : 13} fill="#e8edf5" className="mono" style={{ opacity: pipe }}>
        {labels.pipe} · WebRTC
      </motion.text>

      {/* STUN helps find a route; it does not carry the conversation. */}
      <motion.g style={{ opacity: stun }}>
        <g transform={`translate(${C.stun[0]} ${C.stun[1]})`}>
          <path d="M0 -20 L-14 12 H14 Z" fill="#172231" stroke="#6b7a90" />
          <circle cy="-26" r="6" fill="#6b7a90" />
          <motion.circle cy="-26" r="6" fill="none" stroke="#6b7a90" style={{ scale: useTransform(ping, (v) => 1 + v * 4), opacity: useTransform(ping, (v) => 1 - v) }} />
          <text y="30" textAnchor="middle" fontSize={portrait ? 11 : 12} fill="#6b7a90" className="mono">
            STUN
          </text>
        </g>
        <path d={`M${C.stun[0] - 6} ${C.stun[1] - 30} Q ${(C.stun[0] + C.x0) / 2 - 60} ${(C.stun[1] + C.y) / 2} ${C.x0 + 20} ${C.y + 16}`} stroke="#6b7a90" strokeDasharray="2 5" fill="none" />
        <path d={`M${C.stun[0] + 6} ${C.stun[1] - 30} Q ${(C.stun[0] + C.x1) / 2 + 60} ${(C.stun[1] + C.y) / 2} ${C.x1 - 20} ${C.y + 16}`} stroke="#6b7a90" strokeDasharray="2 5" fill="none" />
      </motion.g>
    </Stage>
  );
}

export function AliveScene({ eyebrow, label, steps, labels }: { eyebrow: string; label: string; steps: SceneStep[]; labels: { pipe: string; thread: string } }) {
  return <SceneFrame id="alive" chapter="alive" eyebrow={eyebrow} label={label} steps={steps} stills={[0.2, 0.6, 0.86]} copyAt="left" visual={<Visual labels={labels} />} />;
}
