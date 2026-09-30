"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { DevCopy } from "@/content/developers";
import { STEPS, LAND, PORT } from "./protocolTimeline";
import { StepClock } from "./stepClock";
import { StepScene } from "./StepScene";
import "@/app/dev-steps.css";

/**
 * How a chat starts, step by step: the protocol in eight steps, in the app's
 * pairing-scene language (two ghosts, the DHT mesh, packets on their routes),
 * with what each step puts on the wire beside it.
 *
 * The reader drives it: Next and Previous (buttons, the step dots, ← and →,
 * Home and End), Replay step, and an optional Play all that stops at the end.
 * Arriving at a step plays its animation; going back plays the step being left
 * in reverse; a jump of more than one step cross-fades and plays the target
 * from its start. Nothing advances by itself unless Play all is on.
 *
 * The picture is driven by one number, `--t` (protocolTimeline.ts), which the
 * clock (stepClock.ts) writes on the root while a step plays and never
 * otherwise, so React renders nothing per frame. The CSS default is the start
 * of the first step when scripts run (it plays once the explainer is in view),
 * and its finished frame without scripts or with reduced motion, where every
 * change of step is instant.
 */
export type StepsCopy = DevCopy["hero"]["steps"];
export type WispLink = { number: string; href: string; name: string };

export function ProtocolSteps({ t, wisps }: { t: StepsCopy; wisps: Record<string, WispLink> }) {
  const root = useRef<HTMLElement>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [cut, setCut] = useState(false);
  // Announce steps only once the reader has moved: nothing is read out on load.
  const [moved, setMoved] = useState(false);
  const [clock] = useState(
    () =>
      new StepClock({
        step: (i) => {
          setStep(i);
          setMoved(true);
        },
        playing: setPlaying,
        cut: setCut,
      }),
  );

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    clock.attach(el, reduce.matches);
    const onReduce = () => clock.setCalm(reduce.matches);
    reduce.addEventListener("change", onReduce);
    let visible = false;
    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting && e.intersectionRatio >= 0.35;
        if (visible) clock.intro();
      },
      { threshold: [0, 0.35] },
    );
    io.observe(el);
    // ← → Home End also work while nothing on the page has focus and the explainer is in view.
    const onDocKey = (e: KeyboardEvent) => {
      if (!visible || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      if (e.key === "ArrowRight") clock.next();
      else if (e.key === "ArrowLeft") clock.prev();
      else if (e.key === "Home") clock.jump(0);
      else if (e.key === "End") clock.jump(STEPS - 1);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onDocKey);
    return () => {
      reduce.removeEventListener("change", onReduce);
      io.disconnect();
      document.removeEventListener("keydown", onDocKey);
      clock.detach();
    };
  }, [clock]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === "ArrowRight") clock.next();
    else if (e.key === "ArrowLeft") clock.prev();
    else if (e.key === "Home") clock.jump(0);
    else if (e.key === "End") clock.jump(STEPS - 1);
    else return;
    e.preventDefault();
  };

  const last = step === STEPS - 1;
  const count = (n: number) => String(n).padStart(2, "0");
  const of = (i: number) => t.of.replace("{n}", String(i + 1)).replace("{total}", String(STEPS));
  const playLabel = playing ? t.pause : last ? t.restart : t.playAll;

  return (
    <section ref={root} className="psx" aria-labelledby="psx-title" onKeyDown={onKey} data-step={step} data-playing={playing || undefined}>
      <h2 id="psx-title" className="sr-only">
        {t.label}
      </h2>
      <div className="psx-grid">
        <ol className="psx-steps" aria-label={t.stepsLabel}>
          {t.list.map((s, i) => (
            <li key={s.id} data-state={i < step ? "done" : i === step ? "current" : "todo"}>
              <button type="button" className="psx-dot" aria-current={i === step ? "step" : undefined} aria-label={`${of(i)}: ${s.short}`} onClick={() => clock.jump(i)}>
                <span className="psx-dot-mark" aria-hidden="true" />
                <span className="psx-dot-label" aria-hidden="true">
                  {s.short}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <figure className="psx-stage" data-cut={cut || undefined}>
          <StepScene g={LAND} t={t.stage} className="psx-svg--land" />
          <StepScene g={PORT} t={t.stage} className="psx-svg--port" />
        </figure>

        <div className="psx-controls">
          <button type="button" className="psx-btn" onClick={() => clock.prev()} aria-disabled={step === 0 || undefined} aria-label={t.prev} data-action="prev">
            <span aria-hidden="true">←</span>
            <span className="psx-btn-text">{t.prev}</span>
          </button>
          <button type="button" className="psx-btn psx-replay" onClick={() => clock.replay()} aria-label={t.replay} data-action="replay">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10a6 6 0 1 0 2-4.5M4 3v3.5h3.5" />
            </svg>
            <span className="psx-btn-text">{t.replay}</span>
          </button>
          <button type="button" className="psx-btn" onClick={() => clock.toggleAll()} aria-pressed={playing} aria-label={playLabel} data-action="all">
            {playing ? (
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M7 4v12M13 4v12" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M6 4l10 6-10 6z" className="psx-fill" />
              </svg>
            )}
            <span className="psx-btn-text">{playLabel}</span>
          </button>
          <button type="button" className="psx-btn psx-btn--next" onClick={() => clock.next()} aria-disabled={last || undefined} aria-label={t.next} data-action="next">
            <span className="psx-btn-text">{t.next}</span>
            <span aria-hidden="true">→</span>
          </button>
          <span className="psx-keys mono" aria-hidden="true">
            {t.keys}
          </span>
        </div>

        <div className="psx-copy">
          {t.list.map((s, i) => (
            <article key={s.id} className="psx-card" data-step-id={s.id} data-state={i === step ? "current" : i < step ? "before" : "after"} aria-hidden={i === step ? undefined : true} inert={i === step ? undefined : true}>
              <p className="psx-count mono">
                {count(i + 1)} / {count(STEPS)} · {s.short}
              </p>
              <h3 className="psx-title">{s.title}</h3>
              <p className="psx-body">{s.body}</p>
              <dl className="psx-wire" aria-label={t.sent}>
                {s.wire.map((w) => (
                  <div key={w.k} className="psx-wire-row">
                    <dt className="mono">{w.k}</dt>
                    <dd>{w.v}</dd>
                  </div>
                ))}
              </dl>
              <p className="psx-wisps">
                <span>{t.wisps}</span>
                {s.wisps.map((n) => {
                  const w = wisps[n];
                  return w ? (
                    <Link key={n} href={w.href} className="psx-wisp mono" title={w.name}>
                      WISP {w.number}
                    </Link>
                  ) : null;
                })}
              </p>
            </article>
          ))}
        </div>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="psx-announce">
        {moved ? `${of(step)}: ${t.list[step].title}` : ""}
      </p>
    </section>
  );
}
