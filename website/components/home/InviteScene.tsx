"use client";

import { motion } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { Stage, StageGhost, useAt } from "./stage";

type Card = { title: string; link: string; qr: string; code: string; forOne: string };

// A fixed pseudo-QR: decoration only, it encodes nothing.
const QR = (() => {
  let s = 11;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const cells: [number, number][] = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const finder = (x < 3 && y < 3) || (x > 5 && y < 3) || (x < 3 && y > 5);
    if (!finder && r() > 0.5) cells.push([x, y]);
  }
  return cells;
})();

function InviteCard({ t }: { t: Card }) {
  return (
    <g>
      <rect x="-86" y="-104" width="172" height="208" rx="18" fill="#0f1823" stroke="#22d3ee" strokeOpacity="0.55" />
      <text x="-66" y="-74" fontSize="15" fontWeight="700" fill="#e8edf5">{t.title}</text>
      <text x="-66" y="-56" fontSize="10" fill="#6b7a90">{t.forOne}</text>
      {/* QR */}
      <g transform="translate(-66 -42)">
        <rect width="62" height="62" rx="6" fill="#e8edf5" />
        {[[0, 0], [42, 0], [0, 42]].map(([x, y]) => (
          <g key={`${x}-${y}`} transform={`translate(${x + 4} ${y + 4})`}>
            <rect width="16" height="16" rx="3" fill="#060a10" />
            <rect x="4" y="4" width="8" height="8" rx="1.5" fill="#e8edf5" />
          </g>
        ))}
        {QR.map(([x, y]) => (
          <rect key={`${x}.${y}`} x={4 + x * 6} y={4 + y * 6} width="5" height="5" rx="1" fill="#060a10" />
        ))}
      </g>
      <text x="6" y="-28" fontSize="9" className="mono" fill="#22d3ee">{t.qr}</text>
      <g transform="translate(-66 32)">
        <rect width="132" height="24" rx="7" fill="#172231" />
        <text x="9" y="16" fontSize="9.5" className="mono" fill="#a3b0c2">app.ghostly.tools/#/chat/…</text>
      </g>
      <text x="-66" y="28" fontSize="9" className="mono" fill="#6b7a90">{t.link}</text>
      <g transform="translate(-66 76)">
        <rect width="132" height="24" rx="7" fill="#172231" />
        <text x="9" y="16" fontSize="9.5" className="mono" fill="#4ade80">pair1/k7Qx…</text>
      </g>
      <text x="-66" y="72" fontSize="9" className="mono" fill="#6b7a90">{t.code}</text>
    </g>
  );
}

function Visual({ card }: { card: Card }) {
  const { p, step } = useScene();
  const cardOpacity = useAt(p, [0.04, 0.16, 0.8, 0.9], [0, 1, 1, 0]);
  const cardScale = useAt(p, [0.04, 0.18, 0.34, 0.5, 0.8, 0.92], [0.6, 1.3, 1.3, 0.95, 0.8, 0.3]);
  const cardX = useAt(p, [0.04, 0.34, 0.66, 0.9], [230, 250, 420, 470]);
  const cardY = useAt(p, [0.04, 0.34, 0.5, 0.66, 0.9], [200, 200, 140, 230, 250]);
  const casperOpacity = useAt(p, [0.3, 0.45], [0, 1]);
  const casperX = useAt(p, [0.3, 0.48], [40, 0]);
  const arc = useAt(p, [0.34, 0.62], [0, 1]);
  const link = useAt(p, [0.72, 0.92], [0, 1]);
  const spark = useAt(p, [0.86, 0.96], [0, 1]);

  return (
    <Stage>
      <defs>
        <linearGradient id="inv-link" x1="160" x2="440" y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#4ade80" />
        </linearGradient>
      </defs>
      {/* the private channel the invite travels through */}
      <motion.path
        d="M150 290 C 240 110, 360 110, 450 290"
        fill="none"
        stroke="#22d3ee"
        strokeOpacity="0.35"
        strokeWidth="2"
        strokeDasharray="4 8"
        style={{ pathLength: arc }}
      />
      <motion.path
        d="M160 390 L440 390"
        fill="none"
        stroke="url(#inv-link)"
        strokeWidth="5"
        strokeLinecap="round"
        style={{ pathLength: link, opacity: link }}
      />
      <motion.g style={{ opacity: spark }}>
        <circle cx="300" cy="390" r="16" fill="#060a10" stroke="#4ade80" strokeWidth="2" />
        <path d="M292 390 l6 6 l11 -12" stroke="#4ade80" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>

      <StageGhost
        x={10}
        y={250}
        size={150}
        who="boo"
        phase={0}
        mood={step === 0 ? "talk" : "happy"}
        look={step === 0 ? { x: 0.8, y: -0.4 } : { x: 1, y: 0 }}
      />
      <StageGhost
        x={440}
        y={250}
        size={150}
        who="casper"
        phase={1}
        mood={step < 2 ? "surprised" : "happy"}
        look={{ x: -1, y: step === 1 ? -0.6 : 0 }}
        style={{ opacity: casperOpacity, x: casperX }}
      />

      <motion.g style={{ x: cardX, y: cardY, scale: cardScale, opacity: cardOpacity }}>
        <InviteCard t={card} />
      </motion.g>
    </Stage>
  );
}

export function InviteScene({ eyebrow, label, steps, card }: { eyebrow: string; label: string; steps: SceneStep[]; card: Card }) {
  return (
    <SceneFrame id="invite" eyebrow={eyebrow} label={label} steps={steps} visual={<Visual card={card} />} stillAt={0.4} />
  );
}
