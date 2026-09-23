"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { scatter, Stage, StageGhost, useAt } from "./stage";

const CLOUD = scatter(26, 9, 300, 110, 210, 70);
const PIPE_Y = 330;
const X0 = 150;
const X1 = 450;

const PACKETS: { kind: "chat" | "file" | "bolt" | "cam"; dir: 1 | -1; offset: number }[] = [
  { kind: "chat", dir: 1, offset: 0 },
  { kind: "file", dir: 1, offset: 0.33 },
  { kind: "bolt", dir: -1, offset: 0.15 },
  { kind: "chat", dir: -1, offset: 0.6 },
  { kind: "cam", dir: 1, offset: 0.7 },
];

function Packet({ p, kind, dir, offset }: { p: MotionValue<number>; kind: string; dir: 1 | -1; offset: number }) {
  // Scroll drives the flow: a few laps across the pipe while the scene plays.
  const t = useTransform(p, (v) => {
    const lap = (Math.max(0, v - 0.36) * 4 + offset) % 1;
    return dir === 1 ? lap : 1 - lap;
  });
  const x = useTransform(t, (v) => X0 + 20 + v * (X1 - X0 - 40));
  const on = useAt(p, [0.36, 0.44], [0, 1]);
  const color = kind === "bolt" ? "#fbbf24" : kind === "file" ? "#a78bfa" : dir === 1 ? "#22d3ee" : "#4ade80";
  return (
    <motion.g style={{ x, y: PIPE_Y, opacity: on }}>
      <circle r="12" fill="#060a10" stroke={color} strokeWidth="1.8" />
      {kind === "chat" && <path d="M-5 -3 h10 v6 h-6 l-3 3 v-3 h-1 z" fill={color} />}
      {kind === "file" && <path d="M-4 -6 h5 l3 3 v9 h-8 z" fill={color} />}
      {kind === "bolt" && <path d="M1 -7 L-4 1 H0 L-1 7 L4 -1 H0 Z" fill={color} />}
      {kind === "cam" && <path d="M-6 -4 h8 v8 h-8 z M2 -1 l4 -3 v8 l-4 -3 z" fill={color} />}
    </motion.g>
  );
}

function Visual({ labels }: { labels: { pipe: string; thread: string } }) {
  const { p, step } = useScene();
  const thread = useAt(p, [0.02, 0.2, 0.4, 0.55], [0, 1, 1, 0.18]);
  const threadLen = useAt(p, [0.02, 0.22], [0, 1]);
  const pipe = useAt(p, [0.3, 0.46], [0, 1]);
  const pipeW = useAt(p, [0.3, 0.46], [0, 18]);
  const stun = useAt(p, [0.7, 0.8], [0, 1]);
  const cloud = useAt(p, [0.3, 0.55], [1, 0.45]);
  const core = useTransform(pipeW, (w) => Math.max(0, w - 6));

  return (
    <Stage>
      <defs>
        <linearGradient id="alive-pipe" x1={X0} x2={X1} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#4ade80" />
        </linearGradient>
        <filter id="alive-blur" x="-20%" y="-200%" width="140%" height="500%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
      </defs>

      <motion.g style={{ opacity: cloud }}>
        {CLOUD.map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r={2 + n.t * 2} fill="#3b4b63" className="dht-node" style={{ animationDelay: `${-n.t * 4}s` }} />
        ))}
        <text x="300" y="30" textAnchor="middle" fontSize="11" letterSpacing="2" fill="#6b7a90" className="mono">
          MAINLINE DHT
        </text>
      </motion.g>

      {/* The rendezvous thread up through the DHT */}
      <motion.path
        d={`M${X0} ${PIPE_Y - 40} C 170 120, 250 90, 300 100 C 350 90, 430 120, ${X1} ${PIPE_Y - 40}`}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.8"
        strokeDasharray="3 7"
        style={{ opacity: thread, pathLength: threadLen }}
      />
      <motion.text x="300" y="78" textAnchor="middle" fontSize="11" fill="#22d3ee" className="mono" style={{ opacity: thread }}>
        {labels.thread}
      </motion.text>

      {/* The live connection */}
      <motion.line x1={X0} y1={PIPE_Y} x2={X1} y2={PIPE_Y} stroke="url(#alive-pipe)" strokeLinecap="round" filter="url(#alive-blur)" style={{ strokeWidth: pipeW, opacity: pipe }} />
      <motion.line x1={X0} y1={PIPE_Y} x2={X1} y2={PIPE_Y} stroke="url(#alive-pipe)" strokeLinecap="round" style={{ strokeWidth: pipeW, opacity: pipe }} />
      <motion.line x1={X0 + 8} y1={PIPE_Y} x2={X1 - 8} y2={PIPE_Y} stroke="#060a10" strokeLinecap="round" style={{ strokeWidth: core, opacity: pipe }} />
      {PACKETS.map((k, i) => (
        <Packet key={i} p={p} {...k} />
      ))}
      <motion.text x="300" y={PIPE_Y + 42} textAnchor="middle" fontSize="12" fill="#e8edf5" className="mono" style={{ opacity: pipe }}>
        {labels.pipe} · WebRTC
      </motion.text>

      {/* STUN helps find a route; it does not carry the conversation. */}
      <motion.g style={{ opacity: stun }}>
        <path d="M300 470 L286 500 H314 Z" fill="#172231" stroke="#6b7a90" />
        <circle cx="300" cy="464" r="6" fill="#6b7a90" />
        <path d={`M296 460 Q 230 420 ${X0 + 20} ${PIPE_Y + 20}`} stroke="#6b7a90" strokeDasharray="2 5" fill="none" />
        <path d={`M304 460 Q 370 420 ${X1 - 20} ${PIPE_Y + 20}`} stroke="#6b7a90" strokeDasharray="2 5" fill="none" />
        <text x="300" y="516" textAnchor="middle" fontSize="10.5" fill="#6b7a90" className="mono">
          STUN
        </text>
      </motion.g>

      <StageGhost x={X0 - 118} y={PIPE_Y - 70} size={104} who="boo" phase={0} mood={step === 0 ? "calm" : "talk"} look={{ x: 1, y: step === 0 ? -1 : 0 }} />
      <StageGhost x={X1 + 14} y={PIPE_Y - 70} size={104} who="casper" phase={1} mood={step === 0 ? "calm" : "happy"} look={{ x: -1, y: step === 0 ? -1 : 0 }} />
    </Stage>
  );
}

export function AliveScene({ eyebrow, label, steps, labels }: { eyebrow: string; label: string; steps: SceneStep[]; labels: { pipe: string; thread: string } }) {
  return <SceneFrame id="alive" eyebrow={eyebrow} label={label} steps={steps} visual={<Visual labels={labels} />} flip stillAt={0.6} />;
}
