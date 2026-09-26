// The film: eight scenes on the music's grid (../timeline.js). Every style here is worked out from `t`, the
// film's time in seconds; nothing runs on the wall clock (film.css turns the app's own transitions off).
import { useState, type CSSProperties, type ReactNode } from "react";
import { InviteCard } from "../../../src/components/InviteCard";
import { TransportIcon } from "../../../src/components/TransportIcon";
import { StateIcon } from "../../../src/components/ConnectionIcon";
import { WalletCardFace } from "../../../src/components/WalletCardDeck";
import { NetworkTabs } from "../../../src/components/wallet/NetworkTabs";
import { NetworkTag } from "../../../src/components/NetworkTag";
import { IdCardFace } from "../../../src/components/identities/IdCardFace";
import { MessageBubble } from "../../../src/components/MessageBubble";
import { SecretGuardDialog } from "../../../src/components/SecretGuardDialog";
import { railOf } from "../../../src/components/walletCardTypes";
import { at, BEAT, BAR, M, DURATION } from "../timeline.js";
import { clamp, ease, lerp, life, prog, pulse, within } from "./motion";
import { IDS, INVITE, MAINNET, MESSAGES, SEED, TESTNET } from "./assets";

export const FORMATS = { "16x9": [1920, 1080], "9x16": [1080, 1920], "1x1": [1080, 1080] } as const;
export type Format = keyof typeof FORMATS;

type Props = { t: number; wide: boolean };
const GHOST_PATH = "M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z";

/** Something placed by its centre, `x`/`y` from the film's centre. */
function At({ x = 0, y = 0, s = 1, r = 0, o = 1, blur = 0, z, children, style, className }: {
  x?: number; y?: number; s?: number; r?: number; o?: number; blur?: number; z?: number; children: ReactNode; style?: CSSProperties; className?: string;
}) {
  if (o <= 0.001) return null;
  return <div className={`at ${className ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${r}deg) scale(${s})`, opacity: o, filter: blur > 0.2 ? `blur(${blur}px)` : undefined, zIndex: z, ...style }}>{children}</div>;
}

/** A word that snaps in on its beat (a scale and a blur that settle) and snaps out on `until`. */
function Word({ t, from, until, children, x = 0, y = 0, size = 150, color, weight = 800, s = 1 }: {
  t: number; from: number; until: number; children: ReactNode; x?: number; y?: number; size?: number; color?: string; weight?: number; s?: number;
}) {
  if (t < from - 0.001 || t > until + 0.2) return null;
  const pin = prog(t, from, 0.2), pout = prog(t, until, 0.12);
  const scale = lerp(1.45, 1, ease.outExpo(pin)) * lerp(1, 0.9, pout) * s;
  const o = clamp(pin * 3) * (1 - pout);
  const blur = (1 - ease.outExpo(pin)) * 16 + pout * 10;
  return <At x={x} y={y} s={scale} o={o} blur={blur}><span className="word" style={{ fontSize: size, color, fontWeight: weight }}>{children}</span></At>;
}

/** A decaying shake from `from`, the same on every render of the same frame. */
function shake(t: number, from: number, amp = 14, dur = 0.3): [number, number] {
  if (t < from || t > from + dur) return [0, 0];
  const p = (t - from) / dur, k = amp * (1 - p) ** 2;
  return [k * Math.sin((t - from) * 97), k * Math.cos((t - from) * 83)];
}

function Ghost({ size, color = "var(--theme-accent)", blink = 0, eye = "#0b141a" }: { size: number; color?: string; blink?: number; eye?: string }) {
  return <svg width={size} height={size} viewBox="0 0 40 44" className="ghost">
    <path d={GHOST_PATH} fill={color} />
    <g style={{ transform: `scaleY(${1 - 0.9 * blink})`, transformOrigin: "20px 20px" }}>
      <circle cx="13" cy="20" r="3" fill={eye} /><circle cx="27" cy="20" r="3" fill={eye} />
    </g>
  </svg>;
}
const blinkAt = (t: number, when: number) => { const p = prog(t, when, 0.16); return p <= 0 || p >= 1 ? 0 : Math.sin(p * Math.PI); };

/** A ring that bursts out from the centre on a hit. */
function Burst({ t, from, x = 0, y = 0, size = 520, color = "var(--film-glow)" }: { t: number; from: number; x?: number; y?: number; size?: number; color?: string }) {
  const p = prog(t, from, 0.6);
  if (p <= 0 || p >= 1) return null;
  return <At x={x} y={y} s={lerp(0.3, 1.4, ease.outExpo(p))} o={1 - p}><div className="burst" style={{ width: size, height: size, borderColor: color }} /></At>;
}

/** The natural height of each child, kept up to date as it lays out (its layout is the same on every frame). */
function useHeights() {
  const [heights, setHeights] = useState<number[]>([]);
  const [observer] = useState(() => new ResizeObserver((entries) => setHeights((old) => {
    const next = [...old];
    for (const entry of entries) next[Number((entry.target as HTMLElement).dataset.index)] = (entry.target as HTMLElement).offsetHeight;
    return next;
  })));
  const ref = (i: number) => (el: HTMLDivElement | null) => { if (el) { el.dataset.index = String(i); observer.observe(el); } };
  return { ref, heights };
}

// 1. The ghost and the name (bars 1-2)
function LogoScene({ t, wide }: Props) {
  const end = M.code;
  if (t >= end + 0.01) return null;
  const pop = ease.spring(prog(t, M.logo, 0.75));
  const moved = ease.outExpo(prog(t, M.word, 0.4));
  const out = prog(t, end - 0.12, 0.12);
  const [sx, sy] = shake(t, M.v1, 16);
  const ghostX = lerp(0, wide ? -470 : -300, moved), ghostS = lerp(1.9, 1, moved) * pop;
  const letters = [..."Ghostly"];
  return <div className="scene" style={{ transform: `translate(${sx}px, ${sy}px) scale(${lerp(1, 1.5, ease.inCubic(out))})`, opacity: 1 - out, filter: out ? `blur(${out * 12}px)` : undefined }}>
    <Burst t={t} from={M.logo} size={560} />
    <At x={ghostX} y={wide ? -10 : -40} s={ghostS}><Ghost size={180} blink={blinkAt(t, M.blink)} /></At>
    <At x={wide ? 60 : 40} y={wide ? 0 : -30}>
      <span className="word hero">{letters.map((letter, i) => {
        const p = prog(t, M.word + i * BEAT / 8, 0.32);
        return <span key={i} style={{ display: "inline-block", opacity: clamp(p * 3), transform: `translateY(${lerp(90, 0, ease.outBack(p))}px)` }}>{letter}</span>;
      })}</span>
    </At>
    <At x={wide ? 590 : 0} y={wide ? 8 : 190} s={lerp(2.6, 1, ease.outExpo(prog(t, M.v1, 0.2)))} o={clamp(prog(t, M.v1, 0.06))}>
      <span className="pill">v1.0</span>
    </At>
  </div>;
}

// 2. An invite, its QR, a knock (bars 3-4)
function InviteScene({ t, wide }: Props) {
  const from = M.code, end = M.oneChat;
  if (t < from || t >= end) return null;
  const typed = Math.floor(clamp((t - M.code) / (BEAT * 1.7)) * 30);
  const pillIn = ease.outExpo(prog(t, M.code, 0.3));
  const pillOut = prog(t, M.qr - 0.08, 0.1);
  const card = ease.spring(prog(t, M.qr, 0.6), 1.6);
  const aside = ease.outExpo(prog(t, M.knock, 0.35));
  const pair = ease.outExpo(prog(t, M.paired, 0.3));
  const out = prog(t, end - 0.14, 0.14);
  const knockPhase = (t: number) => { const k1 = prog(t, M.knock + 0.02, 0.12), k2 = prog(t, M.knock + 0.2, 0.12); return Math.sin(k1 * Math.PI) - Math.sin(k2 * Math.PI); };
  const contactX = lerp(wide ? 1300 : 900, wide ? 460 : 250, ease.outBack(prog(t, M.knock, 0.4), 1.4));
  const youX = wide ? -460 : -250;
  const cardX = lerp(0, youX, aside), cardS = lerp(wide ? 1.55 : 1.9, 1.0, aside) * card * (1 - pair);
  return <div className="scene" style={{ opacity: 1 - out, transform: `translateY(${-out * 120}px)` }}>
    <Word t={t} from={M.code} until={M.knock} y={wide ? -440 : -640} size={110}>Invite.</Word>
    <Word t={t} from={M.knock} until={M.paired} y={wide ? -440 : -640} size={110}>Knock knock.</Word>
    <Word t={t} from={M.paired} until={end} y={wide ? -440 : -640} size={110} color="var(--film-glow)">Paired.</Word>
    {t < M.qr + 0.05 && <At x={lerp(-1400, 0, pillIn)} s={lerp(1, 0.2, pillOut)} o={1 - pillOut}>
      <span className="code-pill"><b>ghostly1</b>{INVITE.slice(8, 8 + typed)}<span className="caret" />…</span>
    </At>}
    {t >= M.qr && pair < 1 && <At x={cardX} y={wide ? 50 : 0} s={cardS} style={{ "--qr-r": `${ease.outCubic(prog(t, M.qr, 0.35)) * 75}%` } as CSSProperties} className="qr-reveal">
      <div style={{ width: 384 }}><InviteCard code={INVITE} /></div>
    </At>}
    {t >= M.paired && <>
      <At x={youX} s={ease.spring(prog(t, M.paired, 0.5))}><Avatar name="You" color="var(--theme-accent)" /></At>
      <At x={(youX + 460) / 2 - (wide ? 0 : 105)} o={pair}>
        <div className="link-line" style={{ width: (wide ? 700 : 300) * pair }} />
      </At>
      <At s={ease.spring(prog(t, M.paired + 0.06, 0.5))}><div className="link-node"><TransportIcon transport="webrtc/1" size={64} weight={1.8} /></div></At>
    </>}
    {t >= M.knock && <At x={contactX} r={knockPhase(t) * 9}><Avatar name="Sam" color="#a78bfa" /></At>}
  </div>;
}

function Avatar({ name, color }: { name: string; color: string }) {
  return <div className="avatar"><div className="avatar-disc" style={{ background: color }}><Ghost size={120} color="#0b141a" eye={color} /></div><span>{name}</span></div>;
}

// 3. One chat, any path; the build (bars 5-7)
const PATHS: { at: number; label: string; icon: ReactNode }[] = [
  { at: M.webrtc, label: "WebRTC", icon: <TransportIcon transport="webrtc/1" size={150} weight={1.5} /> },
  { at: M.iroh, label: "Iroh", icon: <TransportIcon transport="iroh/1" size={150} weight={1.5} /> },
  { at: M.hyperdht, label: "HyperDHT", icon: <TransportIcon transport="hyperdht/1" size={150} weight={1.5} /> },
  { at: M.dht, label: "DHT", icon: <StateIcon kind="dht" size={150} weight={1.5} /> },
];
function PathScene({ t, wide }: Props) {
  if (t < M.oneChat || t >= M.drop) return null;
  const up = ease.outExpo(prog(t, M.webrtc, 0.3));
  const ringOut = prog(t, M.build - 0.12, 0.12);
  const title = (y: number) => lerp(y, (wide ? -420 : -600) + (y > 0 ? 95 : 0), up);
  return <div className="scene">
    <div style={{ opacity: 1 - ringOut }}>
      <Word t={t} from={M.oneChat} until={M.build - 0.12} y={title(-80)} s={lerp(1, 0.55, up)} size={170}>One chat.</Word>
      <Word t={t} from={M.anyPath} until={M.build - 0.12} y={title(110)} s={lerp(1, 0.55, up)} size={170} color="var(--film-glow)">Any path.</Word>
      {t >= M.webrtc && <>
        <At s={ease.spring(prog(t, M.webrtc, 0.5))} y={wide ? 20 : 0}><div className="ring" /></At>
        {PATHS.map((path, i) => {
          const next = PATHS[i + 1]?.at ?? M.build;
          if (t < path.at || t > next + 0.14) return null;
          const pin = prog(t, path.at, 0.34), pout = prog(t, next, 0.12);
          return <div key={path.label}>
            <Burst t={t} from={path.at} y={wide ? 20 : 0} size={330} />
            <At y={wide ? 20 : 0} s={ease.spring(pin, 1.7) * (1 - pout)} r={lerp(-120, 0, ease.outBack(pin))} o={1 - pout}><div className="path-icon">{path.icon}</div></At>
            <At y={(wide ? 270 : 260) + lerp(50, 0, ease.outExpo(pin)) - pout * 40} o={clamp(pin * 3) * (1 - pout)}><span className="word label">{path.label}</span></At>
          </div>;
        })}
      </>}
    </div>
    {M.buildHits.map((hit, i) => <Word key={i} t={t} from={hit} until={M.gap} size={130}
      x={wide ? [-560, 560, 0][i] : 0} y={wide ? [-330, -330, 360][i] : [-640, -470, 560][i]} color={i === 2 ? "var(--film-glow)" : undefined}>{["Pay.", "Get paid.", "Your way."][i]}</Word>)}
  </div>;
}

// 4. The drop: wallets (bars 7-11)
const CARD_W = 340, CARD_H = Math.round(340 / 1.586);
function WalletFace({ card }: { card: (typeof MAINNET)[number] }) {
  return <div className={`wallet-card-${railOf(card)} film-card`} style={{ width: CARD_W, height: CARD_H, "--card-w": `${CARD_W}px` } as CSSProperties}>
    <WalletCardFace card={card} />
  </div>;
}
function WalletScene({ t, wide }: Props) {
  if (t < M.build || t >= M.ids) return null;
  const n = MAINNET.length, mid = (n - 1) / 2;
  // The build: the stack comes up small and grows on each hit, holds its breath on the silent beat, then fans out.
  const bumps = M.buildHits.reduce((s, hit) => s + 0.1 * ease.spring(prog(t, hit, 0.4), 1.5), 0);
  const squeeze = ease.inCubic(prog(t, M.gap, BEAT)) * 0.12;
  const stackS = (0.7 + bumps - squeeze) * ease.outExpo(prog(t, M.build, 0.25));
  const [bx, by] = shake(t, M.drop, 22, 0.4);
  const dim = ease.outCubic(prog(t, M.real, 0.25));
  const out = prog(t, M.ids - 0.14, 0.14);
  const fanY = wide ? 20 : 0, spread = wide ? 9 : 7.5, radius = wide ? 1300 : 900;
  return <div className="scene" style={{ transform: `translate(${bx}px, ${by}px) scale(${1 + out * 0.4})`, opacity: 1 - out }}>
    <div style={{ opacity: 1 - 0.8 * dim, filter: dim ? `blur(${dim * 7}px)` : undefined }} className="scene">
      {MAINNET.map((card, i) => {
        const fan = ease.outExpo(prog(t, M.drop + Math.abs(i - mid) * 0.018, 0.6));
        const angle = (i - mid) * spread * fan;
        const rad = (angle * Math.PI) / 180;
        const float = Math.sin(t * 2.2 + i) * 5 * fan;
        let x = lerp((i - mid) * 5, radius * Math.sin(rad), fan);
        let y = lerp((i - mid) * -3, radius * (1 - Math.cos(rad)) + fanY + float, fan);
        let s = t < M.drop ? stackS : lerp(0.9, 1, fan);
        let r = lerp((i - mid) * 1.5, angle, fan);
        // The payment: the Cashu card lifts, and a payment leaves it.
        if (i === 3) {
          const lift = ease.outBack(prog(t, M.pay - 0.1, 0.25)) * (1 - ease.inCubic(prog(t, M.real, 0.2)));
          y -= 70 * lift; s *= 1 + 0.12 * lift; r *= 1 - lift;
        }
        const flip = prog(t, M.testnet + i * BEAT / 8, 0.3);
        const shown = flip < 0.5 ? card : TESTNET[i];
        const turn = flip <= 0 || flip >= 1 ? 0 : Math.sin(flip * Math.PI) * 90 * (flip < 0.5 ? 1 : -1);
        return <At key={card.id} x={x} y={y} s={s} r={r} z={i === 3 ? 20 : 10 - Math.abs(i - mid)}>
          <div style={{ transform: `perspective(1400px) rotateY(${turn}deg)` }}><WalletFace card={shown} /></div>
        </At>;
      })}
      {t >= M.pay && t < M.real + 0.3 && <PaymentShot t={t} />}
    </div>
    <Burst t={t} from={M.drop} size={900} />
    <Word t={t} from={M.wallets} until={M.tabs} y={wide ? 410 : 600} size={100}>Every wallet.</Word>
    {t >= M.tabs && <At y={wide ? -390 : -520} s={2.5 * ease.spring(prog(t, M.tabs, 0.5), 1.6)} o={1 - dim}>
      <div style={{ width: 420 }}><NetworkTabs network={t < M.testnet ? "mainnet" : "testnet"} counts={{ mainnet: 8, testnet: 8 }} onChange={() => {}} label="Networks" testId="tabs" tabTestId="tab" idPrefix="tab" controls="none" /></div>
    </At>}
    {t >= M.real && <>
      <At x={wide ? -430 : 0} y={wide ? -110 : -420} s={3.2 * ease.spring(prog(t, M.real, 0.5))}><NetworkTag network="mainnet" /></At>
      <Word t={t} from={M.real} until={M.ids - 0.14} x={wide ? -430 : 0} y={wide ? 20 : -270} size={120}>Real money.</Word>
      <At x={wide ? 430 : 0} y={wide ? -110 : 0} s={3.2 * ease.spring(prog(t, M.test, 0.5))} o={t >= M.test ? 1 : 0}><NetworkTag network="testnet" /></At>
      <Word t={t} from={M.test} until={M.ids - 0.14} x={wide ? 430 : 0} y={wide ? 20 : 150} size={120}>Test money.</Word>
      {t >= M.mixed && <At y={wide ? 0 : -140} o={1}><div className="divider" style={{ height: (wide ? 520 : 4), width: wide ? 4 : 700 * ease.outExpo(prog(t, M.mixed, 0.25)), transform: wide ? `scaleY(${ease.outExpo(prog(t, M.mixed, 0.25))})` : undefined }} /></At>}
      <Word t={t} from={M.mixed} until={M.ids - 0.14} y={wide ? 330 : 520} size={120} color="var(--film-glow)">Never mixed.</Word>
    </>}
  </div>;
}

function PaymentShot({ t }: { t: number }) {
  const p = prog(t, M.pay, 0.42);
  const x = lerp(0, 1300, ease.inCubic(p)), y = lerp(-60, -140, ease.outCubic(p));
  const o = 1 - prog(t, M.pay + 0.36, 0.08);
  return <>{[0.12, 0.06, 0].map((lag, k) => {
    const pk = prog(t - lag, M.pay, 0.42);
    return <At key={k} x={lerp(0, 1300, ease.inCubic(pk))} y={lerp(-60, -140, ease.outCubic(pk))} s={ease.spring(prog(t, M.pay, 0.3))} o={o * [0.18, 0.35, 1][k]} z={30}>
      <span className="pay-shot">⚡ 2,100 test sats<span className="pay-tag"><NetworkTag network="testnet" /></span></span>
    </At>;
  })}<At x={x} y={y} o={0}><span /></At></>;
}

// 5. Identities (bars 12-15)
const ID_W = 430, ID_H = Math.round(430 / 1.586);
function IdBack() {
  return <div className="id-back"><Ghost size={110} color="rgba(255,255,255,.16)" eye="transparent" /><span>GHOSTLY · IDENTITY</span></div>;
}
function IdScene({ t, wide }: Props) {
  if (t < M.ids || t >= M.chat) return null;
  const focus = ease.outExpo(prog(t, M.photo, 0.35));
  const leave = ease.inCubic(prog(t, M.shared, 0.3));
  const [sx, sy] = shake(t, M.verified, 18, 0.35);
  const pop = ease.spring(prog(t, M.photo, 0.55), 1.6);
  const slots = wide ? [-500, 0, 500] : [-250, 0, 250];
  return <div className="scene" style={{ transform: `translate(${sx}px, ${sy}px)`, "--photo-pop": pop } as CSSProperties}>
    <Word t={t} from={M.ids} until={M.verified} y={wide ? -420 : -640} size={110}>Your identities.</Word>
    <Word t={t} from={M.share} until={M.shared + 0.2} y={wide ? 420 : 640} size={110} color="var(--film-glow)">Yours to share.</Word>
    {IDS.map((card, i) => {
      const slide = ease.outExpo(prog(t, M.ids + i * BEAT / 4, 0.5));
      const flip = prog(t, M.flips[i], 0.34);
      const turn = lerp(180, 0, ease.outBack(flip, 1.2));
      const center = i === 1;
      let x = slots[i] * lerp(1, center ? 1 : 1.18, focus), y = lerp(900, 0, slide) + (center ? -20 * focus : 30 * focus);
      let s = (wide ? 1 : 0.85) * (center ? lerp(1, 1.3, focus) : lerp(1, 0.86, focus));
      let o = center ? 1 : 1 - 0.45 * focus;
      if (!wide) { y += [-420, 0, 420][i] * (1 - focus * 0) ; x = 0; }
      // Shared: the middle card flies into the chat, the others fall away.
      if (center) { x = lerp(x, wide ? -520 : 0, leave); y = lerp(y, wide ? 330 : 700, leave); s *= lerp(1, 0.2, leave); }
      else { y += leave * 900; o *= 1 - leave; }
      return <At key={card.id} x={x} y={y} s={s} o={o} r={lerp([-7, 0, 7][i], 0, slide) * (1 - focus)} z={center ? 10 : 1}>
        <div className="flip" style={{ width: ID_W, height: ID_H, transform: `perspective(1600px) rotateY(${turn}deg)` }}>
          <div className={`flip-face id-card-${card.provider} ${center ? "film-photo" : ""}`} style={{ "--card-w": `${ID_W}px` } as CSSProperties}><IdCardFace card={card} /></div>
          <div className="flip-face flip-back"><IdBack /></div>
        </div>
        {center && t >= M.verified && <div className="stamp" style={{ transform: `rotate(-14deg) scale(${lerp(3.2, 1, ease.outExpo(prog(t, M.verified, 0.18)))})`, opacity: clamp(prog(t, M.verified, 0.05)) }}>VERIFIED</div>}
      </At>;
    })}
  </div>;
}

// 6. The chat (bars 16-19)
const CHAT_AT = [M.markdown, M.invite, M.money, M.mention, M.codeBlock];
const LABELS = ["Markdown.", "Invites.", "Payments.", "Mentions.", "Code."];
function ChatScene({ t, wide }: Props) {
  const { ref, heights } = useHeights();
  const visible = within(t, M.chat, M.servers);
  const enter = ease.outExpo(prog(t, M.chat, 0.4));
  const out = ease.inCubic(prog(t, M.chatOut, 0.3));
  const big = ease.outExpo(prog(t, M.smart, 0.3));
  const typing = clamp((t - M.chat) / (M.markdown - M.chat - 0.05));
  const draft = t < M.markdown ? MESSAGES[0].text.slice(0, Math.round(typing * MESSAGES[0].text.length)) : "";
  const panelX = wide ? -380 : 0, panelY = wide ? 0 : -150;
  return <div className="scene" style={{ visibility: visible ? "visible" : "hidden", transform: `translateX(${-out * 1700}px)`, filter: out ? `blur(${out * 14}px)` : undefined }}>
    <At x={panelX + lerp(-700, 0, enter)} y={panelY} s={1.58 * lerp(1, 1.03, big)} o={enter}>
      <div className="phone">
        <div className="phone-header">
          <div className="phone-group"><Ghost size={22} color="#0b141a" eye="#a78bfa" /></div>
          <div className="phone-title"><b>Launch crew</b><span>Alice, Bo, you</span></div>
          <div className="phone-conn"><TransportIcon transport="iroh/1" size={18} weight={1.9} /></div>
        </div>
        <div className="phone-body">
          {MESSAGES.map((message, i) => {
            const p = ease.outExpo(prog(t, CHAT_AT[i], 0.3));
            const h = heights[i] ?? 0;
            return <div key={message.id} style={{ height: heights[i] === undefined ? undefined : h * p, overflow: "visible" }}>
              <div ref={ref(i)} style={{ transform: `translateY(${(1 - p) * 30}px) scale(${lerp(0.7, 1, ease.outBack(prog(t, CHAT_AT[i], 0.3), 1.3))})`, transformOrigin: message.sender === "me" ? "90% 100%" : "10% 100%", opacity: clamp(p * 2) }}>
                <MessageBubble message={message} peerNick={message.nick} peerPubKey="peer" />
              </div>
            </div>;
          })}
        </div>
        <div className="phone-composer"><span className="phone-input">{draft ? <span>{draft}<span className="caret" /></span> : <span className="muted">Message</span>}</span><span className="phone-send">➤</span></div>
      </div>
    </At>
    {LABELS.map((label, i) => {
      const p = prog(t, CHAT_AT[i], 0.25), later = CHAT_AT.filter((when) => t >= when).length - 1 - i;
      const y = (wide ? -260 : 470) + i * (wide ? 125 : 0);
      if (!wide && later > 0) return null;
      return <At key={label} x={(wide ? 430 : 0) + lerp(120, 0, ease.outExpo(p))} y={y - big * 60} o={clamp(p * 3) * (later > 0 ? 0.32 : 1) * (1 - big)}>
        <span className="word" style={{ fontSize: wide ? 96 : 110 }}>{label}</span>
      </At>;
    })}
    <Word t={t} from={M.smart} until={M.servers} x={wide ? 470 : 0} y={wide ? 0 : 560} size={wide ? 150 : 130} color="var(--film-glow)">Smart chat.</Word>
  </div>;
}

// 7. Private by design (bars 20-22)
function PrivateScene({ t, wide }: Props) {
  if (t < M.servers || t >= M.words[0]) return null;
  const typed = SEED.slice(0, Math.round(clamp((t - M.seed) / (M.guard - M.seed - 0.1)) * SEED.length));
  const composer = life(t, M.seed, M.safeOut, 0.25, 0.2, ease.outExpo);
  const [sx, sy] = shake(t, M.guard, 24, 0.4);
  const guardOn = within(t, M.guard, M.safeOut + 0.2);
  const guardS = guardOn ? (wide ? 2.2 : 2.4) * ease.spring(prog(t, M.guard, 0.5), 1.8) * (1 - ease.inCubic(prog(t, M.safeOut, 0.2))) : 0;
  document.documentElement.style.setProperty("--guard-s", String(Math.max(guardS, 0.001)));
  document.documentElement.style.setProperty("--guard-x", `${sx}px`);
  document.documentElement.style.setProperty("--guard-y", `${sy + (wide ? -60 : -120)}px`);
  return <div className="scene">
    <div className="scene" style={{ opacity: 1 - prog(t, M.seed - 0.12, 0.12) }}>
      {[-1, 0, 1].map((k) => {
        const p = prog(t, M.servers + (k + 1) * 0.05, 0.6);
        return <At key={k} x={k * 190} y={wide ? -300 : -520} o={p <= 0 ? 0 : 1 - ease.inCubic(p)} s={lerp(1, 0.7, p)} blur={p * 10}><Server struck={p > 0.05} /></At>;
      })}
      <Word t={t} from={M.servers} until={M.seed - 0.12} y={wide ? -20 : -250} size={170}>No servers.</Word>
      <At x={wide ? -330 : -250} y={wide ? 190 : 20} s={ease.spring(prog(t, M.keys, 0.5))}><Key /></At>
      <Word t={t} from={M.keys} until={M.seed - 0.12} x={wide ? 60 : 50} y={wide ? 190 : 20} size={150} color="var(--film-glow)">Your keys.</Word>
    </div>
    <At x={sx} y={(wide ? 330 : 420) + sy + lerp(200, 0, composer)} o={composer}>
      <div className="composer" style={{ width: wide ? 1300 : 960 }}><span className={typed ? "" : "muted"}>{typed || "Message"}{typed && <span className="caret" />}</span><span className="phone-send big" style={{ transform: `scale(${1 - 0.2 * Math.sin(prog(t, M.guard - 0.12, 0.2) * Math.PI)})` }}>➤</span></div>
    </At>
    {guardOn && <SecretGuardDialog finding={{ kind: "mnemonic" }} recipient="Launch crew" onCancel={() => {}} onConfirm={() => {}} />}
    <Word t={t} from={M.safe} until={M.words[0] - 0.1} y={wide ? 430 : 700} size={110} color="var(--film-glow)">Leak stopped.</Word>
  </div>;
}
function Server({ struck }: { struck: boolean }) {
  return <svg width="130" height="130" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="1.4" strokeLinecap="round">
    <rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01" />
    {struck && <path d="M2 22 22 2" stroke="#ff6b5e" strokeWidth="2" />}
  </svg>;
}
function Key() {
  return <svg width="150" height="150" viewBox="0 0 24 24" fill="none" stroke="var(--film-glow)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2" />
  </svg>;
}

// 8. The outro (bars 23-24)
function OutroScene({ t, wide }: Props) {
  if (t < M.words[0]) return null;
  const gone = prog(t, M.gap2, 0.15);
  const land = ease.spring(prog(t, M.end, 0.8), 1.6);
  return <div className="scene">
    {t < M.end && ["Private.", "Peer-to-peer.", "Yours."].map((word, i) => (
      <div key={word} style={{ opacity: 1 - gone }}>
        <Word t={t} from={M.words[i]} until={M.gap2} y={(i - 1) * (wide ? 170 : 190)} size={wide ? 160 : 140} color={i === 2 ? "var(--film-glow)" : undefined}>{word}</Word>
      </div>
    ))}
    {t >= M.end && <>
      <Burst t={t} from={M.end} size={700} y={-120} />
      <Burst t={t} from={M.end + 0.08} size={1100} y={-120} />
      <At y={wide ? -150 : -220} s={land}><Ghost size={230} blink={blinkAt(t, at(24, 3))} /></At>
      <At y={wide ? 110 : 60} s={lerp(1.3, 1, ease.outExpo(prog(t, M.end, 0.3)))} o={clamp(prog(t, M.end, 0.08))}>
        <span className="word hero end">Ghostly <span className="pill">v1.0</span></span>
      </At>
      <At y={wide ? 250 : 220} o={ease.outCubic(prog(t, at(24, 2), 0.3))}><span className="url">ghostly.tools</span></At>
    </>}
  </div>;
}

export function Film({ t, format }: { t: number; format: Format }) {
  const [W, H] = FORMATS[format];
  const wide = format === "16x9";
  // The kick in the picture: the glow breathes on every beat, harder from the drop on and softer in the breakdown.
  const breakdown = within(t, M.servers, M.words[0]);
  const kick = t >= M.end ? 0 : pulse(t, 0) * (t >= M.drop && !breakdown ? 1 : breakdown ? 0.15 : 0.45);
  const flash = [M.logo, M.drop, M.end].reduce((f, hit) => Math.max(f, (1 - prog(t, hit, hit === M.drop ? 0.35 : 0.25)) * (t >= hit ? 1 : 0)), 0);
  const black = t >= M.gap2 && t < M.end ? 1 : t >= M.gap && t < M.drop ? 0.55 : 0;
  const zoom = 1 + 0.008 * kick;
  const fadeIn = clamp(t / 0.05), fadeOut = 1 - clamp((t - (DURATION - 0.12)) / 0.12);
  return <div className="film" style={{ width: W, height: H, "--kick": kick } as CSSProperties} data-bar={Math.floor(t / BAR) + 1}>
    <div className="film-bg" style={{ opacity: breakdown ? 0.55 : 1 }} />
    <div className="film-camera" style={{ transform: `scale(${zoom})` }}>
      <LogoScene t={t} wide={wide} />
      <InviteScene t={t} wide={wide} />
      <PathScene t={t} wide={wide} />
      <WalletScene t={t} wide={wide} />
      <IdScene t={t} wide={wide} />
      <ChatScene t={t} wide={wide} />
      <PrivateScene t={t} wide={wide} />
      <OutroScene t={t} wide={wide} />
    </div>
    <div className="film-flash" style={{ opacity: flash * 0.55 }} />
    <div className="film-black" style={{ opacity: Math.max(black * 0.8, 1 - fadeIn * fadeOut) }} />
    <div className="film-vignette" />
  </div>;
}
