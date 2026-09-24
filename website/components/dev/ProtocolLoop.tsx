"use client";

import { useEffect, useRef } from "react";
import type { DevCopy } from "@/content/developers";
import type { Locale } from "@/lib/i18n";
import { LevelBadge } from "@/components/site/Level";
import { DUR } from "@/lib/motion";
import "@/app/dev-loop.css";

/**
 * The protocol at a glance, as a 15.5 s loop. Two apps publish a signed record
 * to Pkarr / the Mainline DHT (WISP 01) and find each other's, exchange
 * capability offers and keep the intersection (03), open a direct line on a
 * transport both offer (100–102) and send a message, a file and a payment
 * frame over it (400 · 500 · 200).
 *
 * One number drives the picture: `--t`, seconds into the loop, set on the
 * figure. Every moving element reads it through a few generic rules in
 * app/dev-loop.css (`pl-in`, `pl-win`, `pl-fly`, `pl-draw`, …) with its own
 * start/duration as inline custom properties — so the whole timeline lives in
 * `TL` below. Six named phases of 2–3 s (website/MOTION.md, "Loops and
 * demos"), each with its caption; moves follow EASE.inOut; the last phase holds
 * the complete frame for 2 s, then the loop cross-fades (DUR.md) into the next
 * run. The CSS default is `--t: 13.5` (the final frame: everything
 * placed, the four steps labelled), which is what the server renders, what a
 * page without JS keeps and what prefers-reduced-motion shows. With JS the
 * loop starts from that same frame, so hydration never jumps. It pauses while
 * hovered or focused, while less than half of it is on screen, or in a
 * background tab.
 *
 * Two stages: landscape (1000 × 446, shown from 981px, where 13 units are
 * ≥ 12px) and portrait (360 × 740, 12 units ≈ 12px at 390).
 */
export type LoopCopy = DevCopy["hero"]["loop"];

const LOOP = 15.5;
const FINAL = 13.5;

/** The timeline, in seconds. */
const TL = {
  cap: {
    publish: [0.15, 2.6],
    find: [2.6, 4.6],
    offer: [4.6, 7.4],
    connect: [7.4, 9.4],
    talk: [9.4, 12.5],
    done: [12.55, 15.4],
  },
  recA: 0.5,
  recB: 0.8,
  lookA: 2.8,
  lookB: 3.7,
  chips: 4.8,
  transports: 5.5,
  lit: 6.1,
  dim: 6.3,
  pick: 7.6,
  pickDim: 7.8,
  line: 8.0,
  pill: 8.6,
  sub: 8.9,
  message: 9.5,
  file: 10.6,
  payment: 11.6,
  final: 12.5,
  stack: { rendezvous: [0, 4.6], negotiate: [4.6, 7.4], connect: [7.4, 9.4], talk: [9.4, 12.5] },
} as const;

const C = {
  core: "#22d3ee",
  transport: "#60a5fa",
  talk: "#a78bfa",
  pay: "#fbbf24",
  left: "#22d3ee",
  right: "#4ade80",
  text: "#e8edf5",
  soft: "#c3cedd",
  dim: "#8796b0",
  line: "#1e293b",
  edge: "#2b3b52",
  panel: "#0b121c",
};

/** Inline custom properties for the timing rules in dev-loop.css. */
type Vars = React.CSSProperties & Record<`--${string}`, string>;
function v(o: Record<string, number | string>): Vars {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) out[`--${k}`] = typeof x === "number" ? String(x) : x;
  return out as Vars;
}

type Chip = { id: string; c: string; shared: boolean };
/** Real identifiers (packages/core/src/pairedSession.ts): capabilities, then transports, each in offer order. */
const LEFT = {
  caps: [
    { id: "chat/1", c: C.talk, shared: true },
    { id: "files/2", c: C.talk, shared: true },
    { id: "payments-cashu/1", c: C.pay, shared: true },
  ] as Chip[],
  transports: [{ id: "webrtc/1", c: C.transport, shared: true }] as Chip[],
};
const RIGHT = {
  caps: [
    { id: "chat/1", c: C.talk, shared: true },
    { id: "files/2", c: C.talk, shared: true },
    { id: "payments-cashu/1", c: C.pay, shared: true },
    { id: "payments-bark/1", c: C.pay, shared: false },
    { id: "hold/1", c: C.talk, shared: false },
    { id: "identity-proof/1", c: C.core, shared: false },
  ] as Chip[],
  transports: [
    { id: "iroh/1", c: C.transport, shared: false },
    { id: "hyperdht/1", c: C.transport, shared: false },
    { id: "webrtc/1", c: C.transport, shared: true },
  ] as Chip[],
};

const PHASE_TAGS = {
  publish: "WISP 01",
  find: "WISP 01",
  offer: "WISP 03",
  connect: "WISP 100–102",
  talk: "WISP 400 · 500 · 200",
  done: "",
} as const;
const STACK = [
  { key: "rendezvous", c: C.core, tag: "WISP 01", short: "WISP 01" },
  { key: "negotiate", c: C.core, tag: "WISP 03", short: "WISP 03" },
  { key: "connect", c: C.transport, tag: "WISP 100–102", short: "100–102" },
  { key: "talk", c: C.talk, tag: "WISP 400 · 500 · 200", short: "400·500·200" },
] as const;

/* ── Pieces ─────────────────────────────────────────────── */

function ChipBox({ chip, x, y, w, font, pop, litAt, dimAt }: { chip: Chip; x: number; y: number; w: number; font: number; pop: number; litAt: number; dimAt: number }) {
  return (
    <g className="pl-pop" style={v({ a: pop, d: 0.3 })}>
      <g className={chip.shared ? undefined : "pl-dim"} style={chip.shared ? undefined : v({ a: dimAt, d: 0.4 })} data-k={chip.c === C.transport ? "adapter" : "capability"}>
        <rect x={x} y={y} width={w} height={26} rx={8} fill="#101a27" stroke={C.edge} />
        {chip.shared && <rect className="pl-in" style={v({ a: litAt, d: 0.4 })} x={x} y={y} width={w} height={26} rx={8} fill={chip.c} fillOpacity={0.18} stroke={chip.c} strokeWidth={1.5} />}
        <text className="mono" x={x + 10} y={y + 17.5} fontSize={font} fill={C.soft}>
          {chip.id}
        </text>
      </g>
    </g>
  );
}

function Tile({ x, y, w, label, accent, side, font, capW, capX, trW, trX }: { x: number; y: number; w: number; label: string; accent: string; side: typeof LEFT; font: number; capW: number; capX: [number, number]; trW: number; trX: number[] }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={184} rx={14} fill={C.panel} stroke={C.edge} />
      <circle cx={x + 18} cy={y + 21} r={4.5} fill={accent} />
      <text x={x + 31} y={y + 26} fontSize={font + 2} fontWeight={600} fill={C.text}>
        {label}
      </text>
      <line x1={x + 1} x2={x + w - 1} y1={y + 38} y2={y + 38} stroke={C.line} />
      <line x1={x + 10} x2={x + w - 10} y1={y + 141} y2={y + 141} stroke={C.line} strokeDasharray="3 4" />
      <g className="pl-fade">
        {side.caps.map((chip, i) => (
          <ChipBox key={chip.id} chip={chip} x={x + capX[i % 2]} y={y + 50 + Math.floor(i / 2) * 31} w={capW} font={font} pop={TL.chips + Math.floor(i / 2) * 0.2} litAt={TL.lit} dimAt={TL.dim} />
        ))}
        {side.transports.map((chip, i) => (
          <ChipBox key={chip.id} chip={chip} x={x + trX[i]} y={y + 148} w={trW} font={font} pop={TL.transports} litAt={TL.pick} dimAt={TL.pickDim} />
        ))}
      </g>
    </g>
  );
}

function Ring({ cx, cy, rx, ry, nodes }: { cx: number; cy: number; rx: number; ry: number; nodes: number }) {
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={C.core} fillOpacity={0.04} stroke={C.core} strokeOpacity={0.4} strokeDasharray="3 6" />
      {Array.from({ length: nodes }, (_, k) => {
        const a = (k / nodes) * Math.PI * 2;
        return <circle key={k} cx={Math.round(cx + rx * Math.cos(a))} cy={Math.round(cy + ry * Math.sin(a))} r={2.5} fill={C.core} fillOpacity={0.8} />;
      })}
    </g>
  );
}

/** A signed record in its DHT slot; the loop flies it in from its owner's tile (dx, dy away). The narrow portrait slot drops the check mark, which "assinado" would run into. */
function DhtRecord({ x, y, w, font, owner, seeker, label, at, foundAt, dx, dy, check = true }: { x: number; y: number; w: number; font: number; owner: string; seeker: string; label: string; at: number; foundAt: number; dx: number; dy: number; check?: boolean }) {
  const h = w / 2;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className="pl-in" style={v({ a: foundAt, d: 0.25 })} x={-h - 6} y={-20} width={w + 12} height={40} rx={12} fill="none" stroke={seeker} strokeWidth={1.5} />
      <g className="pl-fly" style={v({ a: at, d: 1, dx: `${dx}px`, dy: `${dy}px` })}>
        <rect x={-h} y={-14} width={w} height={28} rx={8} fill={C.panel} stroke={C.core} strokeOpacity={0.8} />
        <rect className="pl-win" style={v({ a: at + 0.95, b: at + 1.5 })} x={-h} y={-14} width={w} height={28} rx={8} fill={C.core} fillOpacity={0.2} />
        <circle cx={-h + 14} cy={0} r={4.5} fill={owner} />
        <text className="mono" x={-h + 25} y={4.5} fontSize={font} fill={C.text}>
          {label}
        </text>
        {check && <path d={`M${h - 21} 0 l4 4.5 l8 -9`} stroke={C.core} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      </g>
    </g>
  );
}

function Lookup({ d, c, at }: { d: string; c: string; at: number }) {
  return (
    <g className="pl-win" style={v({ a: at, b: at + 0.95 })}>
      <path className="pl-draw" style={v({ a: at, d: 0.45 })} d={d} pathLength={1} stroke={c} strokeWidth={1.75} fill="none" strokeLinecap="round" />
    </g>
  );
}

type Kind = "message" | "file" | "payment";
function Glyph({ kind, x, y }: { kind: Kind; x: number; y: number }) {
  const c = kind === "payment" ? C.pay : C.talk;
  if (kind === "message") return <path transform={`translate(${x} ${y})`} d="M-6 -6h12a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h-5l-4 3v-3h-3a3 3 0 0 1 -3 -3v-5a3 3 0 0 1 3 -3z" fill={c} />;
  if (kind === "file") return <path transform={`translate(${x} ${y})`} d="M-5 -8h7l4 4v12h-11z M2 -8v4h4" fill={c} stroke={C.panel} strokeWidth={0.8} />;
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={7} fill={c} />
      <text x={0} y={3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill={C.panel}>
        ₿
      </text>
    </g>
  );
}

function Packet({ kind, x, y, w, font, label, mint, at, d, dx = 0, dy = 0 }: { kind: Kind; x: number; y: number; w: number; font: number; label: string; mint?: string; at: number; d: number; dx?: number; dy?: number }) {
  const c = kind === "payment" ? C.pay : C.talk;
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className="pl-travel" style={v({ a: at, d, dx: `${dx}px`, dy: `${dy}px` })}>
        <rect x={0} y={-13} width={w} height={26} rx={9} fill={C.panel} stroke={c} strokeWidth={1.5} />
        <Glyph kind={kind} x={16} y={0} />
        <text x={30} y={4.5} fontSize={font} fontWeight={600} fill={C.text}>
          {label}
        </text>
        {kind === "payment" && (
          <g data-k="provider">
            <path d={`M${mint ? w - 52 : w - 16} -5 l5 5 l-5 5 l-5 -5z`} fill={c} />
            {mint && (
              <text className="mono" x={w - 43} y={4.5} fontSize={font} fill={c}>
                {mint}
              </text>
            )}
          </g>
        )}
      </g>
    </g>
  );
}

function Captions({ t, x, y, tagX, tagY, size, tagSize, anchor }: { t: LoopCopy; x: number; y: number; tagX: number; tagY: number; size: number; tagSize: number; anchor: "start" | "end" }) {
  return (
    <>
      {(Object.keys(TL.cap) as (keyof typeof TL.cap)[]).map((k) => (
        <g key={k} className="pl-win" style={v({ a: TL.cap[k][0], b: TL.cap[k][1] })}>
          <text x={x} y={y} fontSize={size} fontWeight={650} fill={C.text}>
            {t.phases[k]}
          </text>
          {PHASE_TAGS[k] && (
            <text className="mono" x={tagX} y={tagY} textAnchor={anchor} fontSize={tagSize} fill={C.core} data-k="wisp">
              {PHASE_TAGS[k]}
            </text>
          )}
        </g>
      ))}
    </>
  );
}

function Stack({ t, xs, y, size, tagSize, arrows, short }: { t: LoopCopy; xs: number[]; y: number; size: number; tagSize: number; arrows: boolean; short?: boolean }) {
  return (
    <g>
      {STACK.map((s, i) => (
        <g key={s.key} className="pl-stk" style={v({ a: TL.stack[s.key][0], b: TL.stack[s.key][1] })}>
          <text x={xs[i]} y={y} textAnchor="middle" fontSize={size} fontWeight={650} fill={s.c}>
            {t.stack[s.key]}
          </text>
          <text className="mono" x={xs[i]} y={y + tagSize + 8} textAnchor="middle" fontSize={tagSize} fill={C.dim}>
            {short ? s.short : s.tag}
          </text>
        </g>
      ))}
      {arrows &&
        xs.slice(0, -1).map((x, i) => (
          <text key={x} x={(x + xs[i + 1]) / 2} y={y} textAnchor="middle" fontSize={size} fill={C.dim}>
            →
          </text>
        ))}
    </g>
  );
}

/* ── Stages ─────────────────────────────────────────────── */

function Landscape({ t }: { t: LoopCopy }) {
  const L = { x: 8, y: 196, w: 306 };
  const R = { x: 686, y: 196, w: 306 };
  const lineY = 288;
  return (
    <svg viewBox="0 0 1000 446" className="pl-svg pl-svg--land" aria-hidden="true" focusable="false">
      <Captions t={t} x={4} y={24} tagX={996} tagY={24} size={20} tagSize={13} anchor="end" />

      <Ring cx={500} cy={110} rx={176} ry={48} nodes={12} />
      <text className="mono" x={306} y={114} textAnchor="end" fontSize={13} fill={C.core}>
        {t.dht}
      </text>
      <text className="mono" x={694} y={114} fontSize={13} fill={C.dim}>
        {t.spec}
      </text>

      <g className="pl-fade">
        <Lookup d="M250 196 L540 128" c={C.left} at={TL.lookA} />
        <Lookup d="M750 196 L460 128" c={C.right} at={TL.lookB} />
        <DhtRecord x={432} y={110} w={124} font={13} owner={C.left} seeker={C.right} label={t.record} at={TL.recA} foundAt={TL.lookB + 0.45} dx={161 - 432} dy={196 - 110} />
        <DhtRecord x={568} y={110} w={124} font={13} owner={C.right} seeker={C.left} label={t.record} at={TL.recB} foundAt={TL.lookA + 0.45} dx={839 - 568} dy={196 - 110} />
      </g>

      <Tile {...L} label={t.left} accent={C.left} side={LEFT} font={13} capW={140} capX={[10, 156]} trW={92} trX={[10, 107, 204]} />
      <Tile {...R} label={t.right} accent={C.right} side={RIGHT} font={13} capW={140} capX={[10, 156]} trW={92} trX={[10, 107, 204]} />

      <g className="pl-fade">
        <path className="pl-draw" style={v({ a: TL.line, d: 0.7 })} d={`M314 ${lineY} L686 ${lineY}`} pathLength={1} stroke={C.transport} strokeWidth={2.5} fill="none" />
        <g className="pl-in" style={v({ a: TL.pill, d: 0.3 })}>
          <text className="mono" x={500} y={272} textAnchor="middle" fontSize={13} fill={C.dim} data-k="profile">
            paired-chat/1
          </text>
          <g transform={`translate(500 ${lineY + 30})`} data-k="adapter">
            <rect x={-46} y={-13} width={92} height={26} rx={13} fill={C.transport} fillOpacity={0.18} stroke={C.transport} />
            <text className="mono" x={0} y={4.5} textAnchor="middle" fontSize={13} fill={C.text}>
              webrtc/1
            </text>
          </g>
        </g>
        <g className="pl-in" style={v({ a: TL.sub, d: 0.3 })}>
          <text className="mono" x={500} y={lineY + 64} textAnchor="middle" fontSize={13} fill={C.dim}>
            {t.firstPairing}
          </text>
          <text className="mono" x={500} y={lineY + 81} textAnchor="middle" fontSize={13} fill={C.dim}>
            {t.later}
          </text>
        </g>

        <Packet kind="message" x={318} y={lineY} w={84} font={13} label={t.packets.message} at={TL.message} d={1} dx={280} />
        <Packet kind="file" x={566} y={lineY} w={116} font={13} label={t.packets.file} at={TL.file} d={1} dx={-248} />
        <Packet kind="payment" x={318} y={lineY} w={160} font={13} label={t.packets.payment} mint={t.packets.mint} at={TL.payment} d={0.9} dx={204} />

        <g className="pl-in" style={v({ a: TL.final + 0.1, d: 0.3 })}>
          {(["message", "file", "payment"] as const).map((k, i) => (
            <g key={k}>
              <circle cx={446 + i * 54} cy={lineY} r={14} fill={C.panel} stroke={k === "payment" ? C.pay : C.talk} strokeWidth={1.5} />
              <Glyph kind={k} x={446 + i * 54} y={lineY} />
            </g>
          ))}
        </g>
      </g>

      <Stack t={t} xs={[125, 375, 625, 875]} y={414} size={16} tagSize={13} arrows />
    </svg>
  );
}

function Portrait({ t }: { t: LoopCopy }) {
  const A = { x: 8, y: 56, w: 344 };
  const B = { x: 8, y: 498, w: 344 };
  const lineX = 64;
  const top = A.y + 184;
  return (
    <svg viewBox="0 0 360 740" className="pl-svg pl-svg--port" aria-hidden="true" focusable="false">
      <Captions t={t} x={2} y={18} tagX={2} tagY={40} size={16} tagSize={12} anchor="start" />

      <Tile {...A} label={t.left} accent={C.left} side={LEFT} font={12} capW={158} capX={[10, 176]} trW={100} trX={[10, 116, 222]} />

      <Ring cx={246} cy={294} rx={104} ry={34} nodes={10} />
      <text className="mono" x={246} y={350} textAnchor="middle" fontSize={12} fill={C.core}>
        {t.dht}
      </text>
      <text className="mono" x={246} y={367} textAnchor="middle" fontSize={12} fill={C.dim}>
        {t.spec}
      </text>

      <g className="pl-fade">
        <Lookup d="M298 240 L298 278" c={C.left} at={TL.lookA} />
        <Lookup d={`M160 ${B.y} L160 310`} c={C.right} at={TL.lookB} />
        <DhtRecord x={194} y={294} w={96} font={12} owner={C.left} seeker={C.right} label={t.record} at={TL.recA} foundAt={TL.lookB + 0.45} dx={180 - 194} dy={top - 294} check={false} />
        <DhtRecord x={298} y={294} w={96} font={12} owner={C.right} seeker={C.left} label={t.record} at={TL.recB} foundAt={TL.lookA + 0.45} dx={180 - 298} dy={B.y - 294} check={false} />
      </g>

      <Tile {...B} label={t.right} accent={C.right} side={RIGHT} font={12} capW={158} capX={[10, 176]} trW={100} trX={[10, 116, 222]} />

      <g className="pl-fade">
        <path className="pl-draw" style={v({ a: TL.line, d: 0.7 })} d={`M${lineX} ${top} L${lineX} ${B.y}`} pathLength={1} stroke={C.transport} strokeWidth={2.5} fill="none" />
        <g className="pl-in" style={v({ a: TL.pill, d: 0.3 })}>
          <g transform="translate(246 402)" data-k="adapter">
            <rect x={-46} y={-13} width={92} height={26} rx={13} fill={C.transport} fillOpacity={0.18} stroke={C.transport} />
            <text className="mono" x={0} y={4.5} textAnchor="middle" fontSize={12} fill={C.text}>
              webrtc/1
            </text>
          </g>
          <text className="mono" x={246} y={436} textAnchor="middle" fontSize={12} fill={C.dim} data-k="profile">
            paired-chat/1
          </text>
        </g>
        <g className="pl-in" style={v({ a: TL.sub, d: 0.3 })}>
          <text className="mono" x={246} y={462} textAnchor="middle" fontSize={12} fill={C.dim}>
            {t.firstPairing}
          </text>
          <text className="mono" x={246} y={478} textAnchor="middle" fontSize={12} fill={C.dim}>
            {t.later}
          </text>
        </g>

        <Packet kind="message" x={lineX - 36} y={top + 18} w={72} font={12} label={t.packets.message} at={TL.message} d={1} dy={B.y - top - 36} />
        <Packet kind="file" x={lineX - 52} y={B.y - 18} w={104} font={12} label={t.packets.file} at={TL.file} d={1} dy={-(B.y - top - 36)} />
        <Packet kind="payment" x={lineX - 56} y={top + 18} w={112} font={12} label={t.packets.payment} at={TL.payment} d={0.9} dy={B.y - top - 36} />

        <g className="pl-in" style={v({ a: TL.final + 0.1, d: 0.3 })}>
          {(["message", "file", "payment"] as const).map((k, i) => (
            <g key={k}>
              <circle cx={lineX} cy={330 + i * 40} r={14} fill={C.panel} stroke={k === "payment" ? C.pay : C.talk} strokeWidth={1.5} />
              <Glyph kind={k} x={lineX} y={330 + i * 40} />
            </g>
          ))}
        </g>
      </g>

      <Stack t={t} xs={[44, 128, 218, 308]} y={712} size={13} tagSize={12} arrows={false} short />
    </svg>
  );
}

export function ProtocolLoop({ t }: { t: LoopCopy }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let time = FINAL;
    let last = 0;
    let raf = 0;
    let hovered = false;
    let focused = false;
    let visible = true;
    const tick = (now: number) => {
      if (last) time = (time + Math.min(now - last, 100) / 1000) % LOOP;
      last = now;
      el.style.setProperty("--t", time.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    const sync = () => {
      const run = !reduce.matches && !hovered && !focused && visible && !document.hidden;
      if (run && !raf) {
        last = 0;
        raf = requestAnimationFrame(tick);
      } else if (!run && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (reduce.matches) {
        time = FINAL;
        el.style.setProperty("--t", String(FINAL));
      }
      el.dataset.state = reduce.matches ? "still" : run ? "running" : "paused";
    };
    const on = (fn: () => void) => () => {
      fn();
      sync();
    };
    const enter = on(() => (hovered = true));
    const leave = on(() => (hovered = false));
    const fin = on(() => (focused = true));
    const fout = on(() => (focused = el.contains(document.activeElement)));
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("focusin", fin);
    el.addEventListener("focusout", fout);
    document.addEventListener("visibilitychange", sync);
    reduce.addEventListener("change", sync);
    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting && e.intersectionRatio >= 0.5;
        sync();
      },
      { threshold: [0, 0.5] },
    );
    io.observe(el);
    sync();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("focusin", fin);
      el.removeEventListener("focusout", fout);
      document.removeEventListener("visibilitychange", sync);
      reduce.removeEventListener("change", sync);
    };
  }, []);
  return (
    <figure ref={ref} className="pl" role="img" aria-label={t.label} tabIndex={0} data-state="still" style={v({ T: LOOP, fin: TL.final, xf: DUR.md })}>
      <Landscape t={t} />
      <Portrait t={t} />
      <span className="pl-pausemark" aria-hidden="true" />
    </figure>
  );
}

/** The six words, as a legend under the loop: each key is drawn the way the loop draws what it names. */
export function ProtocolLegend({ words, locale }: { words: DevCopy["words"]; locale: Locale }) {
  return (
    <div className="pl-legend-wrap">
      <span className="caption pl-legend-eyebrow">{words.eyebrow}</span>
      <ul className="pl-legend">
        {words.items.map((w) => (
          <li key={w.id} className={`pl-leg pl-leg--${w.id}`} data-k={w.id}>
            <span className="pl-key mono">{w.key}</span>
            <span className="pl-term">
              {w.term}
              {"level" in w && w.level && <LevelBadge level={w.level} locale={locale} small />}
            </span>
            <span className="pl-gloss">{w.gloss}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
