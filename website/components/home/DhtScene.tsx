"use client";

import { useId } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { StaticActors } from "@/components/story/StaticActors";
import { ease, PAIR } from "@/lib/motion";
import { scatter, Stage, StageGhost, useStep } from "./stage";

type Pt = [number, number];
type Peer = { x: number; y: number; t: number };
type Layout = {
  nodes: Peer[];
  edges: [number, number][];
  /** The three peers Boo's records land on, left to right. */
  picks: Peer[];
  /** Which of them Casper reads: the one nearest him. It is never shown sealed. */
  read: number;
  /** Where the records leave Boo (his right side, at the hem). */
  hand: Pt;
  /** One quadratic control point per record: the arc it flies along. */
  bends: Pt[];
  /** Casper's head: where his query rings start. */
  head: Pt;
  /** The rings' final radius. */
  ring: number;
  /** Casper's right hand, where the address he reads arrives, and the bend of that path. */
  catch: Pt;
  catchBend: Pt;
  /** The ground line between the two hems: x1, x2, y. */
  ground: [number, number, number];
  /** The passer-by's drift, size, and where its padlock and tag sit (relative to its top-left). */
  shade: { from: Pt; to: Pt; size: number; tag: Pt };
  clock: [number, number, number];
  caption: Pt;
  record: [number, number];
};

// Casper's query: three rings leave his head this far into step 2 (fractions of the step).
const RING = { start: 0.04, gap: 0.06, dur: 0.34, count: 3 };
// The rings only travel over the network: this wedge (degrees, y down) from Casper's head, feathered.
const FAN: [number, number] = [-165, -55];
// The feather: the wedge is drawn this many times, each a little wider and faint, instead of a blur filter
// (a filtered mask is re-rendered on every frame the rings move).
const FEATHER_STEPS = 6;
// The passer-by crosses the network over this part of step 2, once the two hems are joined.
const SHADE: [number, number] = [0.72, 0.92];
// A record shows only its seal while the passer-by's centre is within 1.5 sizes; the swap happens by 1.85.
const SEAL_REACH: [number, number] = [1.5, 1.85];
// The network's name is the same in every locale.
const CAPTION = "MAINLINE DHT";

function layout(portrait: boolean): Layout {
  const nodes = portrait ? scatter(30, 3, 195, 230, 170, 140) : scatter(56, 3, 560, 340, 380, 170);
  const reach = portrait ? 62 : 84;
  const edges: [number, number][] = [];
  nodes.forEach((a, i) => nodes.forEach((b, j) => {
    if (j > i && Math.hypot(a.x - b.x, a.y - b.y) < reach) edges.push([i, j]);
  }));
  // Three well-separated places in an arc across the network's upper half, clear of both faces and,
  // after the camera push, of the nav on 2:1 viewports.
  const targets: Pt[] = portrait ? [[112, 233], [225, 160], [294, 210]] : [[330, 250], [540, 240], [780, 290]];
  const picks = targets.map((t) => nodes.reduce((best, n) => (Math.hypot(n.x - t[0], n.y - t[1]) < Math.hypot(best.x - t[0], best.y - t[1]) ? n : best)));
  const head: Pt = portrait ? [320, 384] : [685, 628];
  const read = picks.map((k) => Math.hypot(k.x - head[0], k.y - head[1])).reduce((best, d, i, ds) => (d < ds[best] ? i : best), 0);
  return portrait
    ? {
        nodes, edges, picks, read, head,
        hand: [122, 432], bends: [[170, 330], [150, 280], [200, 320]],
        ring: 330, catch: [270, 436], catchBend: [248, 330],
        ground: [118, 272, 443],
        shade: { from: [10, 252], to: [160, 252], size: 46, tag: [54, 16] },
        clock: [350, 162, 20], caption: [195, 400], record: [34, 26],
      }
    : {
        nodes, edges, picks, read, head,
        hand: [345, 688], bends: [[440, 450], [420, 380], [520, 430]],
        ring: 640, catch: [748, 690], catchBend: [752, 480],
        ground: [345, 625, 702],
        shade: { from: [200, 300], to: [400, 300], size: 60, tag: [68, 22] },
        clock: [1090, 232, 40], caption: [560, 548], record: [44, 32],
      };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => v * v * (3 - 2 * v);
const quad = (a: Pt, c: Pt, b: Pt, t: number): Pt => [
  (1 - t) ** 2 * a[0] + 2 * t * (1 - t) * c[0] + t * t * b[0],
  (1 - t) ** 2 * a[1] + 2 * t * (1 - t) * c[1] + t * t * b[1],
];
const quadPath = (a: Pt, c: Pt, b: Pt) => `M${a[0]} ${a[1]} Q ${c[0]} ${c[1]} ${b[0]} ${b[1]}`;
/** A wedge from `o` between two angles (degrees, y down), for masking the rings to the network side. */
function fanPath(o: Pt, R: number, a0: number, a1: number) {
  const pt = (deg: number): Pt => {
    const a = (deg * Math.PI) / 180;
    return [Math.round((o[0] + Math.cos(a) * R) * 100) / 100, Math.round((o[1] + Math.sin(a) * R) * 100) / 100];
  };
  const [x0, y0] = pt(a0);
  const [x1, y1] = pt(a1);
  return `M${o[0]} ${o[1]} L${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} Z`;
}
/** The step-2 fraction at which Casper's first ring reaches a point. */
const ringHits = (L: Layout, at: Pt) => RING.start + (RING.dur * Math.hypot(at[0] - L.head[0], at[1] - L.head[1])) / L.ring;

function Record({ p, n, i, L, shadeX, shadeOn }: { p: MotionValue<number>; n: number; i: number; L: Layout; shadeX: MotionValue<number>; shadeOn: MotionValue<number> }) {
  const to: Pt = [L.picks[i].x, L.picks[i].y];
  const readable = i === L.read;
  // s1: the record leaves Boo's hand along its arc, one after the other.
  const start = 0.08 + i * 0.14;
  const t = useStep(p, 1, n, [start, start + 0.34], [0, 1], ease.move);
  const x = useTransform(t, (v) => quad(L.hand, L.bends[i], to, smooth(v))[0]);
  const y = useTransform(t, (v) => quad(L.hand, L.bends[i], to, smooth(v))[1]);
  const appear = useStep(p, 1, n, [start - 0.02, start + 0.04], [0, 1]);
  // s2: it opens the moment Casper's first ring reaches it: the seal leaves, the frame turns green, then the check lands.
  const hit = ringHits(L, to);
  const open = useStep(p, 2, n, [hit - 0.01, hit + 0.01], [0, 1]);
  const check = useStep(p, 2, n, [hit + 0.01, hit + 0.03], [0, 1]);
  const pop = useStep(p, 2, n, [hit - 0.01, hit + 0.03, hit + 0.1], [1, 1.2, 1], ease.enter);
  // While the passer-by is near, the record shows only its seal: the check leaves first, then the grey lock
  // arrives (a sequence, never a blend). The record Casper is reading stays open.
  const grey = useTransform([shadeX, shadeOn], ([sx, on]) => {
    if (readable) return 0;
    const s = L.shade.size;
    const d = Math.hypot((sx as number) + s / 2 - to[0], L.shade.from[1] + s * 0.6 - to[1]);
    return (on as number) * smooth(clamp01((s * SEAL_REACH[1] - d) / (s * (SEAL_REACH[1] - SEAL_REACH[0]))));
  });
  const sealIn = useTransform(grey, (g) => clamp01(2 * g - 1));
  const checkOpacity = useTransform([check, grey], ([c, g]) => (c as number) * clamp01(1 - 2 * (g as number)));
  const cyanLock = useTransform(open, (o) => 1 - o);
  // s3: it ages out.
  const expire = useStep(p, 3, n, [0.15, 0.7], [1, 0.35]);
  const dash = useStep(p, 3, n, [0.15, 0.7], [0, 14]);
  const opacity = useTransform([appear, expire], ([a, e]) => (a as number) * (e as number));
  const dasharray = useTransform(dash, (d) => (d > 0 ? `4 ${d}` : "none"));
  const [w, h] = L.record;
  const lock = (color: string) => (
    <>
      <rect x="-6" y="-3" width="12" height="9" rx="2" fill={color} />
      <path d="M-4 -3 v-3.5 a4 4 0 0 1 8 0 v3.5" stroke={color} strokeWidth="1.6" fill="none" />
    </>
  );
  return (
    <motion.g style={{ x, y, opacity, scale: pop }}>
      <motion.rect x={-w / 2} y={-h / 2} width={w} height={h} rx="7" fill="#0f1823" stroke="#22d3ee" strokeWidth="1.6" style={{ strokeDasharray: dasharray }} />
      <motion.rect x={-w / 2} y={-h / 2} width={w} height={h} rx="7" fill="none" stroke="#4ade80" strokeWidth="1.6" style={{ strokeDasharray: dasharray, opacity: open }} />
      <motion.rect x={-w / 2} y={-h / 2} width={w} height={h} rx="7" fill="none" stroke="#94a3b8" strokeWidth="1.6" style={{ strokeDasharray: dasharray, opacity: sealIn }} />
      <motion.g style={{ opacity: cyanLock }}>{lock("#22d3ee")}</motion.g>
      <motion.g style={{ opacity: sealIn }}>{lock("#94a3b8")}</motion.g>
      <motion.path d="M-7 0 l5 5 l9 -10" stroke="#4ade80" strokeWidth="2.6" fill="none" strokeLinecap="round" style={{ opacity: checkOpacity }} />
      <motion.circle r={w} fill="none" stroke="#4ade80" strokeWidth="1.5" style={{ opacity: useTransform(pop, (v) => (v - 1) * 4) }} />
    </motion.g>
  );
}

/** One of Casper's query rings: it grows from his head and thins out as it goes. */
function Ring({ p, n, i, L }: { p: MotionValue<number>; n: number; i: number; L: Layout }) {
  const s = RING.start + i * RING.gap;
  const r = useStep(p, 2, n, [s, s + RING.dur], [0, L.ring], ease.exit);
  const opacity = useStep(p, 2, n, [s, s + 0.03, s + RING.dur], [0, 0.55, 0]);
  return <motion.circle cx={L.head[0]} cy={L.head[1]} fill="none" stroke="#4ade80" strokeWidth="1.5" style={{ r, opacity }} />;
}

function Visual({ tags }: { tags: { sealed: string; ttl: string } }) {
  const { p, n, portrait, camera } = useScene();
  const id = useId().replace(/:/g, "");
  const L = layout(portrait);
  // s0: the network lights up node by node over the action; its name settles under it.
  const light = useStep(p, 0, n, [0.04, 0.7], [0, 1]);
  const captionIn = useStep(p, 0, n, [0.5, 0.7], [0, 1]);
  const captionOut = useStep(p, 1, n, [0, 0.1], [1, 0]);
  const caption = useTransform([captionIn, captionOut], ([a, b]) => (a as number) * (b as number));
  // s2: the rest of the network steps back; Casper asks it (Ring); the nearest record's address comes to his hand;
  // then a ground line joins the two hems (complete by .8, so the reduced-motion still shows it whole).
  // A passer-by crosses the network meanwhile.
  // One after the other: the rings (.04 to .46), the address to his hand, the ground line, then the passer-by.
  const dim = useStep(p, 2, n, [0, 0.2], [1, 0.45]);
  const near = L.picks[L.read];
  const read = useStep(p, 2, n, [0.44, 0.56], [0, 1], ease.move);
  const readFade = useStep(p, 3, n, [0, 0.2], [1, 0]);
  const readOpacity = useTransform([read, readFade], ([r, f]) => (r as number) * (f as number));
  const meet = useStep(p, 2, n, [0.56, 0.68], [0, 1], ease.move);
  const shadeOn = useStep(p, 2, n, [SHADE[0], SHADE[0] + 0.04, SHADE[1] - 0.04, SHADE[1]], [0, 1, 1, 0]);
  const shadeX = useStep(p, 2, n, SHADE, [L.shade.from[0], L.shade.to[0]], ease.move);
  const keyLight = useStep(p, 2, n, [0.1, 0.5], [0.06, 0.18]);
  // s3: the clock fills; records fade (inside Record).
  const clockOn = useStep(p, 3, n, [0.04, 0.14], [0, 1]);
  const clock = useStep(p, 3, n, [0.12, 0.7], [0, 1], ease.move);
  const [cx, cy, cr] = L.clock;
  // The rings' mask: the wedge over the network, feathered so their ends fade out instead of stopping.
  const fanR = L.ring + 120;
  const feather = portrait ? 8 : 12;
  const maskBox = { x: L.head[0] - fanR - 3 * feather, y: L.head[1] - fanR - 3 * feather, width: 2 * (fanR + 3 * feather), height: fanR + 6 * feather };

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: "#22d3ee", opacity: keyLight }}>
      <defs>
        <mask id={`dht-fan-${id}`} maskUnits="userSpaceOnUse" {...maskBox}>
          {Array.from({ length: FEATHER_STEPS }, (_, i) => (
            <path key={i} d={fanPath(L.head, fanR, FAN[0] - i * feather * 0.5, FAN[1] + i * feather * 0.5)} fill="#fff" fillOpacity={0.3} />
          ))}
        </mask>
        <linearGradient id={`dht-meet-${id}`} x1={L.ground[0]} x2={L.ground[1]} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#4ade80" />
        </linearGradient>
      </defs>
      <StaticActors chapter="dht" />
      <motion.g style={{ opacity: dim }}>
        {L.edges.map(([a, b]) => (
          <Edge key={`${a}-${b}`} a={L.nodes[a]} b={L.nodes[b]} light={light} />
        ))}
      </motion.g>
      {[0, 1, 2].map((bucket) => (
        <g key={bucket} className="dht-node" style={{ animationDelay: `${-bucket * 1.3}s` }}>
          {L.nodes.filter((_, i) => i % 3 === bucket).map((node, i) => (
            <Node key={i} node={node} r={portrait ? 2.4 + node.t * 1.8 : 3 + node.t * 2.5} picked={L.picks.includes(node)} light={light} dim={dim} />
          ))}
        </g>
      ))}
      <motion.text x={L.caption[0]} y={L.caption[1]} textAnchor="middle" fontSize={portrait ? 11 : 13} fill="#7c8ba1" className="mono" style={{ opacity: caption, letterSpacing: "0.14em" }}>
        {CAPTION}
      </motion.text>

      {/* Casper asks the network: rings from his head, over the network only, their ends feathered. */}
      <g mask={`url(#dht-fan-${id})`}>
        {Array.from({ length: RING.count }, (_, i) => (
          <Ring key={i} p={p} n={n} i={i} L={L} />
        ))}
      </g>
      {/* The address he reads, from the record nearest him to his hand. */}
      <motion.path d={quadPath([near.x, near.y], L.catchBend, L.catch)} fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" style={{ pathLength: read, opacity: readOpacity }} />
      <motion.circle cx={L.catch[0]} cy={L.catch[1]} r={portrait ? 3 : 4} fill="#4ade80" style={{ opacity: useTransform(read, (v) => (v >= 1 ? 1 : 0)), scale: useTransform(readFade, (v) => v) }} />
      {/* Now they can reach each other. */}
      <motion.line x1={L.ground[0]} y1={L.ground[2]} x2={L.ground[1]} y2={L.ground[2]} stroke={`url(#dht-meet-${id})`} strokeWidth={portrait ? 2.5 : 3} strokeLinecap="round" style={{ pathLength: meet, opacity: meet }} />

      {L.picks.map((_, i) => (
        <Record key={i} p={p} n={n} i={i} L={L} shadeX={shadeX} shadeOn={shadeOn} />
      ))}

      {/* Someone else passing by sees sealed records they cannot read. */}
      <motion.g style={{ opacity: shadeOn, x: shadeX }}>
        <StageGhost x={0} y={L.shade.from[1]} size={L.shade.size} who="shade" mood="curious" look={{ x: 0.3, y: 0.1 }} phase={2} />
        <g transform={`translate(${L.shade.tag[0]} ${L.shade.from[1] + L.shade.tag[1]})`}>
          <rect x="-5" y="-3" width="10" height="8" rx="1.5" fill="#94a3b8" />
          <path d="M-3 -3 v-3 a3 3 0 0 1 6 0 v3" stroke="#94a3b8" strokeWidth="1.5" fill="none" />
          <text x="11" y="4" fontSize={portrait ? 11 : 12} fill="#94a3b8" className="mono">
            {tags.sealed}
          </text>
        </g>
      </motion.g>

      <motion.g style={{ opacity: clockOn }}>
        <g transform={`translate(${cx} ${cy})`}>
          <circle r={cr} fill="#0d1117" stroke="#1e293b" strokeWidth={portrait ? 4 : 6} />
          <motion.circle r={cr} fill="none" stroke="#fbbf24" strokeWidth={portrait ? 4 : 6} strokeLinecap="round" transform="rotate(-90)" style={{ pathLength: clock }} />
          <path d={`M0 ${-cr * 0.45} V0 L${cr * 0.3} ${cr * 0.2}`} stroke="#e8edf5" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* The label sits under the dial on landscape; on phones, to its left, clear of the third record. */}
          <text x={portrait ? -(cr + 10) : 0} y={portrait ? 4 : cr + 22} textAnchor={portrait ? "end" : "middle"} fontSize={portrait ? 11 : 14} fill="#fbbf24" className="mono">
            {tags.ttl}
          </text>
        </g>
      </motion.g>
    </Stage>
  );
}

function Edge({ a, b, light }: { a: Peer; b: Peer; light: MotionValue<number> }) {
  const t = Math.max(a.t, b.t);
  const opacity = useTransform(light, (v) => Math.max(0, Math.min(1, (v - t * 0.8) * 5)));
  // The app's mesh (pairing-scene.css .ps-mesh): a dotted line in the mesh tone.
  return <motion.line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={PAIR.mesh} strokeWidth={PAIR.stroke.mesh} strokeDasharray={PAIR.meshDash} strokeLinecap="round" style={{ opacity }} />;
}
function Node({ node, r, picked, light, dim }: { node: Peer; r: number; picked: boolean; light: MotionValue<number>; dim: MotionValue<number> }) {
  const opacity = useTransform([light, dim], ([l, d]) => Math.max(0, Math.min(1, ((l as number) - node.t * 0.8) * 5)) * (picked ? 1 : (d as number)));
  // The app's nodes (.ps-node): the node colour ringed in the mesh tone; the ones holding a record lit in the accent.
  return <motion.circle cx={node.x} cy={node.y} r={r} fill={picked ? "#22d3ee" : PAIR.node} stroke={picked ? "#22d3ee" : PAIR.dot} strokeWidth={PAIR.stroke.node} style={{ opacity }} />;
}

export function DhtScene({ eyebrow, label, steps, tags }: { eyebrow: string; label: string; steps: SceneStep[]; tags: { sealed: string; ttl: string } }) {
  return <SceneFrame id="dht" chapter="dht" eyebrow={eyebrow} label={label} steps={steps} stills={[0.22, 0.4, 0.66, 0.88]} copyAt="bottom-right" length={76} visual={<Visual tags={tags} />} />;
}
