"use client";

import { useId } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { SceneFrame, useScene, type SceneStep } from "@/components/story/SceneFrame";
import { StaticActors } from "@/components/story/StaticActors";
import { ease, PAIR } from "@/lib/motion";
import { BLOCKING, poseAt } from "@/components/story/poses";
import { GHOST_PATH } from "@/components/ghost/path";
import { Stage, useStep } from "./stage";

type Card = { title: string; link: string; qr: string; code: string; forOne: string };
type MV = MotionValue<number>;
type Pt = [number, number];

const CYAN = "#22d3ee";
const GREEN = "#4ade80";
const INK = "#060a10";
const PAPER = "#e8edf5";
const DIM = "#8b98ab";
const PILL = "#172231";

// The invitation in the one format of WISP 801: the link, the QR and the text code are the same secret three ways.
// Both run past their field on purpose, as a real code does: the field clips them and fades their end out.
const CODE = "ghostly1pk7qx9d3m8fz2hv5c";
const LINK = `ghostly.tools/#${CODE}`;

const round = (v: number) => Math.round(v * 100) / 100;

// A fixed pseudo-QR on a 13-module grid: decoration only, it encodes nothing.
const FINDERS: Pt[] = [[0, 0], [9, 0], [0, 9]];
const QR_CELLS = (() => {
  let s = 11;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const cells: Pt[] = [];
  for (let y = 0; y < 13; y++)
    for (let x = 0; x < 13; x++) {
      const finder = (x < 5 && y < 5) || (x > 7 && y < 5) || (x < 5 && y > 7);
      if (!finder && r() > 0.5) cells.push([x, y]);
    }
  return cells;
})();

/** The QR, `size` units square, with a cyan pulse when its turn comes. */
function Qr({ x, y, size, glow }: { x: number; y: number; size: number; glow: MV }) {
  const m = size / 15; // module: 13 of data, one of quiet zone each side
  const at = (i: number) => round((1 + i) * m);
  const soft = useTransform(glow, (g) => g * 0.3);
  const rx = round(size * 0.08);
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={size} height={size} rx={rx} fill={PAPER} />
      {FINDERS.map(([fx, fy]) => (
        <g key={`${fx}-${fy}`} transform={`translate(${at(fx)} ${at(fy)})`}>
          <rect width={round(4 * m)} height={round(4 * m)} rx={round(m * 0.7)} fill={INK} />
          <rect x={round(m)} y={round(m)} width={round(2 * m)} height={round(2 * m)} rx={round(m * 0.3)} fill={PAPER} />
          <rect x={round(1.5 * m)} y={round(1.5 * m)} width={round(m)} height={round(m)} rx={round(m * 0.15)} fill={INK} />
        </g>
      ))}
      {QR_CELLS.map(([cx, cy]) => (
        <rect key={`${cx}.${cy}`} x={at(cx)} y={at(cy)} width={round(m * 0.86)} height={round(m * 0.86)} rx={round(m * 0.18)} fill={INK} />
      ))}
      <motion.rect x="-4" y="-4" width={size + 8} height={size + 8} rx={rx + 4} fill="none" stroke={CYAN} strokeWidth="5" style={{ opacity: soft }} />
      <motion.rect x="-2" y="-2" width={size + 4} height={size + 4} rx={rx + 2} fill="none" stroke={CYAN} strokeWidth="1.6" style={{ opacity: glow }} />
    </g>
  );
}

/** A labelled pill (Link / Code) with the same cyan pulse. The value never leaves the pill, whatever font draws it:
 *  it is clipped `inset` units inside the pill's ends and fades out over its last `font * 2` units. */
function Row({ label, value, x, y, w, font, color, glow }: { label: string; value: string; x: number; y: number; w: number; font: number; color: string; glow: MV }) {
  const id = useId().replace(/:/g, "");
  const h = font * 2;
  const pillY = y + font + 6;
  const inset = 8;
  const end = x + w - inset;
  const fade = font * 2;
  const wash = useTransform(glow, (g) => g * 0.16);
  const soft = useTransform(glow, (g) => g * 0.3);
  return (
    <g data-invite-row>
      <defs>
        <clipPath id={`${id}-clip`}>
          <rect data-invite-field x={x + inset} y={pillY} width={w - inset * 2} height={h} />
        </clipPath>
        <linearGradient id={`${id}-fade`} x1={end - fade} x2={end} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={PILL} stopOpacity="0" />
          <stop offset="1" stopColor={PILL} />
        </linearGradient>
      </defs>
      <text x={x} y={y + font} fontSize={font} fill={DIM}>
        {label}
      </text>
      <rect data-invite-pill x={x} y={pillY} width={w} height={h} rx={7} fill={PILL} />
      <text x={x + inset} y={round(pillY + h / 2 + font * 0.36)} fontSize={font} className="mono" fill={color} clipPath={`url(#${id}-clip)`}>
        {value}
      </text>
      <rect x={end - fade} y={pillY} width={fade} height={h} fill={`url(#${id}-fade)`} />
      <motion.rect x={x} y={pillY} width={w} height={h} rx={7} fill={CYAN} style={{ opacity: wash }} />
      <motion.rect x={x - 4} y={pillY - 4} width={w + 8} height={h + 8} rx={11} fill="none" stroke={CYAN} strokeWidth="5" style={{ opacity: soft }} />
      <motion.rect x={x - 1} y={pillY - 1} width={w + 2} height={h + 2} rx={8} fill="none" stroke={CYAN} strokeWidth="1.6" style={{ opacity: glow }} />
    </g>
  );
}

/** Boo's mark: the app's ghost, `size` units wide, its body's top-left corner at (x, y). */
function Mark({ x, y, size }: { x: number; y: number; size: number }) {
  const k = size / 64; // the body spans 64 units of GHOST_PATH's 80×100 box, from (8, 8)
  return (
    <g transform={`translate(${round(x - 8 * k)} ${round(y - 8 * k)}) scale(${round(k * 1000) / 1000})`}>
      <path d={GHOST_PATH} fill={CYAN} />
      <ellipse cx="30" cy="38" rx="5.5" ry="6.5" fill={PAIR.eye} />
      <ellipse cx="50" cy="38" rx="5.5" ry="6.5" fill={PAIR.eye} />
    </g>
  );
}

function CardBody({ w, h, id }: { w: number; h: number; id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.11" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect data-invite-card x={-w / 2} y={-h / 2} width={w} height={h} rx="20" fill="#0f1823" stroke={CYAN} strokeOpacity="0.55" />
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="20" fill={`url(#${id}-sheen)`} />
    </>
  );
}

// A card has two readings: held out, every line legible; as a token on its way, only the chrome and the QR
// (`ink` 1 → 0 fades the type and the pills and slides the QR to the middle, so no text is ever drawn small).
type CardProps = { t: Card; glow: [MV, MV, MV]; ink: MV };

/** Landscape: a portrait card, 200×260, drawn centred on its origin. Nothing in it is below 12 units. */
const FULL = { w: 200, h: 260 };
function FullCard({ t, glow, ink }: CardProps) {
  const id = useId().replace(/:/g, "");
  const x0 = -FULL.w / 2;
  const y0 = -FULL.h / 2;
  const pad = 16;
  const inner = FULL.w - pad * 2;
  const qr = 84;
  const qrTop = y0 + 62;
  const mark = 24;
  // The QR's centre sits at -26; as the type goes it moves to the card's centre.
  const qrShift = useTransform(ink, (i) => round((1 - i) * -(qrTop + qr / 2)));
  return (
    <g>
      <CardBody w={FULL.w} h={FULL.h} id={id} />
      <motion.g style={{ opacity: ink }}>
        <text x={x0 + pad} y={y0 + 32} fontSize="17" fontWeight="700" fill={PAPER}>
          {t.title}
        </text>
        <text x={x0 + pad} y={y0 + 50} fontSize="12" fill={DIM}>
          {t.forOne}
        </text>
        {/* Level with the two header lines, at the right edge. */}
        <Mark x={-x0 - pad - mark} y={y0 + 23} size={mark} />
        <Row label={t.link} value={LINK} x={x0 + pad} y={y0 + 154} w={inner} font={12} color="#cfd8e6" glow={glow[0]} />
        <Row label={t.code} value={CODE} x={x0 + pad} y={y0 + 204} w={inner} font={12} color={GREEN} glow={glow[2]} />
      </motion.g>
      <motion.g style={{ y: qrShift }}>
        <Qr x={-qr / 2} y={qrTop} size={qr} glow={glow[1]} />
      </motion.g>
    </g>
  );
}

/** Portrait: the same card laid out landscape, 264×132, so its text stays at 11 units or more on a phone. */
const COMPACT = { w: 264, h: 132 };
function CompactCard({ t, glow, ink }: CardProps) {
  const id = useId().replace(/:/g, "");
  const x0 = -COMPACT.w / 2;
  const y0 = -COMPACT.h / 2;
  const pad = 12;
  const qr = 72;
  const qrLeft = x0 + pad;
  const qrTop = y0 + 38;
  const col = qrLeft + qr + 12;
  const colW = COMPACT.w - (col - x0) - pad;
  // The QR sits at the left; as the type goes it moves to the card's centre.
  const qrShiftX = useTransform(ink, (i) => round((1 - i) * -(qrLeft + qr / 2)));
  const qrShiftY = useTransform(ink, (i) => round((1 - i) * -(qrTop + qr / 2)));
  return (
    <g>
      <CardBody w={COMPACT.w} h={COMPACT.h} id={id} />
      <motion.g style={{ opacity: ink }}>
        <text x={x0 + pad} y={y0 + 27} fontSize="15" fontWeight="700" fill={PAPER}>
          {t.title}
        </text>
        <text x={-x0 - pad} y={y0 + 27} fontSize="11" textAnchor="end" fill={DIM}>
          {t.forOne}
        </text>
        <Row label={t.link} value={LINK} x={col} y={y0 + 36} w={colW} font={11} color="#cfd8e6" glow={glow[0]} />
        <Row label={t.code} value={CODE} x={col} y={y0 + 82} w={colW} font={11} color={GREEN} glow={glow[2]} />
      </motion.g>
      <motion.g style={{ x: qrShiftX, y: qrShiftY }}>
        <Qr x={qrLeft} y={qrTop} size={qr} glow={glow[1]} />
      </motion.g>
    </g>
  );
}

/** A "confirmed" chip that pops above a ghost's head. */
function Chip({ x, y, color, pop, portrait }: { x: number; y: number; color: string; pop: MV; portrait: boolean }) {
  const w = portrait ? 38 : 46;
  const h = portrait ? 26 : 30;
  return (
    <motion.g style={{ x, y, scale: pop }}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill={INK} stroke={color} strokeWidth="1.5" />
      <path d={portrait ? "M-6 0.5 l4 4 l8 -8" : "M-7 0.5 l5 5 l9 -10"} stroke={color} strokeWidth={portrait ? 2.4 : 2.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </motion.g>
  );
}

// Where things are, per orientation. The actors' poses live in poses.ts:
// landscape Boo's body is x 664-856, y 494-686 (eyes at y ≈ 578); Casper's x 1084-1276 (eyes ≈ 568, mouth to ≈ 640,
// hem bottom 676). Landscape safe area is y 150-750 (2:1 viewports crop 90 units top and bottom).
// portrait Boo's body is x 35-155, y 275-395 (eyes ≈ 327); Casper's x 235-355 (mouth ≈ 357, hem 380-395).
type Layout = {
  /** Where the card first appears (at Boo's side) and where he holds it out. */
  born: Pt;
  rest: Pt;
  /** The card as a token, once it is on its way. */
  token: number;
  /** The private channel: a cubic from where the card rests, through two controls, to Casper's chest. */
  flight: [Pt, Pt, Pt];
  chips: [Pt, Pt];
  link: [number, number, number];
  check: Pt;
};
// The card rests in the gap between the two bodies, then passes low, under Casper's face, onto his chest.
const L: Layout = {
  born: [880, 630],
  rest: [975, 604],
  token: 0.28,
  flight: [[1040, 652], [1110, 700], [1180, 668]],
  chips: [[760, 450], [1180, 440]],
  link: [700, 1240, 752],
  check: [960, 752],
};
// The card rests above the two ghosts (clear of the nav), then drops between their eyes and hooks right onto Casper's skirt.
const P: Layout = {
  born: [120, 250],
  rest: [195, 200],
  token: 0.3,
  flight: [[185, 300], [175, 400], [295, 362]],
  chips: [[95, 240], [295, 240]],
  link: [60, 330, 450],
  check: [195, 450],
};

const cubic = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
const smooth = (t: number) => t * t * (3 - 2 * t);
const pathOf = (a: Pt, [b, c, d]: Layout["flight"]) => `M${a[0]} ${a[1]} C ${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`;

function Visual({ card }: { card: Card }) {
  const { p, n, portrait, camera } = useScene();
  const C = portrait ? P : L;
  const id = useId().replace(/:/g, "");
  const stage = portrait ? { w: 390, h: 844 } : { w: 1440, h: 900 };

  // Every step: establish (to .15), action (to .7), settle. One subject moves at a time.
  // Step 0: Boo makes the card: it grows at his side and settles where he holds it out.
  const grow = useStep(p, 0, n, [0.1, 0.3, 0.5, 0.66], [0.2, 0.72, 0.93, 1], ease.move);
  const settle = useStep(p, 0, n, [0.1, 0.3, 0.5, 0.66], [0, 0.62, 0.9, 1], ease.move);
  const appear = useStep(p, 0, n, [0.1, 0.26], [0, 1]);
  // Step 1: the three ways light up in turn; then the card becomes a token, travels the channel and folds into Casper.
  const glowLink = useStep(p, 1, n, [0.06, 0.1, 0.16], [0, 1, 0]);
  const glowQr = useStep(p, 1, n, [0.16, 0.2, 0.26], [0, 1, 0]);
  const glowCode = useStep(p, 1, n, [0.26, 0.3, 0.36], [0, 1, 0]);
  const token = useStep(p, 1, n, [0.38, 0.48], [1, C.token], ease.move);
  // The type goes first, while the card is still ≥ .64: no line is ever drawn small.
  const ink = useStep(p, 1, n, [0.38, 0.43], [1, 0]);
  const travel = useStep(p, 1, n, [0.48, 0.68], [0, 1], ease.move);
  const fold = useStep(p, 1, n, [0.68, 0.74], [1, 0], ease.exit);
  const arcDraw = useStep(p, 1, n, [0.46, 0.64], [0, 1], ease.move);
  const arcFade = useStep(p, 1, n, [0.7, 0.78], [0.5, 0]);
  const ring = useStep(p, 1, n, [0.72, 0.84], [0, 1], ease.enter);
  // Step 2: Boo confirms, Casper confirms, then the connection, then the check; each pops in on the app's hop.
  const popBoo = useStep(p, 2, n, [0.1, 0.24], [0, 1], ease.hop);
  const popCasper = useStep(p, 2, n, [0.26, 0.4], [0, 1], ease.hop);
  const link = useStep(p, 2, n, [0.44, 0.58], [0, 1], ease.move);
  const check = useStep(p, 2, n, [0.58, 0.7], [0, 1], ease.hop);
  // Then the connected moment, as the app's pairing scene has it: a ring bursts once from each ghost and, a moment
  // later, from the middle of the link.
  const burst = useStep(p, 2, n, [0.62, 0.84], [0, 1], ease.burst);
  const burstMid = useStep(p, 2, n, [0.66, 0.86], [0, 1], ease.burst);
  const light = useStep(p, 2, n, [0.44, 0.6], [0.08, 0.2]);

  const f0 = C.rest;
  const [f1, f2, f3] = C.flight;
  const x = useTransform([settle, travel], ([s, t]) => {
    const along = smooth(t as number);
    return C.born[0] + (C.rest[0] - C.born[0]) * (s as number) + cubic(f0[0], f1[0], f2[0], f3[0], along) - f0[0];
  });
  const y = useTransform([settle, travel], ([s, t]) => {
    const along = smooth(t as number);
    return C.born[1] + (C.rest[1] - C.born[1]) * (s as number) + cubic(f0[1], f1[1], f2[1], f3[1], along) - f0[1];
  });
  const scale = useTransform([grow, token, fold], ([g, k, f]) => (g as number) * (k as number) * (f as number));
  const ringR = useTransform(ring, (t) => (portrait ? 4 + t * 36 : 6 + t * 54));
  const ringOpacity = useTransform(ring, (t) => (t <= 0 ? 0 : (1 - t) * 0.7));
  const glow: [MV, MV, MV] = [glowLink, glowQr, glowCode];
  // Where the two stand once connected (the act draws them from the same table).
  const cast = BLOCKING[portrait ? "portrait" : "landscape"].invite;
  const boo = poseAt(cast.boo, 0.9);
  const casper = poseAt(cast.casper, 0.9);

  return (
    <Stage portrait={portrait} camera={camera} light={{ color: CYAN, opacity: light }}>
      <defs>
        <linearGradient id={`${id}-link`} x1={C.link[0]} x2={C.link[1]} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={CYAN} />
          <stop offset="1" stopColor={GREEN} />
        </linearGradient>
        {/* The channel is dashed; a solid stroke drawing along the same path reveals it. */}
        <mask id={`${id}-arc`} maskUnits="userSpaceOnUse" x="0" y="0" width={stage.w} height={stage.h}>
          <motion.path d={pathOf(f0, C.flight)} fill="none" stroke="#fff" strokeWidth="12" strokeLinecap="round" style={{ pathLength: arcDraw }} />
        </mask>
      </defs>
      <StaticActors chapter="invite" />

      {/* The private channel the invitation travels through. */}
      <motion.path d={pathOf(f0, C.flight)} fill="none" stroke={CYAN} strokeWidth="2" strokeDasharray="5 7" strokeLinecap="round" mask={`url(#${id}-arc)`} style={{ opacity: arcFade }} />
      {/* Casper takes it in. */}
      <motion.circle cx={f3[0]} cy={f3[1]} fill="none" stroke={GREEN} strokeWidth="2" style={{ r: ringR, opacity: ringOpacity }} />

      {/* Both confirm. */}
      <Chip x={C.chips[0][0]} y={C.chips[0][1]} color={CYAN} pop={popBoo} portrait={portrait} />
      <Chip x={C.chips[1][0]} y={C.chips[1][1]} color={GREEN} pop={popCasper} portrait={portrait} />

      {/* The connection, once both confirmed it. */}
      <motion.path d={`M${C.link[0]} ${C.link[2]} L${C.link[1]} ${C.link[2]}`} fill="none" stroke={`url(#${id}-link)`} strokeWidth={portrait ? 4 : 6} strokeLinecap="round" style={{ pathLength: link, opacity: link }} />
      {/* From the body's edge outward, inside the chapter's picture (framing.ts ART), so no ring crosses the copy. */}
      <Burst x={boo.x + boo.s / 2} y={boo.y + boo.s / 2} from={boo.s * 0.42} to={boo.s * 0.58} color={CYAN} t={burst} />
      <Burst x={casper.x + casper.s / 2} y={casper.y + casper.s / 2} from={casper.s * 0.42} to={casper.s * 0.54} color={GREEN} t={burst} />
      <Burst x={C.check[0]} y={C.check[1]} from={portrait ? 14 : 20} to={portrait ? 34 : 48} color={GREEN} t={burstMid} />
      <motion.g style={{ x: C.check[0], y: C.check[1], scale: check }}>
        <circle r={portrait ? 14 : 20} fill={INK} stroke={GREEN} strokeWidth="2.5" />
        <path d={portrait ? "M-6 0 l4 4 l8 -8" : "M-9 0 l6 6 l12 -12"} stroke={GREEN} strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>

      {/* The invitation itself, drawn centred on its origin so it scales about its centre. */}
      <motion.g style={{ x, y, scale, opacity: appear }}>
        {portrait ? <CompactCard t={card} glow={glow} ink={ink} /> : <FullCard t={card} glow={glow} ink={ink} />}
      </motion.g>
    </Stage>
  );
}

/** One ring bursting out of (x, y) once, as the app's "connected" rings do: it grows from \`from\` to \`to\`, fading as it goes. */
function Burst({ x, y, from, to, color, t }: { x: number; y: number; from: number; to: number; color: string; t: MV }) {
  const radius = useTransform(t, (v) => from + (to - from) * v);
  const opacity = useTransform(t, (v) => (v <= 0 || v >= 1 ? 0 : 0.9 * (1 - v)));
  return <motion.circle cx={x} cy={y} fill="none" stroke={color} strokeWidth={PAIR.stroke.ring * 1.25} style={{ r: radius, opacity }} />;
}

export function InviteScene({ eyebrow, label, steps, card }: { eyebrow: string; label: string; steps: SceneStep[]; card: Card }) {
  // Stills: the card held out beside Boo; the token mid-flight toward Casper; the connection drawn.
  return <SceneFrame id="invite" chapter="invite" eyebrow={eyebrow} label={label} steps={steps} stills={[0.3, 0.535, 0.88]} copyAt="left" visual={<Visual card={card} />} />;
}
