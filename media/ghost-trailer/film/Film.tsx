// The trailer's picture: a ghost story about how two Ghostly apps find each other. Everything is drawn from `t`, the
// film's time in seconds, and every moment is tied to a word of the narration (../out/timeline.json), so the picture
// moves when the voice says so. One thing moves at a time, on soft eases; nothing pulses on a beat.
import type { CSSProperties, ReactNode } from "react";
import timeline from "../out/timeline.json";
import { GHOST_PATH } from "../../../website/components/ghost/path";
import { clamp, ease, lerp, prog } from "./motion";
import { along, BOO, CASPER, EDGES, NODES, NOTE_AT, packet, PEEKERS, REPLY_AT, ROUTE_LOOK, ROUTE_NOTE, ROUTE_REPLY, seeded, type P } from "./world";

export const FORMATS = { "16x9": [1920, 1080], "9x16": [1080, 1920], "1x1": [1080, 1080] } as const;
export type Format = keyof typeof FORMATS;

// The narration's moments.
type Line = (typeof timeline.lines)[number];
const line = (id: string): Line => { const l = timeline.lines.find((x) => x.id === id); if (!l) throw new Error(`no line ${id}`); return l; };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const spoken = (id: string, text: string) => { const w = line(id).words.find((x) => norm(x.text) === norm(text)); if (!w) throw new Error(`no "${text}" in ${id}`); return w; };
const word = (id: string, text: string) => spoken(id, text).start;
const T = {
  message: line("witness").start, witness: word("witness", "witness"),
  middle: line("middle").start, awake: word("middle", "awake"), reading: word("middle", "reading"),
  ghosts: word("ghosts", "ghosts"), middlemen: word("ghosts", "middlemen"), crackEnd: line("ghosts").end,
  boo: word("boo", "boo"), friend: word("one", "friend"), justOne: line("one").phrases[1].start,
  sends: word("invite", "sends"), invitation: word("invite", "invitation"), secret: word("invite", "secret"),
  vast: word("crowd", "vast"), millions: word("crowd", "millions"), owner: word("crowd", "owner"),
  note: word("note", "note"), sealed: word("note", "sealed"), everyone: word("note", "everyone"),
  knows: word("look", "knows"), look: word("look", "look"),
  aNote: word("reply", "note"), aReply: word("reply", "reply"), whisper: word("reply", "whisper"), answered: word("reply", "answered"),
  agree: word("step", "agree"), stepOut: word("step", "step"),
  two: line("two").start, peer: word("two", "peer"), nobody: word("two", "nobody"),
  notes: word("fade", "notes"), fade: word("fade", "fade"), forgets: word("fade", "forgets"),
  // The title comes up (and its hit sounds) a moment before the narrator names it.
  title: line("title").start - 0.55, tag: line("tag").start, vanish: word("tag", "vanish"),
  sting: line("sting").start, end: timeline.duration,
};
export const MOMENTS = T;

const COLORS = { boo: "#22d3ee", casper: "#4ade80", shade: "#94a3b8", eye: "#0b141a", mesh: "#2b3b52", node: "#131c29", dot: "#4c5f7a" };

// The camera: each key starts moving toward its pose at `at`, over `dur` seconds.
type Pose = { x: number; y: number; z: number };
const CAMERA: (Pose & { at: number; dur: number })[] = [
  { at: 0, dur: 0, x: 0, y: -10, z: 1.05 },
  { at: T.middle - 0.2, dur: 3.2, x: 0, y: -90, z: 1.5 },
  { at: T.ghosts - 0.3, dur: 1.4, x: 0, y: -20, z: 1 },
  { at: T.crackEnd + 0.4, dur: 1.6, x: BOO.x + 10, y: BOO.y - 20, z: 2 },
  { at: T.friend - 0.3, dur: 1.8, x: 0, y: 0, z: 1 },
  { at: T.vast - 0.2, dur: 2.4, x: 0, y: 0, z: 0.72 },
  { at: T.millions - 0.1, dur: 2.6, x: 0, y: 0, z: 0.34 },
  { at: T.note - 0.8, dur: 1.8, x: -260, y: -70, z: 1.15 },
  { at: T.knows - 0.3, dur: 1.6, x: 270, y: -70, z: 1.12 },
  { at: T.aNote - 0.2, dur: 1.4, x: 0, y: 0, z: 0.9 },
  { at: T.stepOut - 0.2, dur: 1.6, x: 0, y: -110, z: 0.95 },
  { at: T.nobody - 0.2, dur: 1.6, x: 0, y: -130, z: 1.3 },
  { at: T.notes - 0.3, dur: 1.6, x: 0, y: 60, z: 0.8 },
  { at: T.forgets, dur: 1.6, x: 0, y: -60, z: 0.9 },
];
function camera(t: number): Pose {
  let pose: Pose = CAMERA[0];
  for (const key of CAMERA.slice(1)) {
    if (t < key.at) break;
    const p = ease.inOutCubic(prog(t, key.at, key.dur));
    pose = { x: lerp(pose.x, key.x, p), y: lerp(pose.y, key.y, p), z: lerp(pose.z, key.z, p) };
  }
  return pose;
}

/** 0 → 1 over `dur` from `at`, softly. */
const come = (t: number, at: number, dur = 0.6) => ease.outCubic(prog(t, at, dur));
/** 1 → 0 over `dur` from `at`. */
const go = (t: number, at: number, dur = 0.5) => 1 - ease.inOutCubic(prog(t, at, dur));
const blinkAt = (t: number, times: number[]) => Math.max(0, ...times.map((b) => { const p = prog(t, b, 0.18); return p > 0 && p < 1 ? Math.sin(p * Math.PI) : 0; }));
/** A blink every few seconds, never two ghosts at once. */
const idleBlinks = (phase: number) => Array.from({ length: 24 }, (_, i) => 2.3 + i * 4.1 + phase);

// A ghost: the app's shape, its hem stirring, its eyes and a mood.
type Mood = "happy" | "curious" | "excited" | "calm" | "wink";
function hem(t: number, phase: number): string {
  const f = (v: number) => v.toFixed(2);
  const frame = t * 1.9 + phase;
  const wave = (speed: number, shift: number, size: number) => (Math.sin(frame * speed + shift) - Math.sin(shift)) * size;
  let d = "M40 8 C18 8 8 22 8 40 L8 72";
  for (let i = 0; i < 4; i++) {
    const x = 16 + i * 16, sway = wave(1, i * 0.8, 0.6);
    d += ` L${f(x + sway)} ${f(64 + wave(1.7, i * 1.3, 0.55))}`;
    if (i < 3) d += ` L${f(x + 8 + sway * 0.6)} ${f(72 + wave(1.3, i, 0.45))}`;
  }
  return d + " L72 72 L72 40 C72 22 62 8 40 8Z";
}
function Ghost({ t, at, color, size = 210, mood = "happy", look = { x: 0, y: 0 }, blink = 0, phase = 0, tilt = 0, o = 1, blush }: {
  t: number; at: P; color: string; size?: number; mood?: Mood; look?: P; blink?: number; phase?: number; tilt?: number; o?: number; blush?: boolean;
}) {
  if (o <= 0.001) return null;
  const s = size / 80, bob = Math.sin(t * 1.5 + phase) * 5;
  const shut = Math.max(blink, blinkAt(t, idleBlinks(phase)));
  const px = clamp(look.x, -1, 1) * 2.2, py = clamp(look.y, -1, 1) * 1.8;
  const id = `g${Math.round(phase * 100)}`;
  return <g transform={`translate(${at.x} ${at.y + bob}) rotate(${tilt}) scale(${s}) translate(-40 -45)`} opacity={o}>
    <defs>
      <radialGradient id={`sheen-${id}`} cx="35%" cy="25%" r="75%"><stop offset="0%" stopColor="#fff" stopOpacity="0.2" /><stop offset="45%" stopColor="#fff" stopOpacity="0.04" /><stop offset="100%" stopColor="#000" stopOpacity="0.1" /></radialGradient>
      <radialGradient id={`halo-${id}`} cx="50%" cy="45%" r="50%"><stop offset="0%" stopColor={color} stopOpacity="0.38" /><stop offset="100%" stopColor={color} stopOpacity="0" /></radialGradient>
    </defs>
    <ellipse cx="40" cy="46" rx="62" ry="66" fill={`url(#halo-${id})`} />
    <path d={hem(t, phase)} fill={color} />
    <path d={hem(t, phase)} fill={`url(#sheen-${id})`} />
    <g transform={`translate(0 ${36 * 0.9 * shut}) scale(1 ${1 - 0.9 * shut})`}>
      {mood === "wink"
        ? <path d="M23 37 Q29 32 35 37" stroke={COLORS.eye} strokeWidth="3" fill="none" strokeLinecap="round" />
        : <ellipse cx="29" cy="36" rx={mood === "excited" ? 7 : 6} ry={mood === "excited" ? 7.5 : 6.5} fill={COLORS.eye} />}
      <ellipse cx="51" cy="36" rx={mood === "excited" ? 7 : 6} ry={mood === "excited" ? 7.5 : 6.5} fill={COLORS.eye} />
      <g transform={`translate(${px} ${py})`}>
        {mood !== "wink" && <circle cx="30.5" cy="34" r="2" fill="#fff" />}
        <circle cx="52.5" cy="34" r="2" fill="#fff" />
      </g>
    </g>
    {mood === "excited" ? <path d="M31 49 Q40 61 49 49 Z" fill={COLORS.eye} />
      : mood === "curious" ? <ellipse cx="41" cy="53" rx="3.2" ry="3.6" fill={COLORS.eye} />
        : mood === "calm" ? <path d="M35 51 Q40 54 45 51" stroke={COLORS.eye} strokeWidth="3" fill="none" strokeLinecap="round" />
          : <path d="M33 50 Q40 57 47 50" stroke={COLORS.eye} strokeWidth="3" fill="none" strokeLinecap="round" />}
    {(blush ?? (mood === "happy" || mood === "excited")) && <g opacity="0.35" fill="#f472b6"><ellipse cx="21" cy="46" rx="4" ry="2.2" /><ellipse cx="59" cy="46" rx="4" ry="2.2" /></g>}
  </g>;
}
/** A stranger in the crowd: the same shape, small and grey, nothing animated but a slow bob. */
function Stranger({ at, t, phase, o = 0.5, size = 30 }: { at: P; t: number; phase: number; o?: number; size?: number }) {
  const s = size / 80, bob = Math.sin(t * 1.2 + phase) * 3;
  return <g transform={`translate(${at.x} ${at.y - 26 + bob}) scale(${s}) translate(-40 -45)`} opacity={o}>
    <path d={GHOST_PATH} fill={COLORS.shade} />
    <circle cx="29" cy="36" r="6" fill={COLORS.eye} /><circle cx="51" cy="36" r="6" fill={COLORS.eye} />
  </g>;
}

/** A ring bursting out of a point. */
function Ring({ t, at, from, color, size = 90 }: { t: number; at: P; from: number; color: string; size?: number }) {
  const p = prog(t, from, 0.9);
  if (p <= 0 || p >= 1) return null;
  return <circle cx={at.x} cy={at.y} r={lerp(size * 0.2, size, ease.outCubic(p))} fill="none" stroke={color} strokeWidth={3 * (1 - p) + 0.5} opacity={1 - p} />;
}

/** A sealed note: a little envelope in its sender's colour, a wax seal when sealed, open when read. */
function Note({ at, color, seal = 0, open = 0, s = 1, o = 1 }: { at: P; color: string; seal?: number; open?: number; s?: number; o?: number }) {
  if (o <= 0.001) return null;
  return <g transform={`translate(${at.x} ${at.y}) scale(${s})`} opacity={o}>
    <circle r="34" fill={color} opacity={0.14} />
    <rect x="-24" y="-16" width="48" height="32" rx="5" fill="#0e1622" stroke={color} strokeWidth="2.5" />
    <path d={open > 0.5 ? "M-22 -14 L0 -30 L22 -14" : "M-22 -14 L0 4 L22 -14"} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
    {seal > 0 && open < 0.5 && <g transform={`scale(${lerp(1.8, 1, ease.outCubic(seal))})`} opacity={clamp(seal * 2)}><circle cy="2" r="8" fill={color} /><path d="M-3 2 h6 M0 -1 v6" stroke="#0e1622" strokeWidth="1.6" /></g>}
    {open > 0 && <circle cy="-6" r={10 * open} fill={color} opacity={0.5 * open} />}
  </g>;
}

/** The invitation Boo hands Casper: a small card with a code on it. */
function Invitation({ at, s = 1, o = 1, glow = 0, rot = 0 }: { at: P; s?: number; o?: number; glow?: number; rot?: number }) {
  if (o <= 0.001) return null;
  const random = seeded(7);
  const cells = Array.from({ length: 49 }, () => random() > 0.52);
  return <g transform={`translate(${at.x} ${at.y}) rotate(${rot}) scale(${s})`} opacity={o}>
    <rect x="-80" y="-52" width="160" height="104" rx="12" fill={COLORS.boo} opacity={0.12 + 0.25 * glow} transform="scale(1.12)" />
    <rect x="-80" y="-52" width="160" height="104" rx="12" fill="#0e1622" stroke={COLORS.boo} strokeWidth="2.5" />
    <g transform="translate(-64 -36)">{cells.map((on, i) => on && <rect key={i} x={(i % 7) * 10} y={Math.floor(i / 7) * 10} width="9" height="9" rx="1.5" fill="#e6f7fb" />)}</g>
    <g transform="translate(34 -8) scale(0.5) translate(-40 -45)"><path d={GHOST_PATH} fill={COLORS.boo} /><circle cx="29" cy="36" r="6" fill={COLORS.eye} /><circle cx="51" cy="36" r="6" fill={COLORS.eye} /></g>
    <rect x="16" y="26" width="40" height="5" rx="2.5" fill={COLORS.boo} opacity="0.6" />
    {glow > 0 && <g transform="translate(36 -8)" opacity={glow}><circle r="22" fill="none" stroke={COLORS.casper} strokeWidth="2.5" /></g>}
  </g>;
}

// The cold open: people talk through a tower that watches.
function Person({ at, o }: { at: P; o: number }) {
  if (o <= 0.001) return null;
  return <g transform={`translate(${at.x} ${at.y}) scale(1.5)`} opacity={o}><circle cy="-46" r="30" fill="#3a4a5c" /><path d="M-54 40 C-54 -4 -30 -14 0 -14 C30 -14 54 -4 54 40 Z" fill="#3a4a5c" /></g>;
}
function Tower({ t }: { t: number }) {
  const shown = come(t, 0.2, 1.2) * go(t, T.middlemen + 1.4, 0.4);
  if (shown <= 0.001) return null;
  const open = clamp(come(t, T.witness - 0.1, 0.7) * 0.55 + come(t, T.awake, 0.4) * 0.45);
  const crumble = prog(t, T.middlemen, 1.8);
  // The message the eye follows: the one inside the tower, or the nearest.
  const flow = messages(t);
  const inside = flow.find((m) => Math.abs(m.x) < 140) ?? flow[0];
  const pupil = inside ? clamp(inside.x / 400, -1, 1) * 16 : 0;
  const shards = Array.from({ length: 36 }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4) }));
  const random = seeded(31);
  return <g opacity={shown}>
    {shards.map(({ col, row }, i) => {
      const dx = (random() - 0.5) * 380, dy = -120 - random() * 260, spin = (random() - 0.5) * 120;
      const f = ease.outCubic(crumble), o = 1 - ease.inCubic(crumble);
      return <rect key={i} x={-110 + col * 55} y={-330 + row * 62} width="55" height="62" fill="#1b2635" stroke="#243246" strokeWidth="1.5"
        transform={`translate(${dx * f} ${dy * f}) rotate(${spin * f} ${-82 + col * 55} ${-299 + row * 62})`} opacity={o} />;
    })}
    {crumble < 0.35 && <g opacity={1 - crumble / 0.35}>
      <ellipse cx="0" cy="-230" rx="78" ry={40 * open + 1} fill="#e8f0f6" />
      <circle cx={pupil} cy="-230" r={24 * clamp(open * 1.4)} fill="#f59e0b" />
      <circle cx={pupil} cy="-230" r={11 * clamp(open * 1.4)} fill="#111" />
      <path d={`M-84 -230 Q0 ${-230 - 46 * open - 6} 84 -230`} fill="none" stroke="#2c3b50" strokeWidth="6" />
    </g>}
  </g>;
}
/** Messages crossing through the tower, left to right and back: a bubble every 1.2 s. */
function messages(t: number) {
  const out: { x: number; y: number; right: boolean; k: number }[] = [];
  const stop = T.ghosts;
  for (let k = 0; k < 14; k++) {
    const start = T.message - 0.4 + k * 1.2;
    const p = (t - start) / 2.6;
    if (p <= 0 || p >= 1 || start > stop) continue;
    const right = k % 2 === 0;
    const x = lerp(right ? BOO.x + 90 : CASPER.x - 90, right ? CASPER.x - 90 : BOO.x + 90, ease.inOutCubic(p));
    out.push({ x, y: -150 + (right ? -24 : 24), right, k });
  }
  return out;
}
function Messages({ t }: { t: number }) {
  const o = go(t, T.ghosts, 0.6);
  if (o <= 0.001) return null;
  return <g opacity={o}>{messages(t).map((m) => {
    const read = t >= T.reading && Math.abs(m.x) < 120;
    return <g key={m.k} transform={`translate(${m.x} ${m.y}) scale(1.35)`}>
      <rect x="-46" y="-26" width="92" height="52" rx="14" fill={m.right ? "#005c4b" : "#202c33"} stroke={read ? "#f59e0b" : "none"} strokeWidth="3" />
      {[-8, 6].map((dy, i) => <rect key={i} x="-32" y={dy - 3} width={i ? 42 : 64} height="6" rx="3" fill={read ? "#f59e0b" : "#d6e4ea"} opacity={read ? 1 : 0.7} />)}
    </g>;
  })}</g>;
}

// The crowd.
function Crowd({ t }: { t: number }) {
  const appear = (n: { d: number; outer: boolean }) => n.outer ? come(t, T.millions + (n.d - 700) / 2600 * 1.8, 0.6) : come(t, T.vast - 0.2 + n.d / 700 * 1.4, 0.6);
  const leave = go(t, T.forgets - 0.2, 2);
  const low = lerp(1, 0.32, ease.inOutCubic(prog(t, T.stepOut, 1.4)));
  const drop = lerp(0, 170, ease.inOutCubic(prog(t, T.stepOut, 1.6)));
  if (t < T.vast - 0.3 || leave <= 0.001) return null;
  const shown = NODES.map(appear);
  return <g opacity={leave * low} transform={`translate(0 ${drop})`}>
    {EDGES.map(([a, b], i) => {
      const o = Math.min(shown[a], shown[b]);
      if (o <= 0.01) return null;
      return <line key={i} x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y} stroke={COLORS.mesh} strokeWidth="1.5" strokeDasharray="2 5" opacity={o} />;
    })}
    {NODES.map((n, i) => shown[i] > 0.01 && <g key={i} opacity={shown[i]}>
      <circle cx={n.x} cy={n.y} r={n.outer ? 7 : 9} fill={COLORS.node} stroke={COLORS.dot} strokeWidth="2" opacity={0.75 + 0.25 * Math.sin(t * 1.1 + i)} />
      {n.stranger && <Stranger at={n} t={t} phase={i} o={0.42 * shown[i]} size={n.outer ? 26 : 30} />}
    </g>)}
    {Array.from({ length: 18 }, (_, k) => {
      const hop = packet(k, t, T.vast + 1 + k * 0.13);
      if (!hop) return null;
      const x = lerp(hop.a.x, hop.b.x, hop.f), y = lerp(hop.a.y, hop.b.y, hop.f);
      return <circle key={k} cx={x} cy={y} r="4" fill={COLORS.shade} opacity={0.55 * come(t, T.vast + 1, 1)} />;
    })}
  </g>;
}

/** A route lit up to `p` (0…1). */
function Route({ path, p, color, o = 1 }: { path: P[]; p: number; color: string; o?: number }) {
  if (p <= 0 || o <= 0.001) return null;
  const head = along(path, p);
  const lengths = path.slice(1).map((q, i) => Math.hypot(q.x - path[i].x, q.y - path[i].y));
  const total = lengths.reduce((a, b) => a + b, 0);
  let done = 0; const points: P[] = [path[0]];
  for (let i = 0; i < lengths.length; i++) { if ((done + lengths[i]) / total <= p) { points.push(path[i + 1]); done += lengths[i]; } else break; }
  points.push(head);
  return <g opacity={o}>
    <polyline points={points.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={color} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
    {path.slice(1, -1).map((q, i) => (done >= lengths.slice(0, i + 1).reduce((a, b) => a + b, 0) - 1) && <circle key={i} cx={q.x} cy={q.y} r="10" fill="none" stroke={color} strokeWidth="2.5" />)}
    <circle cx={head.x} cy={head.y} r="8" fill={color} />
  </g>;
}

/** Scrambled glyphs over the note: what a stranger reads. */
function Noise({ t, at, o }: { t: number; at: P; o: number }) {
  if (o <= 0.001) return null;
  const random = seeded(Math.floor(t * 12));
  const glyphs = "#%&@$*?!{}<>/\\=+~^";
  const text = Array.from({ length: 7 }, () => glyphs[Math.floor(random() * glyphs.length)]).join("");
  return <text x={at.x} y={at.y - 52} textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontSize="30" fontWeight="700" fill={COLORS.shade} opacity={o}>{text}</text>;
}

function Story({ t }: { t: number }) {
  const boo = come(t, T.boo - 0.1, 0.8);
  const casper = come(t, T.friend, 0.9);
  const rise = lerp(0, -150, ease.inOutCubic(prog(t, T.stepOut, 1.6)));
  const booAt = { x: BOO.x, y: BOO.y + rise + (1 - boo) * 30 }, casperAt = { x: CASPER.x, y: CASPER.y + rise + (1 - casper) * 30 };
  // The invitation: made beside Boo, flown to Casper, kept there glowing.
  const fly = ease.inOutCubic(prog(t, T.invitation - 0.3, 1.5));
  const from = { x: BOO.x + 170, y: BOO.y - 150 }, to = { x: CASPER.x - 40, y: CASPER.y - 210 };
  const inviteAt = { x: lerp(from.x, to.x, fly), y: lerp(from.y, to.y, fly) - Math.sin(fly * Math.PI) * 80 + rise * (fly >= 1 ? 1 : 0) };
  const inviteO = come(t, T.sends - 0.1, 0.5) * go(t, T.stepOut, 0.6);
  const inviteS = lerp(1.4, 0.9, fly) * lerp(0.6, 1, come(t, T.sends - 0.1, 0.5));
  const inviteGlow = Math.max(come(t, T.secret, 0.5) * go(t, T.secret + 2.2, 0.8), come(t, T.knows - 0.2, 0.4) * go(t, T.look + 0.6, 0.6));
  // Boo's note: out along its route, sealed, peeked at, found, then carried to Casper.
  const noteOut = ease.inOutCubic(prog(t, T.note - 0.2, 1.6));
  const toCasper = ease.inOutCubic(prog(t, T.aNote, 1.3));
  const noteAt = toCasper > 0 ? along([...ROUTE_LOOK].reverse(), toCasper) : along(ROUTE_NOTE, noteOut);
  const noteGone = go(t, T.aNote + 1.3, 0.3);
  const peek = come(t, T.everyone - 0.2, 0.9) * go(t, T.knows, 0.8);
  const lookLit = prog(t, T.knows - 0.1, (T.look - T.knows) + 0.3);
  const replyOut = ease.inOutCubic(prog(t, T.aReply, T.answered - T.aReply + 0.2));
  const replyAt = along(ROUTE_REPLY, replyOut);
  // The two notes left in the crowd (copies stay on the nodes) fade at the end.
  const leftover = come(t, T.aNote + 0.2, 0.5) * go(t, T.fade, 1.2);
  const replyLeft = come(t, T.answered, 0.5) * go(t, T.fade + 0.15, 1.2);
  const crowdDrop = lerp(0, 170, ease.inOutCubic(prog(t, T.stepOut, 1.6)));
  const booMood: Mood = t >= T.answered ? "excited" : t >= T.friend && t < T.sends ? "curious" : "happy";
  const casperMood: Mood = t >= T.friend && t < T.vast ? "happy" : t >= T.look ? "happy" : "curious";
  return <g>
    {/* The routes and notes live in the crowd and drop with it. */}
    <g transform={`translate(0 ${crowdDrop})`} opacity={lerp(1, 0.5, ease.inOutCubic(prog(t, T.stepOut, 1.4)))}>
      <Route path={ROUTE_NOTE} p={noteOut} color={COLORS.boo} o={go(t, T.stepOut, 1)} />
      <Route path={ROUTE_LOOK} p={ease.inOutCubic(lookLit)} color={COLORS.casper} o={go(t, T.stepOut, 1)} />
      <Route path={ROUTE_REPLY} p={replyOut} color={COLORS.casper} o={go(t, T.stepOut, 1)} />
      {PEEKERS.map((n, i) => {
        const at = { x: lerp(n.x, NOTE_AT.x + (i - 1) * 70, peek), y: lerp(n.y, NOTE_AT.y + 60 + Math.abs(i - 1) * 20, peek) };
        return peek > 0.01 && <Stranger key={i} at={at} t={t} phase={i * 2} o={0.8 * peek} size={46} />;
      })}
      <Noise t={t} at={NOTE_AT} o={peek} />
      <Ring t={t} at={NOTE_AT} from={T.note + 1.4} color={COLORS.boo} />
      <Ring t={t} at={NOTE_AT} from={T.sealed} color={COLORS.boo} size={120} />
      <Ring t={t} at={NOTE_AT} from={T.look} color={COLORS.casper} size={140} />
      <Note at={NOTE_AT} color={COLORS.boo} seal={1} open={1} o={leftover} s={1.3} />
      <Note at={REPLY_AT} color={COLORS.casper} seal={1} o={replyLeft} s={1.3} />
      {t >= T.note - 0.2 && <Note at={noteAt} color={COLORS.boo} seal={come(t, T.sealed, 0.35)} open={come(t, T.look, 0.4)} s={lerp(0.9, 1.5, come(t, T.note - 0.2, 0.4))} o={noteGone} />}
      {t >= T.aReply && <Note at={replyAt} color={COLORS.casper} seal={1} s={1.5} o={go(t, T.answered + 0.4, 0.3)} />}
      {[T.fade, T.fade + 0.15].map((at, k) => <Wisps key={k} t={t} at={k ? REPLY_AT : NOTE_AT} from={at} color={k ? COLORS.casper : COLORS.boo} />)}
    </g>
    <Agreement t={t} booAt={booAt} casperAt={casperAt} />
    <Link t={t} booAt={booAt} casperAt={casperAt} />
    <Invitation at={inviteAt} s={inviteS} o={inviteO} glow={inviteGlow} rot={lerp(-6, 8, fly)} />
    <Ghost t={t} at={booAt} color={COLORS.boo} o={boo} mood={booMood} phase={0.3} look={{ x: t >= T.friend ? 1 : 0, y: t >= T.note && t < T.aReply ? 0.4 : 0 }} blink={blinkAt(t, [T.boo + 0.9])} />
    <Ghost t={t} at={casperAt} color={COLORS.casper} o={casper} mood={casperMood} phase={1.7} look={{ x: -1, y: 0 }} tilt={Math.sin(prog(t, T.justOne, 1.2) * Math.PI * 3) * 6 * (1 - prog(t, T.justOne, 1.2))} />
    <Ring t={t} at={booAt} from={T.answered} color={COLORS.casper} size={150} />
    <Ring t={t} at={casperAt} from={T.aNote + 1.3} color={COLORS.boo} size={150} />
  </g>;
}

/** Wisps rising from a note that fades. */
function Wisps({ t, at, from, color }: { t: number; at: P; from: number; color: string }) {
  const p = prog(t, from, 1.6);
  if (p <= 0 || p >= 1) return null;
  const random = seeded(Math.round(at.x));
  return <g>{Array.from({ length: 14 }, (_, i) => {
    const dx = (random() - 0.5) * 90, dy = -40 - random() * 110, delay = random() * 0.3;
    const q = clamp((p - delay) / (1 - delay));
    return <circle key={i} cx={at.x + dx * q} cy={at.y + dy * ease.outCubic(q)} r={5 * (1 - q) + 1} fill={color} opacity={(1 - q) * 0.8} />;
  })}</g>;
}

/** Each side shows what it can do; what both can, lights up. */
function Agreement({ t, booAt, casperAt }: { t: number; booAt: P; casperAt: P }) {
  const o = come(t, T.agree - 0.2, 0.5) * go(t, T.stepOut + 0.4, 0.5);
  if (o <= 0.001) return null;
  const icons = [CHAT, FILE, BOLT];
  const matched = come(t, T.agree + 0.9, 0.4);
  return <g opacity={o}>{[booAt, casperAt].map((at, side) => icons.map((icon, i) => {
    const x = at.x + (i - 1) * 96, y = at.y - 190;
    const pop = come(t, T.agree - 0.2 + i * 0.14 + side * 0.07, 0.4);
    const color = side ? COLORS.casper : COLORS.boo;
    return <g key={`${side}-${i}`} transform={`translate(${x} ${y}) scale(${lerp(0.7, 1.5, pop)})`} opacity={pop}>
      <circle r="26" fill="#0e1622" stroke={matched > 0.5 ? "#e6f7fb" : color} strokeWidth="2.5" />
      <g transform="translate(-12 -12)" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">{icon}</g>
    </g>;
  }))}</g>;
}
const CHAT = <path d="M4 5h16v10H9l-5 4Z" />;
const FILE = <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /></>;
const BOLT = <path d="M13 2 5 14h6l-1 8 8-12h-6Z" />;

/** The direct line between them, and what travels on it. */
function Link({ t, booAt, casperAt }: { t: number; booAt: P; casperAt: P }) {
  const draw = ease.inOutCubic(prog(t, T.two + 0.2, 1.1));
  if (draw <= 0) return null;
  const a = { x: booAt.x + 70, y: booAt.y }, b = { x: casperAt.x - 70, y: casperAt.y };
  const mid = { x: lerp(a.x, b.x, draw), y: lerp(a.y, b.y, draw) };
  const items = [CHAT, FILE, BOLT, HEART, CHAT, BOLT, FILE, HEART];
  return <g>
    <defs><linearGradient id="link" gradientUnits="userSpaceOnUse" x1={a.x} y1={a.y} x2={b.x} y2={b.y}><stop offset="0" stopColor={COLORS.boo} /><stop offset="1" stopColor={COLORS.casper} /></linearGradient></defs>
    <line x1={a.x} y1={a.y} x2={mid.x} y2={mid.y} stroke="url(#link)" strokeWidth="14" strokeLinecap="round" opacity="0.18" />
    <line x1={a.x} y1={a.y} x2={mid.x} y2={mid.y} stroke="url(#link)" strokeWidth="5" strokeLinecap="round" />
    <Ring t={t} at={a} from={T.two + 1.3} color={COLORS.boo} size={110} />
    <Ring t={t} at={b} from={T.two + 1.3} color={COLORS.casper} size={110} />
    {items.map((icon, i) => {
      const start = T.peer + i * 0.62;
      const p = ease.inOutCubic(prog(t, start, 1.3));
      if (p <= 0 || p >= 1 || start > T.fade) return null;
      const right = i % 2 === 0;
      const x = right ? lerp(a.x, b.x, p) : lerp(b.x, a.x, p), y = a.y - 52;
      const color = right ? COLORS.boo : COLORS.casper;
      return <g key={i} transform={`translate(${x} ${y}) scale(1.8) translate(-12 -12)`} opacity={Math.sin(p * Math.PI) * 1.4} stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round">{icon}</g>;
    })}
  </g>;
}
const HEART = <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />;

/** The words on screen: the phrase being spoken, each word lit as it is said. */
function Captions({ t, wide }: { t: number; wide: boolean }) {
  const lineNow = timeline.lines.find((l) => !["title", "tag", "sting"].includes(l.id) && t >= l.phrases[0].start - 0.15 && t < l.end + 0.5);
  if (!lineNow) return null;
  const phrases = lineNow.phrases;
  const k = phrases.findLastIndex((p) => t >= p.start - 0.15);
  if (k < 0) return null;
  const phrase = phrases[k];
  const next = phrases[k + 1];
  const o = come(t, phrase.start - 0.15, 0.25) * (next ? 1 : go(t, lineNow.end + 0.15, 0.3));
  const words = lineNow.words.filter((w) => w.phrase === k);
  const shownWords = phrase.text.split(" ");
  return <div className="caption" style={{ opacity: o, bottom: wide ? 84 : 360 }}>
    {shownWords.map((w, i) => <span key={i} style={{ opacity: t >= (words[i]?.start ?? phrase.start) - 0.05 ? 1 : 0.32 }}>{w} </span>)}
  </div>;
}

function Title({ t }: { t: number }) {
  const o = come(t, T.title - 0.15, 0.8) * go(t, T.sting - 1, 0.5);
  if (o <= 0.001) return null;
  const tag1 = come(t, T.tag - 0.05, 0.6), tag2 = come(t, T.vanish - 0.05, 0.6), url = come(t, T.vanish + 1.4, 0.8);
  return <div className="title" style={{ opacity: o }}>
    <div className="lockup" style={{ transform: `scale(${lerp(0.94, 1, come(t, T.title - 0.15, 1.2))})` }}>
      <svg width="120" height="130" viewBox="4 4 72 72"><path d={GHOST_PATH} fill={COLORS.boo} /><circle cx="29" cy="36" r="6" fill={COLORS.eye} /><circle cx="51" cy="36" r="6" fill={COLORS.eye} /></svg>
      <span className="wordmark">Ghostly</span><span className="pill">v1.0</span>
    </div>
    <p className="tag" style={{ opacity: tag1, transform: `translateY(${(1 - tag1) * 14}px)` }}>Find your people.</p>
    <p className="tag accent" style={{ opacity: tag2, transform: `translateY(${(1 - tag2) * 14}px)` }}>Vanish from everyone else.</p>
    <p className="url" style={{ opacity: url }}>ghostly.tools</p>
  </div>;
}

/** The last beat: Boo pops up, close. */
function Sting({ t, W, H }: { t: number; W: number; H: number }) {
  if (t < T.sting - 0.6) return null;
  const up = ease.outBack(prog(t, T.sting - 0.35, 0.45), 1.2);
  const gone = t > T.end - 0.25;
  if (gone) return null;
  return <svg className="layer" viewBox={`${-W / 2} ${-H / 2} ${W} ${H}`}>
    <Ghost t={t} at={{ x: W * 0.22, y: lerp(H * 0.75, H * 0.18, up) }} color={COLORS.boo} size={560} mood={t >= T.sting ? "excited" : "happy"} phase={0.3} look={{ x: -0.6, y: -0.2 }} tilt={-10} />
  </svg>;
}

export function Film({ t, format }: { t: number; format: Format }) {
  const [W, H] = FORMATS[format];
  const wide = format === "16x9";
  const cam = camera(t);
  // Upright frames see less across: the camera pulls back so both ghosts fit.
  const z = cam.z * (wide ? 1 : W / 1920 * 1.1);
  const dim = come(t, T.title - 0.3, 1) * 0.55;
  const blackout = Math.max(1 - come(t, 0, 0.6), come(t, T.sting - 1, 0.5));
  return <div className="film" style={{ width: W, height: H } as CSSProperties}>
    <div className="film-bg" />
    <svg className="layer" viewBox={`${-W / 2} ${-H / 2} ${W} ${H}`}>
      <g transform={`scale(${z}) translate(${-cam.x} ${-cam.y})`}>
        <Person at={BOO} o={come(t, 0.3, 1) * go(t, T.ghosts, 0.8)} />
        <Person at={CASPER} o={come(t, 0.5, 1) * go(t, T.ghosts, 0.8)} />
        <Tower t={t} />
        <Messages t={t} />
        <Crowd t={t} />
        <Story t={t} />
      </g>
    </svg>
    <div className="film-dim" style={{ opacity: dim }} />
    <Title t={t} />
    <div className="film-black" style={{ opacity: blackout }} />
    <Sting t={t} W={W} H={H} />
    <Captions t={t} wide={wide} />
    <div className="film-vignette" />
  </div>;
}

/** When an eased motion (in-out cubic) reaches fraction `f` of its way. */
const reach = (f: number) => (f < 0.5 ? Math.cbrt(f / 4) : 1 - Math.cbrt(2 * (1 - f)) / 2);
/** The times a note travelling `path` from `start` over `dur` passes each node on the way (not its ends). */
function hops(path: P[], start: number, dur: number): number[] {
  const lengths = path.slice(1).map((q, i) => Math.hypot(q.x - path[i].x, q.y - path[i].y));
  const total = lengths.reduce((a, b) => a + b, 0);
  let done = 0;
  const times = lengths.slice(0, -1).map((l) => { done += l; return start + dur * reach(done / total); });
  // Hops closer than 0.2 s would blur into one sound: keep the first of each.
  return times.filter((time, i) => i === 0 || time - times[i - 1] >= 0.2);
}

/**
 * The sound of every moment above, as the mix places it: `at` is where the attack lands. App cues are the app's own
 * sounds (src/assets/sounds); the rest are the trailer's (music.mjs). `db` is the gain over the file's own level.
 */
export const SOUNDS: { at: number; sound: string; db: number }[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ at: T.message - 0.4 + k * 1.2 + 1.3, sound: "blip", db: -14 })).filter((x) => x.at < T.ghosts),
  { at: T.witness, sound: "app:sealed", db: 2 },
  { at: T.middlemen, sound: "crumble", db: -4 },
  { at: T.boo - 0.1, sound: "app:spoiler", db: 2 },
  { at: T.friend, sound: "app:spoiler", db: 0 },
  { at: T.invitation - 0.3, sound: "whoosh", db: -6 },
  { at: T.invitation + 1.2, sound: "app:shared", db: 4 },
  { at: T.note - 0.2, sound: "app:sent", db: 2 },
  ...hops(ROUTE_NOTE, T.note - 0.2, 1.6).map((at) => ({ at, sound: "blip", db: -10 })),
  { at: T.sealed, sound: "app:sealed", db: 4 },
  ...hops(ROUTE_LOOK, T.knows - 0.1, T.look - T.knows + 0.3).map((at) => ({ at, sound: "blip", db: -10 })),
  { at: T.look, sound: "app:checked", db: 3 },
  { at: T.aNote + 1.3, sound: "app:message", db: 2 },
  { at: T.aReply, sound: "app:sent", db: 2 },
  ...hops(ROUTE_REPLY, T.aReply, T.answered - T.aReply + 0.2).map((at) => ({ at, sound: "blip", db: -12 })),
  { at: T.answered, sound: "app:mention", db: 1 },
  { at: T.agree + 0.9, sound: "app:checked", db: 2 },
  { at: T.stepOut, sound: "whoosh", db: -10 },
  { at: T.two + 1.3, sound: "app:connected", db: 4 },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ at: T.peer + i * 0.62, sound: "blip", db: -16 })).filter((x) => x.at < T.fade),
  { at: T.fade, sound: "app:deleted", db: 4 },
  { at: T.fade + 0.15, sound: "app:deleted", db: 2 },
  { at: T.title - 0.15, sound: "hit", db: -8 },
  { at: T.sting - 0.35, sound: "pluck", db: -6 },
];

export type { ReactNode };
