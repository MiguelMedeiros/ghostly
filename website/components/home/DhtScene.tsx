"use client";

import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { StaticActors } from "@/components/story/StaticActors";
import { scatter, Stage, StageGhost, useStep } from "./stage";

type Layout = {
  nodes: { x: number; y: number; t: number }[];
  edges: [number, number][];
  picks: { x: number; y: number; t: number }[];
  boo: [number, number];
  casper: [number, number];
  clock: [number, number, number];
  shade: [number, number, number];
  reach: number;
};

function layout(portrait: boolean): Layout {
  const nodes = portrait ? scatter(30, 3, 195, 230, 170, 140) : scatter(56, 3, 560, 340, 380, 170);
  const reach = portrait ? 62 : 84;
  const edges: [number, number][] = [];
  nodes.forEach((a, i) => nodes.forEach((b, j) => {
    if (j > i && Math.hypot(a.x - b.x, a.y - b.y) < reach) edges.push([i, j]);
  }));
  const targets: [number, number][] = portrait ? [[80, 130], [200, 90], [320, 180]] : [[300, 230], [560, 190], [820, 280]];
  const picks = targets.map((t) => nodes.reduce((best, n) => (Math.hypot(n.x - t[0], n.y - t[1]) < Math.hypot(best.x - t[0], best.y - t[1]) ? n : best)));
  return portrait
    ? { nodes, edges, picks, boo: [70, 470], casper: [320, 450], clock: [340, 96, 26], shade: [290, 84, 44], reach }
    : { nodes, edges, picks, boo: [275, 700], casper: [775, 690], clock: [1150, 200, 40], shade: [1000, 330, 60], reach };
}

function Record({ p, n, i, from, to, portrait }: { p: MotionValue<number>; n: number; i: number; from: [number, number]; to: { x: number; y: number }; portrait: boolean }) {
  // s1: the record leaves Boo along an arc. s2: its beam lands and it turns green. s3: it fades and desaturates.
  const start = 0.05 + i * 0.12;
  const t = useStep(p, 1, n, [start, start + 0.5], [0, 1]);
  const x = useTransform(t, (v) => from[0] + (to.x - from[0]) * v);
  const y = useTransform(t, (v) => from[1] + (to.y - from[1]) * v - Math.sin(v * Math.PI) * (portrait ? 60 : 120));
  const appear = useStep(p, 1, n, [start - 0.02, start + 0.03], [0, 1]);
  const open = useStep(p, 2, n, [0.2 + i * 0.1, 0.32 + i * 0.1], [0, 1]);
  const pop = useStep(p, 2, n, [0.2 + i * 0.1, 0.26 + i * 0.1, 0.34 + i * 0.1], [1, 1.18, 1]);
  const closed = useTransform(open, (v) => 1 - v);
  const expire = useStep(p, 3, n, [0.15, 0.9], [1, 0.35]);
  const opacity = useTransform([appear, expire], ([a, e]) => (a as number) * (e as number));
  const dash = useStep(p, 3, n, [0.15, 0.9], [0, 14]);
  const w = portrait ? 34 : 44;
  const h = portrait ? 26 : 32;
  return (
    <motion.g style={{ x, y, opacity, scale: pop }}>
      <motion.rect x={-w / 2} y={-h / 2} width={w} height={h} rx="7" fill="#0f1823" stroke="#22d3ee" strokeWidth="1.6" style={{ strokeDasharray: useTransform(dash, (d) => (d > 0 ? `4 ${d}` : "none")) }} />
      <motion.g style={{ opacity: closed }}>
        <rect x="-6" y="-3" width="12" height="9" rx="2" fill="#22d3ee" />
        <path d="M-4 -3 v-3.5 a4 4 0 0 1 8 0 v3.5" stroke="#22d3ee" strokeWidth="1.6" fill="none" />
      </motion.g>
      <motion.path d="M-7 0 l5 5 l9 -10" stroke="#4ade80" strokeWidth="2.6" fill="none" strokeLinecap="round" style={{ opacity: open }} />
      <motion.circle r={w} fill="none" stroke="#4ade80" strokeWidth="1.5" style={{ opacity: useTransform(pop, (v) => (v - 1) * 4), scale: pop }} />
    </motion.g>
  );
}

function Visual({ tags }: { tags: { sealed: string; ttl: string } }) {
  const { p, n, step, portrait, camera } = useScene();
  const Lay = layout(portrait);
  // s0: the network lights up across the whole step, node by node.
  const light = useStep(p, 0, n, [0, 1], [0, 1]);
  // s2: everything that is not one of Boo's records dims; Casper's beams land; a line goes back to Boo.
  const dim = useStep(p, 2, n, [0, 0.2], [1, 0.3]);
  const beams = [useBeam(p, n, 0), useBeam(p, n, 1), useBeam(p, n, 2)];
  const back = useStep(p, 2, n, [0.5, 0.7], [0, 1]);
  const backFade = useStep(p, 3, n, [0, 0.3], [1, 0]);
  const shade = useStep(p, 2, n, [0.78, 0.86, 0.98, 1], [0, 1, 1, 0]);
  const shadeX = useStep(p, 2, n, [0.78, 1], [Lay.shade[0] - 60, Lay.shade[0] + 60]);
  // s3: the clock fills; records fade (inside Record).
  const clockOn = useStep(p, 3, n, [0.02, 0.12], [0, 1]);
  const clock = useStep(p, 3, n, [0.1, 0.9], [0, 1]);
  const keyLight = useStep(p, 2, n, [0.1, 0.5], [0.06, 0.18]);
  const last = Lay.picks[2];

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: "#22d3ee", opacity: keyLight }}>
      <StaticActors chapter="dht" />
      <motion.g style={{ opacity: dim }}>
        {Lay.edges.map(([a, b]) => (
          <Edge key={`${a}-${b}`} a={Lay.nodes[a]} b={Lay.nodes[b]} light={light} />
        ))}
      </motion.g>
      {[0, 1, 2].map((bucket) => (
        <g key={bucket} className="dht-node" style={{ animationDelay: `${-bucket * 1.3}s` }}>
          {Lay.nodes.filter((_, i) => i % 3 === bucket).map((node, i) => (
            <Node key={i} node={node} r={portrait ? 2 + node.t * 2 : 2.4 + node.t * 2.6} picked={Lay.picks.includes(node)} light={light} dim={dim} />
          ))}
        </g>
      ))}

      {/* Casper's invitation tells him where to look. */}
      {Lay.picks.map((node, i) => (
        <Beam key={i} from={Lay.casper} to={node} draw={beams[i]} fade={backFade} />
      ))}
      {/* …and the answer travels back to Boo. */}
      <motion.path d={`M${last.x} ${last.y} Q ${(last.x + Lay.boo[0]) / 2 + 80} ${(last.y + Lay.boo[1]) / 2} ${Lay.boo[0]} ${Lay.boo[1] - 40}`} fill="none" stroke="#4ade80" strokeWidth="2.4" strokeLinecap="round" style={{ pathLength: back, opacity: useTransform([back, backFade], ([b, f]) => (b as number) * (f as number)) }} />

      {Lay.picks.map((node, i) => (
        <Record key={i} p={p} n={n} i={i} from={Lay.boo} to={node} portrait={portrait} />
      ))}

      {/* Someone else passing by sees sealed records they cannot read. */}
      <motion.g style={{ opacity: shade, x: shadeX }}>
        <StageGhost x={0} y={Lay.shade[1]} size={Lay.shade[2]} who="shade" mood="curious" look={{ x: -0.8, y: 0.8 }} phase={2} />
        <g transform={`translate(${Lay.shade[2] * 0.5} ${Lay.shade[1] - 14})`}>
          <rect x="-5" y="-3" width="10" height="8" rx="1.5" fill="#94a3b8" />
          <path d="M-3 -3 v-3 a3 3 0 0 1 6 0 v3" stroke="#94a3b8" strokeWidth="1.5" fill="none" />
        </g>
      </motion.g>

      <motion.g style={{ opacity: clockOn }}>
        <g transform={`translate(${Lay.clock[0]} ${Lay.clock[1]})`}>
          <circle r={Lay.clock[2]} fill="#0d1117" stroke="#1e293b" strokeWidth="6" />
          <motion.circle r={Lay.clock[2]} fill="none" stroke="#fbbf24" strokeWidth="6" strokeLinecap="round" transform="rotate(-90)" style={{ pathLength: clock }} />
          <path d={`M0 ${-Lay.clock[2] * 0.45} V0 L${Lay.clock[2] * 0.3} ${Lay.clock[2] * 0.2}`} stroke="#e8edf5" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <text x="0" y={Lay.clock[2] + 22} textAnchor="middle" fontSize={portrait ? 12 : 14} fill="#fbbf24" className="mono">
            {step >= 3 ? tags.ttl : tags.sealed}
          </text>
        </g>
      </motion.g>
    </Stage>
  );
}

function Beam({ from, to, draw, fade }: { from: [number, number]; to: Node; draw: MotionValue<number>; fade: MotionValue<number> }) {
  const opacity = useTransform([draw, fade], ([d, f]) => (d as number) * (f as number));
  return <motion.line x1={from[0]} y1={from[1]} x2={to.x} y2={to.y} stroke="#4ade80" strokeWidth="1.8" strokeDasharray="3 6" style={{ pathLength: draw, opacity }} />;
}
function useBeam(p: MotionValue<number>, n: number, i: number) {
  return useStep(p, 2, n, [0.18 + i * 0.1, 0.3 + i * 0.1], [0, 1]);
}
type Node = { x: number; y: number; t: number };
function Edge({ a, b, light }: { a: Node; b: Node; light: MotionValue<number> }) {
  const t = Math.max(a.t, b.t);
  const opacity = useTransform(light, (v) => Math.max(0, Math.min(1, (v - t * 0.8) * 5)));
  return <motion.line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#22d3ee" strokeOpacity="0.14" strokeWidth="1" style={{ opacity }} />;
}
function Node({ node, r, picked, light, dim }: { node: Node; r: number; picked: boolean; light: MotionValue<number>; dim: MotionValue<number> }) {
  const opacity = useTransform([light, dim], ([l, d]) => Math.max(0, Math.min(1, ((l as number) - node.t * 0.8) * 5)) * (picked ? 1 : (d as number)));
  return <motion.circle cx={node.x} cy={node.y} r={r} fill={picked ? "#22d3ee" : "#4c5f7a"} style={{ opacity }} />;
}

export function DhtScene({ eyebrow, label, steps, tags }: { eyebrow: string; label: string; steps: SceneStep[]; tags: { sealed: string; ttl: string } }) {
  return <SceneFrame id="dht" chapter="dht" eyebrow={eyebrow} label={label} steps={steps} stills={[0.25, 0.42, 0.68, 0.9]} copyAt="bottom-right" length={76} visual={<Visual tags={tags} />} />;
}
