import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { CELEBRATE_MS, useNow, type PairingProgressState } from "../../hooks/usePairingProgress";
import { PAIRING_STEPS, SLOW_AFTER_MS, failureReason, formatElapsed, type PairingStage } from "../../lib/pairingProgress";
import { usePairingWords } from "./words";
import "./pairing-scene.css";

/** The ghost of the app's icon (the website's GhostPet), in an 80×100 box. */
export const GHOST_PATH = "M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z";

type Mood = "calm" | "glance" | "happy" | "sad";

function Eyes({ mood }: { mood: Mood }) {
  if (mood === "happy") return <g className="ps-eyes" fill="none" strokeWidth="4" strokeLinecap="round"><path d="M22 38 Q29 30 36 38" /><path d="M44 38 Q51 30 58 38" /></g>;
  if (mood === "sad") return <g className="ps-eyes" fill="none" strokeWidth="3.5" strokeLinecap="round"><path d="M22 34 L35 38" /><path d="M45 38 L58 34" /><path d="M32 52 Q40 46 48 52" /></g>;
  const dx = mood === "glance" ? 3 : 0;
  return <g className="ps-eyes ps-blink"><circle cx={29 + dx} cy="36" r="6" /><circle cx={51 + dx} cy="36" r="6" /><circle className="ps-shine" cx={31 + dx} cy="34" r="2" /><circle className="ps-shine" cx={53 + dx} cy="34" r="2" /></g>;
}

/** One ghost, centred on (x, y). The outer group places it; the inner one floats, so CSS never fights the attribute. */
function Ghost({ x, y, mood, className }: { x: number; y: number; mood: Mood; className: string }) {
  return <g className={className} transform={`translate(${x - 22} ${y - 24}) scale(0.55)`}>
    <ellipse className="ps-shadow" cx="40" cy="92" rx="22" ry="4" />
    <g className="ps-float">
      <circle className="ps-halo" cx="40" cy="40" r="44" />
      <path className="ps-body" d={GHOST_PATH} />
      <path className="ps-outline" d={GHOST_PATH} />
      <Eyes mood={mood} />
    </g>
  </g>;
}

// The network between the two ghosts: nodes, the mesh, and the two routes packets travel.
const NODES = { n1: [104, 38], n3: [160, 52], n4: [216, 36], n2: [106, 122], n6: [160, 110], n5: [214, 124] } as const;
const DOTS = [[136, 20], [186, 16], [138, 140], [188, 142], [80, 30], [242, 128]] as const;
const MESH = "M104 38 L136 20 L160 52 L186 16 L216 36 M106 122 L138 140 L160 110 L188 142 L214 124 M104 38 L106 122 M216 36 L214 124 M80 30 L104 38 M242 128 L214 124";
const ROUTE_UP = "M66 76 L104 38 L160 52 L216 36 L254 76";
const ROUTE_LOW = "M66 84 L106 122 L160 110 L214 124 L254 84";
const ROUTE_UP_IN = "M254 76 L216 36 L160 52 L104 38 L66 76";

function moods(stage: PairingStage): [Mood, Mood] {
  if (stage === "live") return ["happy", "happy"];
  if (stage === "failed") return ["sad", "calm"];
  if (stage === "waiting" || stage === "knocking") return ["glance", "calm"];
  return ["calm", "calm"];
}

/**
 * The first connection of a paired chat, told as a small scene: the invite goes out onto the network, a ghost
 * waits for the other to pick it up, the knock and the answer travel, and the two link up. Every stage also has
 * words, an elapsed time and a step list, so nothing is said by motion alone; with reduced motion the scene is
 * a still picture of the stage. The animation is CSS on a few SVG shapes and pauses while off screen.
 */
export function PairingScene({ progress, contact, retry, retrying, retryError, id }: {
  progress: PairingProgressState;
  contact?: string;
  retry(): void;
  retrying: boolean;
  retryError: string;
  id?: string;
}) {
  const { t } = useI18n();
  const words = usePairingWords();
  const { stage, role } = progress;
  const root = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setPaused(!entries[0]?.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The "connected" moment ends with the scene fading out, just before the chat takes its place.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (stage !== "live") { setLeaving(false); return; }
    const timer = window.setTimeout(() => setLeaving(true), CELEBRATE_MS - 320);
    return () => window.clearTimeout(timer);
  }, [stage]);
  const ticking = stage !== "live" && stage !== "failed";
  const now = useNow(ticking && !paused);
  // `now` only ticks; a stage that began after its last tick still reads from the clock.
  const inStage = Math.max(0, Math.max(now, Date.now()) - progress.since);
  const slow = ticking && inStage >= SLOW_AFTER_MS[stage];
  const label = words.stage(stage, role);
  const steps = PAIRING_STEPS[role];
  const current = stage === "failed" ? -1 : steps.indexOf(stage);
  const reason = stage === "failed" ? failureReason(progress.reason) : undefined;
  const titleId = useId();
  // A marker is referenced through url(#…), where the colons of a React id would not survive.
  const arrow = `ps-arrow-${titleId.replace(/[^\w-]/g, "")}`;
  const [me, peer] = moods(stage);
  // The failure has its own alert; this region tells the stage and, once, that it is taking long.
  const announcement = [label, slow ? words.slow(stage) : ""].filter(Boolean).join(" ");

  return <section ref={root} id={id} className="ps" data-testid="pairing-scene" data-stage={stage} data-role={role} data-paused={paused || undefined} data-leaving={leaving || undefined} aria-labelledby={titleId}>
    <svg className="ps-svg" viewBox="0 0 320 150" aria-hidden="true" focusable="false">
      <defs>
        <marker id={arrow} className="ps-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" /></marker>
      </defs>
      <g className="ps-net">
        <path className="ps-mesh" d={MESH} />
        <path className="ps-edge" d={ROUTE_UP} />
        <path className="ps-edge" d={ROUTE_LOW} />
        {DOTS.map(([x, y]) => <circle key={`${x}-${y}`} className="ps-dot" cx={x} cy={y} r="2" />)}
        {Object.entries(NODES).map(([name, [x, y]]) => <circle key={name} className={`ps-node ps-${name}`} cx={x} cy={y} r="4.5" />)}
      </g>
      {/* The way this stage's packets go, drawn with arrowheads: all a still picture needs. */}
      <path className="ps-route ps-route-up" d={ROUTE_UP} markerEnd={`url(#${arrow})`} />
      <path className="ps-route ps-route-low" d={ROUTE_LOW} markerEnd={`url(#${arrow})`} />
      <path className="ps-route ps-route-in" d={ROUTE_UP_IN} markerEnd={`url(#${arrow})`} />
      <path className="ps-route ps-route-pub" d="M66 76 L104 38 L160 52 M66 84 L106 122 L160 110" markerEnd={`url(#${arrow})`} />
      {/* The invite, resting where the network keeps it. */}
      <g className="ps-invite" transform="translate(160 52)">
        <circle className="ps-ping" r="7" />
        <rect x="-7" y="-5" width="14" height="10" rx="2" />
        <path d="M-6 -4 L0 1 L6 -4" />
      </g>
      <g className="ps-direct">
        <path className="ps-direct-glow" d="M66 80 L254 80" />
        <path className="ps-direct-line" d="M66 80 L254 80" />
        <path className="ps-direct-broken" d="M66 80 L148 80 M172 80 L254 80" />
        <path className="ps-cross" d="M154 74 L166 86 M166 74 L154 86" />
      </g>
      <g className="ps-packets">
        <circle className="ps-pk ps-pk-pub-a" r="3" />
        <circle className="ps-pk ps-pk-pub-b" r="3" />
        <circle className="ps-pk ps-pk-pub-c" r="2.5" />
        <circle className="ps-pk ps-pk-pub-d" r="2.5" />
        <circle className="ps-pk ps-pk-up" r="3" />
        <circle className="ps-pk ps-pk-low" r="3" />
        <circle className="ps-pk ps-pk-direct-out" r="3" />
        <circle className="ps-pk ps-pk-direct-in" r="3" />
      </g>
      <g className="ps-knock" transform="translate(274 80)"><circle r="20" /><circle r="20" /></g>
      <g className="ps-burst"><circle cx="46" cy="80" r="24" /><circle cx="274" cy="80" r="24" /><circle cx="160" cy="80" r="10" /></g>
      <Ghost x={46} y={80} mood={me} className="ps-ghost ps-me" />
      <Ghost x={274} y={80} mood={peer} className="ps-ghost ps-peer" />
    </svg>
    <div className="ps-names" aria-hidden="true"><span>{t("pairing.you")}</span><span className="ps-contact">{contact || t("pairing.contact")}</span></div>
    <div className="ps-caption">
      <p id={titleId} className="ps-label" data-testid="pairing-stage-label">{label}</p>
      {ticking && <p className="ps-time" data-testid="pairing-elapsed"><time dateTime={`PT${Math.floor(inStage / 1000)}S`} aria-label={t("pairing.elapsed", { time: formatElapsed(inStage) })}>{formatElapsed(inStage)}</time>{progress.attempt > 1 && <span> · {t("pairing.attempt", { n: progress.attempt })}</span>}</p>}
      {slow && <p className="ps-slow" data-testid="pairing-slow">{words.slow(stage)}</p>}
      {stage === "live" && <p className="ps-slow">{t("pairing.sayHello")}</p>}
      {reason && <div role="alert" className="ps-failure" data-testid="pairing-failure">
        <p>{words.reason(reason)}</p>
        {progress.detail && <p className="ps-detail">{progress.detail}</p>}
        {progress.retryable ? <button type="button" className="ps-retry" data-testid="pairing-retry" disabled={retrying || !progress.linkId} onClick={retry}>{retrying ? t("pairing.retrying") : t("pairing.retry")}</button>
          : <p className="ps-detail">{t("pairing.newInvite")}</p>}
        {retryError && <p className="ps-detail">{retryError}</p>}
      </div>}
    </div>
    <ol className="ps-steps" aria-label={t("pairing.steps")} data-testid="pairing-steps">
      {steps.map((step, index) => {
        const state = current < 0 ? "todo" : index < current || stage === "live" ? "done" : index === current ? "current" : "todo";
        return <li key={step} data-step={step} data-state={state} aria-current={state === "current" ? "step" : undefined}>
          <span className="ps-step-dot" aria-hidden="true" />
          <span className="ps-step-label">{words.step(step)}</span>
          {state === "done" && <span className="sr-only"> ({t("pairing.done")})</span>}
        </li>;
      })}
    </ol>
    <p className="sr-only" aria-live="polite" data-testid="pairing-announcement">{announcement}</p>
  </section>;
}
