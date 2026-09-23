"use client";

import { motion, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { Stage, StageGhost, useAt } from "./stage";

// Real capability identifiers from the paired session code.
const BOO = ["chat/1", "files/2", "payments-cashu/1", "payments-arkade/1", "webrtc/1", "iroh/1", "hyperdht/1"];
const CASPER = ["chat/1", "files/2", "payments-cashu/1", "webrtc/1"];
const SHARED = BOO.filter((c) => CASPER.includes(c));
const ROW = 40;
const TOP = 150;

function Tag({ x, y, text, shared, p, i, side }: { x: number; y: number; text: string; shared: boolean; p: MotionValue<number>; i: number; side: "l" | "r" }) {
  const opacity = useAt(p, [0.02 + i * 0.03, 0.1 + i * 0.03, 0.36, 0.48], [0, 1, 1, shared ? 1 : 0.28]);
  const glow = useAt(p, [0.38, 0.5], [0, shared ? 1 : 0]);
  const strike = useAt(p, [0.4, 0.5], [0, 1]);
  return (
    <motion.g style={{ opacity }}>
      <rect x={x} y={y} width="150" height="30" rx="9" fill="#0f1823" stroke="#2b3b52" />
      <motion.rect x={x} y={y} width="150" height="30" rx="9" fill="none" stroke="#4ade80" strokeWidth="1.6" style={{ opacity: glow }} />
      <text x={side === "l" ? x + 12 : x + 138} y={y + 19.5} fontSize="11.5" textAnchor={side === "l" ? "start" : "end"} fill="#e8edf5" className="mono">
        {text}
      </text>
      {!shared && (
        <motion.line x1={x + 10} y1={y + 15} x2={x + 140} y2={y + 15} stroke="#6b7a90" strokeWidth="1.2" style={{ opacity: strike }} />
      )}
    </motion.g>
  );
}

function Visual({ labels }: { labels: { boo: string; casper: string; plan: string } }) {
  const { p, step } = useScene();
  const lines = useAt(p, [0.36, 0.56], [0, 1]);
  const linesFade = useAt(p, [0.36, 0.44, 0.7, 0.8], [0, 1, 1, 0.25]);
  const plan = useAt(p, [0.68, 0.8], [0, 1]);
  const planY = useAt(p, [0.68, 0.8], [20, 0]);

  return (
    <Stage viewBox="0 0 600 520">
      <StageGhost x={60} y={20} size={70} who="boo" phase={0} mood={step === 2 ? "happy" : "calm"} look={{ x: 0.6, y: 0.8 }} />
      <text x="36" y="132" fontSize="12" fill="#a3b0c2" className="mono">{labels.boo}</text>
      <StageGhost x={466} y={20} size={70} who="casper" phase={1} mood={step === 2 ? "happy" : "calm"} look={{ x: -0.6, y: 0.8 }} />
      <text x="564" y="132" fontSize="12" fill="#a3b0c2" textAnchor="end" className="mono">{labels.casper}</text>

      {SHARED.map((c) => {
        const a = BOO.indexOf(c);
        const b = CASPER.indexOf(c);
        return (
          <motion.path
            key={c}
            d={`M186 ${TOP + a * ROW + 15} C 300 ${TOP + a * ROW + 15}, 300 ${TOP + b * ROW + 15}, 414 ${TOP + b * ROW + 15}`}
            stroke="#4ade80"
            strokeWidth="1.8"
            fill="none"
            style={{ pathLength: lines, opacity: linesFade }}
          />
        );
      })}

      {BOO.map((c, i) => (
        <Tag key={c} x={36} y={TOP + i * ROW} text={c} shared={SHARED.includes(c)} p={p} i={i} side="l" />
      ))}
      {CASPER.map((c, i) => (
        <Tag key={c} x={414} y={TOP + i * ROW} text={c} shared p={p} i={i + 2} side="r" />
      ))}

      <motion.g style={{ opacity: plan, y: planY }}>
        <rect x="196" y="352" width="208" height="126" rx="16" fill="#08131a" stroke="#4ade80" strokeWidth="1.5" />
        <text x="300" y="378" textAnchor="middle" fontSize="11" letterSpacing="2" fill="#4ade80" className="mono">
          {labels.plan.toUpperCase()}
        </text>
        {["chat/1 · files/2", "payments-cashu/1", "→ webrtc/1"].map((line, i) => (
          <text key={line} x="300" y={404 + i * 22} textAnchor="middle" fontSize="13" fill="#e8edf5" className="mono">
            {line}
          </text>
        ))}
      </motion.g>
    </Stage>
  );
}

export function AgreeScene({ eyebrow, label, steps, labels }: { eyebrow: string; label: string; steps: SceneStep[]; labels: { boo: string; casper: string; plan: string } }) {
  return <SceneFrame id="agree" eyebrow={eyebrow} label={label} steps={steps} visual={<Visual labels={labels} />} stillAt={1} />;
}
