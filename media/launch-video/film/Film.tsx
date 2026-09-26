// The film: eight scenes on the music's grid (../timeline.js). Every style here is worked out from `t`, the
// film's time in seconds; nothing runs on the wall clock (film.css turns the app's own transitions off).
//
// The motion is calm on purpose: things arrive on the beat and settle (eased, never bouncing), one idea at a time,
// and stay long enough to be read. Nothing pulses or shakes with the kick.
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
import { clamp, ease, lerp, prog, within } from "./motion";
import { IDS, INVITE, MAINNET, MESSAGES, SEED, TESTNET } from "./assets";

export const FORMATS = { "16x9": [1920, 1080], "9x16": [1080, 1920], "1x1": [1080, 1080] } as const;
export type Format = keyof typeof FORMATS;

type Props = { t: number; wide: boolean };
const GHOST_PATH = "M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z";
/** How long an arrival takes to settle, and a leaving to go. */
const IN = 0.45, OUT = 0.28;

/** Something placed by its centre, `x`/`y` from the film's centre. */
function At({ x = 0, y = 0, s = 1, r = 0, o = 1, blur = 0, z, children, style, className }: {
  x?: number; y?: number; s?: number; r?: number; o?: number; blur?: number; z?: number; children: ReactNode; style?: CSSProperties; className?: string;
}) {
  if (o <= 0.001) return null;
  return <div className={`at ${className ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${r}deg) scale(${s})`, opacity: o, filter: blur > 0.2 ? `blur(${blur}px)` : undefined, zIndex: z, ...style }}>{children}</div>;
}

/** 0→1 as something arrives at `from`, 1→0 as it leaves at `until` (leaving is done by `until`, the next beat). */
function presence(t: number, from: number, until = Infinity) {
  return ease.outCubic(prog(t, from, IN)) * (1 - ease.inOutCubic(prog(t, until - OUT, OUT)));
}

/** A word that rises into place on its beat and fades before `until`. */
function Word({ t, from, until = Infinity, children, x = 0, y = 0, size = 150, color, weight = 800, s = 1 }: {
  t: number; from: number; until?: number; children: ReactNode; x?: number; y?: number; size?: number; color?: string; weight?: number; s?: number;
}) {
  if (t < from - 0.001 || t > until) return null;
  const pin = ease.outCubic(prog(t, from, IN)), pout = ease.inOutCubic(prog(t, until - OUT, OUT));
  return <At x={x} y={y + (1 - pin) * 30 - pout * 16} s={lerp(0.97, 1, pin) * s} o={pin * (1 - pout)} blur={(1 - pin) * 6}>
    <span className="word" style={{ fontSize: size, color, fontWeight: weight }}>{children}</span>
  </At>;
}

function Ghost({ size, color = "var(--theme-accent)", blink = 0, eye = "#0b141a" }: { size: number; color?: string; blink?: number; eye?: string }) {
  return <svg width={size} height={size} viewBox="0 0 40 44" className="ghost">
    <path d={GHOST_PATH} fill={color} />
    <g style={{ transform: `scaleY(${1 - 0.9 * blink})`, transformOrigin: "20px 20px" }}>
      <circle cx="13" cy="20" r="3" fill={eye} /><circle cx="27" cy="20" r="3" fill={eye} />
    </g>
  </svg>;
}
const blinkAt = (t: number, when: number) => { const p = prog(t, when, 0.2); return p <= 0 || p >= 1 ? 0 : Math.sin(p * Math.PI); };

/** A soft ring that spreads from a big moment (the first beat, the drop, the last hit). */
function Ring({ t, from, x = 0, y = 0, size = 520 }: { t: number; from: number; x?: number; y?: number; size?: number }) {
  const p = prog(t, from, 1.2);
  if (p <= 0 || p >= 1) return null;
  return <At x={x} y={y} s={lerp(0.5, 1.5, ease.outCubic(p))} o={0.7 * (1 - p)}><div className="burst" style={{ width: size, height: size }} /></At>;
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
  const end = M.invite;
  if (t >= end) return null;
  const come = ease.outCubic(prog(t, M.logo, 0.8));
  const moved = ease.outCubic(prog(t, M.word, 0.6));
  const out = presence(t, -1, end);
  return <div className="scene" style={{ opacity: out }}>
    <Ring t={t} from={M.logo} size={560} />
    <At x={lerp(0, wide ? -470 : -300, moved)} y={lerp(-10, wide ? -10 : -40, moved)} s={lerp(1.8, 1, moved) * lerp(0.88, 1, come)} o={come}>
      <Ghost size={180} blink={blinkAt(t, M.blink)} />
    </At>
    <At x={wide ? 60 : 40} y={wide ? 0 : -30}>
      <span className="word hero">{[..."Ghostly"].map((letter, i) => {
        const p = ease.outCubic(prog(t, M.word + BEAT / 2 + i * BEAT / 8, 0.5));
        return <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 50}px)` }}>{letter}</span>;
      })}</span>
    </At>
    <At x={wide ? 590 : 0} y={wide ? 8 : 190} s={lerp(0.9, 1, ease.outCubic(prog(t, M.v1, IN)))} o={ease.outCubic(prog(t, M.v1, 0.3))}>
      <span className="pill">v1.0</span>
    </At>
  </div>;
}

// 2. An invite, a knock, connected (bars 3-4)
function InviteScene({ t, wide }: Props) {
  const from = M.invite, end = M.oneChat;
  if (t < from || t >= end) return null;
  const card = ease.outCubic(prog(t, M.invite, 0.6));
  const aside = ease.outCubic(prog(t, M.knock, 0.7));
  const pair = ease.outCubic(prog(t, M.paired, 0.6)), cardGone = ease.outCubic(prog(t, M.paired, 0.25));
  const scene = presence(t, from, end);
  const youX = wide ? -460 : -250, samX = wide ? 460 : 250;
  return <div className="scene" style={{ opacity: scene }}>
    <Word t={t} from={M.invite} until={M.knock} y={wide ? -420 : -640} size={110}>Invite.</Word>
    <Word t={t} from={M.knock} y={wide ? -420 : -640} size={110}>Knock knock.</Word>
    {cardGone < 1 && <At x={lerp(0, youX, aside)} y={lerp(wide ? 50 : 0, 0, aside)} s={lerp(wide ? 1.55 : 1.9, 0.9, aside) * lerp(0.94, 1, card)} o={card * (1 - cardGone)}
      style={{ "--qr-r": `${ease.outCubic(prog(t, M.invite, 0.7)) * 75}%` } as CSSProperties} className="qr-reveal">
      <div style={{ width: 384 }}><InviteCard code={INVITE} /></div>
    </At>}
    {t >= M.paired && <>
      <At x={youX} o={pair}><Avatar name="You" color="var(--theme-accent)" /></At>
      <At x={(youX + samX) / 2} o={pair}><div className="link-line" style={{ width: (samX - youX - 240) * pair }} /></At>
      <At o={ease.outCubic(prog(t, M.paired + 0.3, 0.4))}><div className="link-node"><TransportIcon transport="webrtc/1" size={64} weight={1.8} /></div></At>
    </>}
    {t >= M.knock && <At x={lerp(wide ? 1250 : 800, samX, ease.outCubic(prog(t, M.knock, 0.7)))}><Avatar name="Sam" color="#a78bfa" /></At>}
  </div>;
}

function Avatar({ name, color }: { name: string; color: string }) {
  return <div className="avatar"><div className="avatar-disc" style={{ background: color }}><Ghost size={120} color="#0b141a" eye={color} /></div><span>{name}</span></div>;
}

// 3. One chat, any path (bars 5-7)
const PATHS: { label: string; icon: ReactNode }[] = [
  { label: "WebRTC", icon: <TransportIcon transport="webrtc/1" size={150} weight={1.5} /> },
  { label: "Iroh", icon: <TransportIcon transport="iroh/1" size={150} weight={1.5} /> },
  { label: "HyperDHT", icon: <TransportIcon transport="hyperdht/1" size={150} weight={1.5} /> },
  { label: "DHT", icon: <StateIcon kind="dht" size={150} weight={1.5} /> },
];
function PathScene({ t, wide }: Props) {
  const end = M.drop;
  if (t < M.oneChat || t >= end) return null;
  const up = ease.outCubic(prog(t, M.paths[0], 0.6));
  const scene = presence(t, M.oneChat, end);
  const title = (y: number) => lerp(y, (wide ? -410 : -600) + (y > 0 ? 90 : 0), up);
  return <div className="scene" style={{ opacity: scene }}>
    <Word t={t} from={M.oneChat} y={title(-80)} s={lerp(1, 0.55, up)} size={170}>One chat.</Word>
    <Word t={t} from={M.anyPath} y={title(110)} s={lerp(1, 0.55, up)} size={170} color="var(--film-glow)">Any path.</Word>
    {t >= M.paths[0] && <>
      <At y={wide ? 40 : 0} s={lerp(0.9, 1, ease.outCubic(prog(t, M.paths[0], 0.6)))} o={ease.outCubic(prog(t, M.paths[0], 0.5))}><div className="ring" /></At>
      {PATHS.map((path, i) => {
        const from = M.paths[i], next = M.paths[i + 1] ?? Infinity;
        if (t < from || t > next + 0.3) return null;
        const pin = ease.outCubic(prog(t, from, 0.4)), pout = ease.inOutCubic(prog(t, next, 0.3));
        return <div key={path.label}>
          <At y={wide ? 40 : 0} s={lerp(0.8, 1, pin) * lerp(1, 0.8, pout)} o={pin * (1 - pout)}><div className="path-icon">{path.icon}</div></At>
          <At y={(wide ? 290 : 260) + (1 - pin) * 24 - pout * 20} o={pin * (1 - pout)}><span className="word label">{path.label}</span></At>
        </div>;
      })}
    </>}
  </div>;
}

// 4. The drop: wallets (bars 8-12)
const CARD_W = 340, CARD_H = Math.round(340 / 1.586);
function WalletFace({ card }: { card: (typeof MAINNET)[number] }) {
  return <div className={`wallet-card-${railOf(card)} film-card`} style={{ width: CARD_W, height: CARD_H, "--card-w": `${CARD_W}px` } as CSSProperties}>
    <WalletCardFace card={card} />
  </div>;
}
function WalletScene({ t, wide }: Props) {
  const end = M.ids;
  if (t < M.drop || t >= end) return null;
  const n = MAINNET.length, mid = (n - 1) / 2;
  const dim = ease.outCubic(prog(t, M.real, 0.5));
  const scene = presence(t, M.drop, end);
  const fanY = wide ? 20 : 0, spread = wide ? 9 : 7.5, radius = wide ? 1300 : 900;
  const tabs = presence(t, M.tabs, M.real + OUT);
  return <div className="scene" style={{ opacity: scene }}>
    <div style={{ opacity: 1 - 0.8 * dim, filter: dim ? `blur(${dim * 7}px)` : undefined }} className="scene">
      {MAINNET.map((card, i) => {
        const fan = ease.outExpo(prog(t, M.drop, 1.1));
        const angle = (i - mid) * spread * fan, rad = (angle * Math.PI) / 180;
        let y = lerp(0, radius * (1 - Math.cos(rad)) + fanY, fan);
        let s = lerp(0.8, 1, fan);
        let r = angle;
        // The payment: the Cashu card lifts, and a payment leaves it.
        if (i === 3) {
          const lift = ease.outCubic(prog(t, M.pay, 0.4)) * (1 - ease.outCubic(prog(t, M.real, 0.4)));
          y -= 70 * lift; s *= 1 + 0.1 * lift; r *= 1 - lift;
        }
        const flip = prog(t, M.testnet + i * BEAT / 8, 0.45);
        const shown = flip < 0.5 ? card : TESTNET[i];
        const turn = flip <= 0 || flip >= 1 ? 0 : Math.sin(flip * Math.PI) * 90 * (flip < 0.5 ? 1 : -1);
        return <At key={card.id} x={radius * Math.sin(rad)} y={y} s={s} r={r} o={ease.outCubic(prog(t, M.drop, 0.25))} z={i === 3 ? 20 : 10 - Math.abs(i - mid)}>
          <div style={{ transform: `perspective(1400px) rotateY(${turn}deg)` }}><WalletFace card={shown} /></div>
        </At>;
      })}
      {t >= M.pay && t < M.real + 0.5 && <PaymentShot t={t} />}
    </div>
    <Ring t={t} from={M.drop} size={900} />
    <Word t={t} from={M.wallets} until={M.tabs} y={wide ? 410 : 600} size={100}>Every wallet.</Word>
    {t >= M.tabs && <At y={(wide ? -390 : -520) + (1 - tabs) * 20} s={2.5} o={tabs}>
      <div style={{ width: 420 }}><NetworkTabs network={t < M.testnet ? "mainnet" : "testnet"} counts={{ mainnet: 8, testnet: 8 }} onChange={() => {}} label="Networks" testId="tabs" tabTestId="tab" idPrefix="tab" controls="none" /></div>
    </At>}
    {t >= M.real && <>
      <At x={wide ? -430 : 0} y={wide ? -110 : -420} s={3.2} o={presence(t, M.real)}><NetworkTag network="mainnet" /></At>
      <Word t={t} from={M.real} x={wide ? -430 : 0} y={wide ? 20 : -270} size={120}>Real money.</Word>
      <At x={wide ? 430 : 0} y={wide ? -110 : 0} s={3.2} o={presence(t, M.test)}><NetworkTag network="testnet" /></At>
      <Word t={t} from={M.test} x={wide ? 430 : 0} y={wide ? 20 : 150} size={120}>Test money.</Word>
      {t >= M.mixed && <At y={wide ? 0 : -140} o={presence(t, M.mixed)}><div className="divider" style={{ height: wide ? 520 * ease.outCubic(prog(t, M.mixed, 0.6)) : 4, width: wide ? 4 : 700 * ease.outCubic(prog(t, M.mixed, 0.6)) }} /></At>}
      <Word t={t} from={M.mixed} y={wide ? 330 : 520} size={120} color="var(--film-glow)">Never mixed.</Word>
    </>}
  </div>;
}

function PaymentShot({ t }: { t: number }) {
  const p = ease.outCubic(prog(t, M.pay, 0.9));
  const o = ease.outCubic(prog(t, M.pay, 0.25)) * (1 - ease.inCubic(prog(t, M.pay + 0.6, 0.35)));
  return <At x={lerp(0, 820, p)} y={lerp(-110, -170, p)} o={o} z={30}>
    <span className="pay-shot">2,100 test sats <span aria-hidden="true">→</span></span>
  </At>;
}

// 5. Identities (bars 13-16)
const ID_W = 430, ID_H = Math.round(430 / 1.586);
function IdBack() {
  return <div className="id-back"><Ghost size={110} color="rgba(255,255,255,.16)" eye="transparent" /><span>GHOSTLY · IDENTITY</span></div>;
}
function IdScene({ t, wide }: Props) {
  const end = M.chat;
  if (t < M.ids || t >= end) return null;
  const focus = ease.outCubic(prog(t, M.photo, 0.6));
  const scene = presence(t, M.ids, end);
  const photo = ease.outCubic(prog(t, M.photo + 0.15, 0.5));
  const slots = wide ? [-600, 0, 600] : [-250, 0, 250];
  return <div className="scene" style={{ opacity: scene, "--photo-pop": photo } as CSSProperties}>
    <Word t={t} from={M.ids} until={M.share} y={wide ? -420 : -640} size={110}>Your identities.</Word>
    <Word t={t} from={M.share} y={wide ? -420 : -640} size={110} color="var(--film-glow)">Yours to share.</Word>
    {IDS.map((card, i) => {
      const slide = ease.outCubic(prog(t, M.ids + i * BEAT / 4, 0.7));
      const turn = lerp(180, 0, ease.outCubic(prog(t, M.flips[i], 0.5)));
      const center = i === 1;
      let x = slots[i] * lerp(1, center ? 1 : 1.12, focus), y = lerp(500, 0, slide) + (center ? -20 * focus : 30 * focus);
      const s = (wide ? 1.22 : 0.85) * (center ? lerp(1, 1.4, focus) : lerp(1, 0.8, focus));
      const o = slide * (center ? 1 : 1 - 0.45 * focus) * (center ? 1 : 1 - ease.outCubic(prog(t, M.shared, 0.5)));
      if (!wide) { y += [-420, 0, 420][i]; x = 0; }
      return <At key={card.id} x={x} y={y} s={s} o={o} z={center ? 10 : 1}>
        <div className="flip" style={{ width: ID_W, height: ID_H, transform: `perspective(1600px) rotateY(${turn}deg)` }}>
          <div className={`flip-face id-card-${card.provider} ${center ? "film-photo" : ""}`} style={{ "--card-w": `${ID_W}px` } as CSSProperties}><IdCardFace card={card} /></div>
          <div className="flip-face flip-back"><IdBack /></div>
        </div>
        {center && t >= M.verified && <div className="stamp" style={{ transform: `rotate(-14deg) scale(${lerp(1.3, 1, ease.outCubic(prog(t, M.verified, 0.3)))})`, opacity: ease.outCubic(prog(t, M.verified, 0.15)) }}>VERIFIED</div>}
      </At>;
    })}
  </div>;
}

// 6. The chat (bars 17-20): one message a bar, the list of what they show growing beside it
const FEATURES = ["Markdown", "Invites", "Payments", "Mentions"];
function ChatScene({ t, wide }: Props) {
  const { ref, heights } = useHeights();
  const end = M.seed;
  const visible = within(t, M.chat, end);
  const enter = ease.outCubic(prog(t, M.chat, 0.7));
  const out = ease.outCubic(prog(t, M.chatOut, end - M.chatOut));
  const first = M.messages[0];
  const draft = t < first ? MESSAGES[0].text.slice(0, Math.round(clamp((t - M.chat - 0.2) / (first - M.chat - 0.35)) * MESSAGES[0].text.length)) : "";
  const panelX = wide ? -380 : 0, panelY = wide ? 0 : -150;
  return <div className="scene" style={{ visibility: visible ? "visible" : "hidden", opacity: 1 - out }}>
    <At x={panelX + lerp(-240, 0, enter) - out * 120} y={panelY} s={1.58} o={enter}>
      <div className="phone">
        <div className="phone-header">
          <div className="phone-group"><Ghost size={22} color="#0b141a" eye="#a78bfa" /></div>
          <div className="phone-title"><b>Launch crew</b><span>Alice, Bo, you</span></div>
          <div className="phone-conn"><TransportIcon transport="iroh/1" size={18} weight={1.9} /></div>
        </div>
        <div className="phone-body">
          {MESSAGES.slice(0, M.messages.length).map((message, i) => {
            const p = ease.outCubic(prog(t, M.messages[i], 0.5));
            return <div key={message.id} style={{ height: heights[i] === undefined ? undefined : heights[i] * ease.outCubic(prog(t, M.messages[i], 0.35)) }}>
              <div ref={ref(i)} className="bubble-slot" style={{ transform: `translateY(${(1 - p) * 18}px)`, opacity: p }}>
                <MessageBubble message={message} peerNick={message.nick} peerPubKey="peer" />
              </div>
            </div>;
          })}
        </div>
        <div className="phone-composer"><span className="phone-input">{draft ? <span>{draft}<span className="caret" /></span> : <span className="muted">Message</span>}</span><span className="phone-send">➤</span></div>
      </div>
    </At>
    <Word t={t} from={M.chat} x={wide ? 430 : 0} y={wide ? -250 : 470} size={wide ? 140 : 120} color="var(--film-glow)">Smart chat.</Word>
    {wide && FEATURES.map((label, i) => (
      <Word key={label} t={t} from={M.messages[i]} x={430} y={-90 + i * 100} size={72} weight={700} color="#cfe0db">{label}</Word>
    ))}
  </div>;
}

// 7. Private by design (bars 21-22)
function PrivateScene({ t, wide }: Props) {
  const end = M.words[0];
  if (t < M.seed || t >= end) return null;
  const typed = SEED.slice(0, Math.round(clamp((t - M.seed - 0.15) / (M.guard - M.seed - 0.35)) * SEED.length));
  const scene = presence(t, M.seed, M.safeOut + OUT);
  const guardOn = within(t, M.guard, M.safeOut + OUT);
  const guard = guardOn ? ease.outCubic(prog(t, M.guard, 0.35)) * (1 - ease.inOutCubic(prog(t, M.safeOut, OUT))) : 0;
  document.documentElement.style.setProperty("--guard-s", String(Math.max((wide ? 2.2 : 2.4) * lerp(0.92, 1, guard), 0.001)));
  document.documentElement.style.setProperty("--guard-o", String(guard));
  document.documentElement.style.setProperty("--guard-y", `${wide ? -40 : -120}px`);
  return <div className="scene" style={{ opacity: scene }}>
    <Word t={t} from={M.seed} y={wide ? -420 : -700} size={120}>Your keys stay yours.</Word>
    <At y={(wide ? 330 : 420) + (1 - scene) * 30}>
      <div className="composer" style={{ width: wide ? 1300 : 960 }}><span className={typed ? "" : "muted"}>{typed ? (typed.length > 50 ? "…" + typed.slice(-50) : typed) : "Message"}{typed && <span className="caret" />}</span><span className="phone-send big">➤</span></div>
    </At>
    {guardOn && <SecretGuardDialog finding={{ kind: "mnemonic" }} recipient="Launch crew" onCancel={() => {}} onConfirm={() => {}} />}
    <Word t={t} from={M.safe} y={wide ? 450 : 700} size={100} color="var(--film-glow)">Leak stopped.</Word>
  </div>;
}

// 8. The outro (bars 23-24)
function OutroScene({ t, wide }: Props) {
  if (t < M.words[0]) return null;
  const land = ease.outCubic(prog(t, M.end, 0.8));
  return <div className="scene">
    {t < M.end && ["Private.", "Peer-to-peer.", "Yours."].map((word, i) => (
      <Word key={word} t={t} from={M.words[i]} until={M.gap2 + OUT * 0.6} y={(i - 1) * (wide ? 170 : 190)} size={wide ? 160 : 140} color={i === 2 ? "var(--film-glow)" : undefined}>{word}</Word>
    ))}
    {t >= M.end && <>
      <Ring t={t} from={M.end} size={800} y={-120} />
      <At y={wide ? -150 : -220} s={lerp(0.85, 1, land)} o={land}><Ghost size={230} blink={blinkAt(t, at(24, 3))} /></At>
      <At y={(wide ? 110 : 60) + (1 - land) * 24} o={land}><span className="word hero end">Ghostly <span className="pill">v1.0</span></span></At>
      <At y={wide ? 250 : 220} o={ease.outCubic(prog(t, at(24, 2), 0.5))}><span className="url">ghostly.tools</span></At>
    </>}
  </div>;
}

export function Film({ t, format }: { t: number; format: Format }) {
  const [W, H] = FORMATS[format];
  const wide = format === "16x9";
  const breakdown = within(t, M.seed, M.words[0]);
  // One soft light on the drop and on the last hit; the silent beats before them go dark.
  const flash = [M.drop, M.end].reduce((f, hit) => Math.max(f, t >= hit ? 1 - ease.outCubic(prog(t, hit, 0.6)) : 0), 0);
  const black = t >= M.gap2 && t < M.end ? 0.85 : t >= M.gap && t < M.drop ? 0.45 : 0;
  const fadeIn = clamp(t / 0.05), fadeOut = 1 - clamp((t - (DURATION - 0.3)) / 0.3);
  return <div className="film" style={{ width: W, height: H }} data-bar={Math.floor(t / BAR) + 1}>
    <div className="film-bg" style={{ opacity: breakdown ? 0.6 : 1 }} />
    <div className="film-camera">
      <LogoScene t={t} wide={wide} />
      <InviteScene t={t} wide={wide} />
      <PathScene t={t} wide={wide} />
      <WalletScene t={t} wide={wide} />
      <IdScene t={t} wide={wide} />
      <ChatScene t={t} wide={wide} />
      <PrivateScene t={t} wide={wide} />
      <OutroScene t={t} wide={wide} />
    </div>
    <div className="film-flash" style={{ opacity: flash * 0.3 }} />
    <div className="film-black" style={{ opacity: Math.max(black, 1 - fadeIn * fadeOut) }} />
    <div className="film-vignette" />
  </div>;
}
