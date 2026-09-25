"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Ghost, type GhostMood } from "@/components/ghost/Ghost";
import { CALM_QUERY, useCalm } from "@/lib/useCalm";
import { DUR } from "@/lib/motion";
import { REPO_URL } from "@/content/shell";
import type { DevCopy } from "@/content/developers";
import "@/app/negotiation.css";

/**
 * The paired-session rule as a looping picture: two peers face each other, each
 * with its offer (transports in its own order, then capabilities); the result
 * card in the middle fills in as the offers are compared. Four scenarios, about
 * seven seconds each; a beam from each peer carries its offer into the card.
 * A pick holds that scenario for twelve seconds; hover or focus holds it at its
 * end; off screen the loop stops. Reduced motion and no-JS show the desktop ↔
 * browser case as a finished still.
 */

// ── The rule, mirrored from packages/core/src/pairedTransports.ts ────────────
const TRANSPORTS = ["iroh/1", "hyperdht/1", "webrtc/1"] as const;
type Transport = (typeof TRANSPORTS)[number];

/** Symmetric rank sum; the fixed order breaks ties deterministically. */
function rankTransports(local: readonly string[], remote: readonly string[]): Transport[] {
  return TRANSPORTS.filter((t) => local.includes(t) && remote.includes(t)).sort(
    (a, b) =>
      local.indexOf(a) + remote.indexOf(a) - (local.indexOf(b) + remote.indexOf(b)) || TRANSPORTS.indexOf(a) - TRANSPORTS.indexOf(b),
  );
}
/** What a peer offers: its preferred adapter first, then the rest it has, only with fallback on. */
function transportOrder(available: readonly Transport[], preferred: Transport, fallback: boolean): Transport[] {
  const rest = TRANSPORTS.filter((t) => available.includes(t) && t !== preferred);
  return [...(available.includes(preferred) ? [preferred] : []), ...(fallback ? rest : [])];
}

const DESKTOP: readonly Transport[] = TRANSPORTS;
const BROWSER: readonly Transport[] = ["webrtc/1"];
const CHAT = "chat/1";
const FILES = "files/2";
const CASHU = "payments-cashu/1";
const ARKADE = "payments-arkade/1";

type Platform = "desktop" | "browser";
type Tag = "fallbackOff" | "arkadeOff" | "paymentsOff";
type Peer = {
  platform: Platform;
  transports: Transport[];
  caps: string[];
  tag?: Tag;
};
type ScenarioId = "match" | "browser" | "none" | "partial";
type Scenario = { id: ScenarioId; boo: Peer; casper: Peer };

const SCENARIOS: Scenario[] = [
  {
    id: "match",
    boo: {
      platform: "desktop",
      transports: transportOrder(DESKTOP, "iroh/1", true),
      caps: [CHAT, FILES, CASHU, ARKADE],
    },
    casper: {
      platform: "desktop",
      transports: transportOrder(DESKTOP, "hyperdht/1", true),
      caps: [CHAT, FILES, CASHU, ARKADE],
    },
  },
  {
    id: "browser",
    boo: {
      platform: "desktop",
      transports: transportOrder(DESKTOP, "iroh/1", true),
      caps: [CHAT, FILES, CASHU, ARKADE],
    },
    casper: {
      platform: "browser",
      transports: transportOrder(BROWSER, "webrtc/1", true),
      caps: [CHAT, FILES, CASHU],
      tag: "arkadeOff",
    },
  },
  {
    id: "none",
    boo: {
      platform: "desktop",
      transports: transportOrder(DESKTOP, "iroh/1", false),
      caps: [CHAT, FILES],
      tag: "fallbackOff",
    },
    casper: {
      platform: "browser",
      transports: transportOrder(BROWSER, "webrtc/1", true),
      caps: [CHAT, FILES],
    },
  },
  {
    id: "partial",
    boo: {
      platform: "browser",
      transports: transportOrder(BROWSER, "webrtc/1", true),
      caps: [CHAT, FILES, CASHU],
    },
    casper: {
      platform: "browser",
      transports: transportOrder(BROWSER, "webrtc/1", true),
      caps: [CHAT, FILES],
      tag: "paymentsOff",
    },
  },
];

function outcome(s: Scenario) {
  const order = rankTransports(s.boo.transports, s.casper.transports);
  const caps = s.boo.caps.filter((c) => s.casper.caps.includes(c));
  const off = [...new Set([...s.boo.caps, ...s.casper.caps])].filter((c) => !caps.includes(c));
  return { order, caps, off, connected: order.length > 0 };
}

// ── Timing (website/MOTION.md, "Loops and demos") ────────────────────────────
// Three named phases per scenario, each with its own short caption: offers go
// out (0 to 2 s), transports are ranked (2 to 4 s), capabilities settle (4 s on) and
// the complete frame holds for at least 1.5 s before a DUR.md cross-fade.
const PHASE_1 = 2000; // transports compared
const PHASE_2 = 4000; // capabilities compared
const SCENE_MS = 7600; // one scenario, fade included
const FADE_MS = Math.round(DUR.md * 1000); // cross-fade between scenarios: half out, half in
const PICK_MS = 12000; // hold after a reader picks a scenario
const TICK = 100;
/** The still frame (server render, no-JS, reduced motion) is the finished
 * desktop ↔ browser case; with motion the loop starts from scenario 1 once in view. */
/** The complete frame of a scenario: everything settled, the fade-out not yet begun. */
const FINISHED = SCENE_MS - FADE_MS / 2 - TICK;
const STILL = { scenario: 1, elapsed: FINISHED };

type Copy = DevCopy["negotiate"];
type ChipState = "idle" | "shared" | "off";

function PeerTile({
  who,
  peer,
  phase,
  connected,
  shared,
  agreed,
  t,
}: {
  who: "boo" | "casper";
  peer: Peer;
  phase: number;
  connected: boolean;
  shared: ReadonlySet<string>;
  agreed: ReadonlySet<string>;
  t: Copy;
}) {
  const mood: GhostMood = phase === 0 ? "calm" : connected ? "happy" : "lonely";
  const transportState = (tr: Transport): ChipState => (phase < 1 ? "idle" : shared.has(tr) ? "shared" : "off");
  const capState = (c: string): ChipState => (phase < 2 || !connected ? "idle" : agreed.has(c) ? "shared" : "off");
  return (
    <div className="ng-peer" data-who={who}>
      <div className="ng-peer-head">
        <Ghost who={who} size={44} float={false} mood={mood} />
        <div>
          <div className="ng-peer-name">{who === "boo" ? t.boo : t.casper}</div>
          <div className="ng-peer-platform">
            <span>{t.platforms[peer.platform]}</span>
            {peer.tag && <span className="ng-tag">{t.tags[peer.tag]}</span>}
          </div>
        </div>
      </div>
      <div className="ng-field">
        <span className="ng-label">{t.transports}</span>
        <ol className="ng-order">
          {peer.transports.map((tr, i) => (
            <li key={tr} data-state={transportState(tr)} style={{ "--i": i } as CSSProperties}>
              <span className="mono">{tr}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="ng-field">
        <span className="ng-label">{t.capabilities}</span>
        <div className="ng-chips">
          {peer.caps.map((c, i) => (
            <span key={c} className="ng-chip" data-state={capState(c)} style={{ "--i": i } as CSSProperties}>
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultCard({ s, phase, t }: { s: Scenario; phase: number; t: Copy }) {
  const out = outcome(s);
  const verdict = phase < 1 ? "wait" : out.connected ? "ok" : "no";
  return (
    <div className="ng-result" data-verdict={verdict}>
      <span className="ng-beam" data-side="boo" aria-hidden="true" />
      <span className="ng-beam" data-side="casper" aria-hidden="true" />
      <span className="ng-label">{t.result}</span>
      <p className="ng-verdict" data-kind={verdict}>
        {verdict === "wait" ? t.comparing : verdict === "ok" ? t.agreed : t.fail}
      </p>
      {verdict === "no" && <p className="ng-fail">{t.failBody}</p>}
      {verdict === "ok" && (
        <>
          <span className="ng-label">{t.order}</span>
          <ol className="ng-rows">
            {out.order.map((tr, i) => {
              const a = s.boo.transports.indexOf(tr) + 1;
              const b = s.casper.transports.indexOf(tr) + 1;
              return (
                <li key={tr} data-first={i === 0} style={{ "--i": i } as CSSProperties}>
                  <span className="mono">{tr}</span>
                  <span className="ng-sum" title={t.sum} aria-label={`${a} + ${b} = ${a + b}`}>
                    <b data-who="boo">{a}</b>+<b data-who="casper">{b}</b>=<b data-total="">{a + b}</b>
                  </span>
                </li>
              );
            })}
          </ol>
          {phase >= 2 && (
            <>
              <span className="ng-label">{t.capabilities}</span>
              <div className="ng-chips">
                {out.caps.map((c, i) => (
                  <span key={c} className="ng-chip" data-state="shared" style={{ "--i": i } as CSSProperties}>
                    {c}
                  </span>
                ))}
              </div>
              {out.off.length > 0 && (
                <>
                  <span className="ng-label">{t.off}</span>
                  <div className="ng-chips">
                    {out.off.map((c, i) => (
                      <span key={c} className="ng-chip" data-state="off" style={{ "--i": i } as CSSProperties}>
                        {c}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** What a screen reader hears once a scenario settles: the verdict and the plan. */
function summary(s: Scenario, t: Copy): string {
  const out = outcome(s);
  if (!out.connected) return `${t.scenarioNames[s.id]}: ${t.fail}. ${t.failBody}`;
  const parts = [
    `${t.scenarioNames[s.id]}: ${t.agreed}.`,
    `${t.order}: ${out.order.join(", ")}.`,
    `${t.capabilities}: ${out.caps.join(", ")}.`,
  ];
  if (out.off.length) parts.push(`${t.off}: ${out.off.join(", ")}.`);
  return parts.join(" ");
}

export function Negotiation({ t }: { t: Copy }) {
  const calm = useCalm();
  const [play, setPlay] = useState(STILL);
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [picked, setPicked] = useState(0); // pick counter: > 0 once a reader chose
  const [pickHold, setPickHold] = useState(false);
  const [inView, setInView] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const seen = useRef(false);

  // Runs only while at least half of the stage is on screen (or, on a short
  // phone screen, while it fills at least half of the viewport). The first time
  // it shows, the loop starts from scenario 1.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        const vh = e.rootBounds?.height ?? window.innerHeight;
        const visible = e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= vh * 0.5);
        setInView(visible);
        if (visible && !seen.current) {
          seen.current = true;
          if (!window.matchMedia(CALM_QUERY).matches) setPlay((p) => (p === STILL ? { scenario: 0, elapsed: 0 } : p));
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Reduced motion: whatever is showing becomes a finished still.
  useEffect(() => {
    if (calm) setPlay((p) => (p.elapsed >= PHASE_2 + 1000 ? p : { scenario: p.scenario, elapsed: FINISHED }));
  }, [calm]);

  // A pick plays that scenario through and holds it for twelve seconds.
  useEffect(() => {
    if (!picked) return;
    setPickHold(true);
    const id = window.setTimeout(() => setPickHold(false), PICK_MS);
    return () => window.clearTimeout(id);
  }, [picked]);

  // Hover and keyboard focus pause the loop, except right after a pick (the
  // pointer is on the button that was just clicked; the chosen case still plays).
  const paused = !pickHold && (hover || focusWithin);
  useEffect(() => {
    if (calm || !inView || paused) return;
    const id = window.setInterval(() => {
      setPlay((p) => {
        const elapsed = p.elapsed + TICK;
        const end = SCENE_MS - FADE_MS / 2;
        if (elapsed < end) return { scenario: p.scenario, elapsed };
        if (pickHold) return p.elapsed >= end - TICK ? p : { scenario: p.scenario, elapsed: end - TICK };
        if (elapsed < SCENE_MS) return { scenario: p.scenario, elapsed };
        return { scenario: (p.scenario + 1) % SCENARIOS.length, elapsed: 0 };
      });
    }, TICK);
    return () => window.clearInterval(id);
  }, [calm, inView, paused, pickHold]);

  const pick = (i: number) => {
    seen.current = true;
    setPicked((n) => n + 1);
    setPlay({ scenario: i, elapsed: calm ? FINISHED : 0 });
  };

  const s = SCENARIOS[play.scenario];
  const phase = play.elapsed < PHASE_1 ? 0 : play.elapsed < PHASE_2 ? 1 : 2;
  const out = outcome(s);
  const shared = new Set<string>(out.order);
  const agreed = new Set(out.caps);
  const progress = Math.min(1, play.elapsed / SCENE_MS);
  const leaving = !calm && play.elapsed >= SCENE_MS - FADE_MS / 2;
  const step =
    phase === 0
      ? t.phases.offers
      : out.connected
        ? phase === 1
          ? t.phases.ranked
          : t.phases.agreed
        : phase === 1
          ? t.phases.nothing
          : t.phases.none;
  // Announced once a picked scenario settles; while the loop plays on its own
  // the region stays quiet, so a screen reader is not interrupted every few seconds.
  const announce = phase >= 2 ? summary(s, t) : "";

  return (
    <div className="ng" style={{ "--ng-fade": `${FADE_MS / 2}ms` } as CSSProperties}>
      <div
        className="ng-tabs"
        role="group"
        aria-label={t.scenarios}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        // Keyboard focus pauses; the focus a mouse click leaves on a button does not.
        onFocus={(e) => setFocusWithin(e.target.matches(":focus-visible"))}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
        }}
      >
        <span className="ng-tabs-label" aria-hidden="true">
          {t.scenarios}
        </span>
        {SCENARIOS.map((sc, i) => (
          <button
            key={sc.id}
            type="button"
            className="ng-tab"
            aria-pressed={i === play.scenario}
            onClick={() => pick(i)}
            style={i === play.scenario ? ({ "--p": progress } as CSSProperties) : undefined}
          >
            <span className="ng-tab-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ng-tab-name">{t.scenarioNames[sc.id]}</span>
            <span className="ng-tab-bar" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="ng-tabs-current" aria-hidden="true">
        {t.scenarioNames[s.id]}
      </p>

      {/* The frame stays mounted (the observer watches it); the scene inside remounts per scenario. */}
      <div ref={stageRef} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        <div className="ng-scene" key={s.id} data-leaving={leaving || undefined}>
          <p className="ng-step" aria-hidden="true">
            <span className="ng-step-dots">
              {[0, 1, 2].map((i) => (
                <i key={i} data-on={i <= phase || undefined} />
              ))}
            </span>
            <span key={step} className="ng-step-text" data-kind={phase === 0 ? "wait" : out.connected ? "ok" : "no"}>
              {step}
            </span>
          </p>
          <div className="ng-stage" data-verdict={phase < 1 ? "wait" : out.connected ? "ok" : "no"}>
            <PeerTile who="boo" peer={s.boo} phase={phase} connected={out.connected} shared={shared} agreed={agreed} t={t} />
            <ResultCard s={s} phase={phase} t={t} />
            <PeerTile who="casper" peer={s.casper} phase={phase} connected={out.connected} shared={shared} agreed={agreed} t={t} />
          </div>
          <p className="ng-caption">{t.captions[s.id]}</p>
        </div>
      </div>
      <p className="sr-only" aria-live={picked ? "polite" : "off"} aria-atomic="true">
        {announce}
      </p>

      <div className="ng-truth">
        <p>{t.first}</p>
        <div className="ng-truth-meta">
          <span>
            <a href={`${REPO_URL}/blob/dev/packages/core/src/pairedTransports.ts`}>{t.rule} ↗</a> · {t.simplified}
          </span>
          <span className="ng-status">{t.status}</span>
        </div>
      </div>
    </div>
  );
}
