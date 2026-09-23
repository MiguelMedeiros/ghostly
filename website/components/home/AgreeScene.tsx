"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { StaticActors } from "@/components/story/StaticActors";
import { Stage, useStep } from "./stage";

// Real capability identifiers from the paired session code.
const BOO = ["chat/1", "files/2", "payments-cashu/1", "payments-arkade/1", "webrtc/1", "iroh/1", "hyperdht/1"];
const CASPER = ["chat/1", "files/2", "payments-cashu/1", "webrtc/1"];
const SHARED = BOO.filter((c) => CASPER.includes(c));

type Layout = { row: number; tagW: number; font: number; boo: [number, number]; casper: [number, number]; plan: [number, number]; planW: number; planH: number; booRows: string[] };
const L: Layout = { row: 40, tagW: 220, font: 12.5, boo: [640, 310], casper: [1060, 310], plan: [1000, 650], planW: 240, planH: 132, booRows: BOO };
const P: Layout = { row: 34, tagW: 168, font: 11, boo: [12, 230], casper: [210, 230], plan: [195, 330], planW: 210, planH: 116, booRows: BOO.slice(0, 6) };

function Tag({ p, n, x, y, w, font, text, shared, i, side }: { p: MotionValue<number>; n: number; x: number; y: number; w: number; font: number; text: string; shared: boolean; i: number; side: "l" | "r" }) {
  const appear = useStep(p, 0, n, [0.05 + i * 0.07, 0.2 + i * 0.07], [0, 1]);
  const keep = useStep(p, 1, n, [0.1, 0.5], [1, shared ? 1 : 0.28]);
  const fade = useStep(p, 2, n, [0.1, 0.5], [1, 0.25]);
  const opacity = useTransform([appear, keep, fade], ([a, k, f]) => (a as number) * (k as number) * (f as number));
  const glow = useStep(p, 1, n, [0.15 + i * 0.05, 0.4 + i * 0.05], [0, shared ? 1 : 0]);
  const strike = useStep(p, 1, n, [0.2, 0.45], [0, 1]);
  const h = 30;
  return (
    <motion.g style={{ opacity }}>
      <rect x={x} y={y} width={w} height={h} rx="9" fill="#0f1823" stroke="#2b3b52" />
      <motion.rect x={x} y={y} width={w} height={h} rx="9" fill="none" stroke="#4ade80" strokeWidth="1.8" style={{ opacity: glow }} />
      <text x={side === "l" ? x + 12 : x + w - 12} y={y + 19.5} fontSize={font} textAnchor={side === "l" ? "start" : "end"} fill="#e8edf5" className="mono">
        {text}
      </text>
      {!shared && <motion.line x1={x + 10} y1={y + 15} x2={x + w - 10} y2={y + 15} stroke="#6b7a90" strokeWidth="1.4" style={{ pathLength: strike }} />}
    </motion.g>
  );
}

function Visual({ labels }: { labels: { boo: string; casper: string; plan: string } }) {
  const { p, n, portrait, camera } = useScene();
  const C = portrait ? P : L;
  const lines = useStep(p, 1, n, [0.15, 0.6], [0, 1]);
  const linesFade = useStep(p, 2, n, [0.1, 0.5], [1, 0.15]);
  const plan = useStep(p, 2, n, [0.2, 0.5], [0, 1]);
  const planScale = useStep(p, 2, n, [0.2, 0.5], [0.6, 1]);
  const light = useStep(p, 2, n, [0.2, 0.6], [0.05, 0.16]);
  const casperRows = CASPER;
  const booLabelY = C.boo[1] - 14;
  const casperLabelY = C.casper[1] - 14;

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: "#4ade80", opacity: light }}>
      <StaticActors chapter="agree" />
      <text x={C.boo[0]} y={booLabelY} fontSize={portrait ? 11 : 13} fill="#a3b0c2" className="mono">
        {labels.boo}
      </text>
      <text x={C.casper[0] + C.tagW} y={casperLabelY} fontSize={portrait ? 11 : 13} fill="#a3b0c2" textAnchor="end" className="mono">
        {labels.casper}
      </text>

      {SHARED.map((c) => {
        const a = C.booRows.indexOf(c);
        const b = casperRows.indexOf(c);
        if (a < 0 || b < 0) return null;
        const x1 = C.boo[0] + C.tagW;
        const x2 = C.casper[0];
        const y1 = C.boo[1] + a * C.row + 15;
        const y2 = C.casper[1] + b * C.row + 15;
        return <SharedLine key={c} d={`M${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`} lines={lines} fade={linesFade} />;
      })}

      {C.booRows.map((c, i) => (
        <Tag key={c} p={p} n={n} x={C.boo[0]} y={C.boo[1] + i * C.row} w={C.tagW} font={C.font} text={c} shared={SHARED.includes(c)} i={i} side="l" />
      ))}
      {casperRows.map((c, i) => (
        <Tag key={c} p={p} n={n} x={C.casper[0]} y={C.casper[1] + i * C.row} w={C.tagW} font={C.font} text={c} shared i={i + 1} side="r" />
      ))}

      <motion.g style={{ x: C.plan[0], y: C.plan[1], opacity: plan, scale: planScale }}>
        <rect x={-C.planW / 2} y={-C.planH / 2} width={C.planW} height={C.planH} rx="16" fill="#08131a" stroke="#4ade80" strokeWidth="1.5" />
        <text x="0" y={-C.planH / 2 + 26} textAnchor="middle" fontSize={portrait ? 10 : 11} letterSpacing="2" fill="#4ade80" className="mono">
          {labels.plan.toUpperCase()}
        </text>
        {["chat/1 · files/2", "payments-cashu/1", "→ webrtc/1"].map((line, i) => (
          <text key={line} x="0" y={-C.planH / 2 + 54 + i * 24} textAnchor="middle" fontSize={portrait ? 12 : 14} fill="#e8edf5" className="mono">
            {line}
          </text>
        ))}
      </motion.g>
    </Stage>
  );
}

function SharedLine({ d, lines, fade }: { d: string; lines: MotionValue<number>; fade: MotionValue<number> }) {
  const opacity = useTransform([lines, fade], ([l, f]) => (l as number) * (f as number));
  return <motion.path d={d} stroke="#4ade80" strokeWidth="1.8" fill="none" style={{ pathLength: lines, opacity }} />;
}

export function AgreeScene({ eyebrow, label, steps, labels }: { eyebrow: string; label: string; steps: SceneStep[]; labels: { boo: string; casper: string; plan: string } }) {
  return <SceneFrame id="agree" chapter="agree" eyebrow={eyebrow} label={label} steps={steps} stills={[0.3, 0.5, 0.9]} copyAt="left" visual={<Visual labels={labels} />} />;
}
