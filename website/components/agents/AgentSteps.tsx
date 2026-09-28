"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useInView } from "motion/react";
import { Ghost, GhostMark } from "@/components/ghost/Ghost";
import { useCalm } from "@/lib/useCalm";
import "@/app/dev-steps.css";

export type AgentStep = { id: string; label: string; title: string; body: string };
export type AgentStepsCopy = {
  label: string;
  of: string;
  replay: string;
  agent: string;
  you: string;
  shell: string;
  app: string;
  chats: string;
  online: string;
  thinking: string;
  connected: string;
  hi: string;
  ask: string;
  answer: string;
  data: string;
  keys: string;
  steps: AgentStep[];
};

/** How long each step's picture plays, in ms, before its caption's reading time starts. */
const PLAY = [1200, 1800, 3000, 2600, 1800, 1600];
const LAST = PLAY.length - 1;
const MSG_ID = "peer_jY7N…";

/** How long a caption stays once its step has played: time to read it (about four words a second), at least 3 s. */
function holdFor(s: AgentStep): number {
  const words = `${s.title} ${s.body}`.split(/\s+/).length;
  return Math.max(3000, words * 240);
}

/**
 * How an agent joins, as a picture you can glance at: your agent's shell on one side, your Ghostly app on the
 * other, Casper and Boo above them. It plays the six steps by itself while it is on screen, each caption held long
 * enough to read, and stops on the last (the phone home's chapters, story/SceneFrame.tsx). A tap on a step's dot
 * shows that step and stops the turns; Replay starts over. The dots, the stage and the captions are the Developers
 * explainer's (dev-steps.css, psx-).
 *
 * Every piece of the picture is always in the page, tagged with the step it arrives at (`data-on`, `data-final`),
 * so CSS alone draws the finished frame without scripts or with reduced motion, where every caption reads in order.
 * The piece arriving now (`data-now`) plays its entrance once, after its delay (`--agx-d`), when the section is in view.
 */
export function AgentSteps({ t }: { t: AgentStepsCopy }) {
  const root = useRef<HTMLElement>(null);
  const calm = useCalm();
  const inView = useInView(root, { amount: 0.35 });
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(true);
  const [take, setTake] = useState(0);
  const [live, setLive] = useState(false);
  const n = t.steps.length;

  useEffect(() => {
    if (inView) setLive(true);
  }, [inView]);

  // The next step comes by itself once this one has played and its caption is read.
  const running = !calm && inView && auto && step < LAST;
  const wait = PLAY[step] + holdFor(t.steps[step]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setStep((s) => Math.min(LAST, s + 1)), wait);
    return () => window.clearTimeout(timer);
  }, [running, wait, step, take]);

  const pick = (i: number) => {
    setAuto(false);
    setStep(i);
    setTake((k) => k + 1);
  };
  const replay = () => {
    setAuto(true);
    setStep(0);
    setTake((k) => k + 1);
  };

  const shown = calm ? LAST : step;
  /** A piece of the picture: shown from step `at` to step `to`, arriving `d` seconds into its step. */
  const b = (at: number, d = 0, to = LAST) => ({
    "data-on": String(at <= shown && shown <= to),
    "data-final": String(at <= LAST && to === LAST),
    "data-now": at === shown ? "" : undefined,
    style: d ? ({ "--agx-d": `${d}s` } as CSSProperties) : undefined,
  });
  const of = (i: number) => t.of.replace("{n}", String(i + 1)).replace("{total}", String(n));
  const count = (i: number) => String(i).padStart(2, "0");

  return (
    <section
      ref={root}
      className="psx agx"
      aria-label={t.label}
      data-step={shown}
      data-live={live || undefined}
      data-auto={running || undefined}
      data-testid="agent-steps"
    >
      <div className="psx-grid">
        <ol className="psx-steps" aria-label={t.label}>
          {t.steps.map((s, i) => (
            <li
              key={s.id}
              data-state={i < shown ? "done" : i === shown ? "current" : "todo"}
              data-fill={running && i === shown + 1 ? "" : undefined}
              style={{ "--fill": `${wait}ms` } as CSSProperties}
            >
              <button type="button" className="psx-dot" aria-current={i === shown ? "step" : undefined} aria-label={`${of(i)}: ${s.title}`} onClick={() => pick(i)}>
                <span className="psx-dot-mark" aria-hidden="true" />
                <span className="psx-dot-label" aria-hidden="true">
                  {s.label}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <figure className="psx-stage agx-stage" aria-hidden="true">
          <div className="agx-scene" key={take}>
            <div className="agx-cast">
              <div className="agx-who agx-who--agent">
                <span className="agx-seat">
                  <span className="agx-shell-mark mono" {...b(0, 0, 0)}>
                    &gt;_
                  </span>
                  <span className="agx-pop" {...b(1, 0.9)}>
                    <Ghost who="casper" size={46} mood={shown === 3 ? "curious" : "happy"} phase={1} />
                  </span>
                </span>
                <span className="agx-name">
                  <span {...b(0, 0, 0)}>{t.agent}</span>
                  <span className="agx-rise" {...b(1, 1.1)}>
                    Casper
                  </span>
                </span>
              </div>
              <div className="agx-wire">
                <span className="agx-wire-lit" {...b(2, 1.6)} />
              </div>
              <div className="agx-who agx-who--you">
                <span className="agx-name">{t.you}</span>
                <span className="agx-seat">
                  <Ghost who="boo" size={46} mood="happy" />
                </span>
              </div>
            </div>

            <div className="agx-panels">
              <div className="agx-term">
                <div className="agx-bar">
                  <span className="agx-lights" />
                  <span className="mono">{t.shell}</span>
                </div>
                <div className="agx-lines mono">
                  <p className="agx-paste agx-rise" {...b(0, 0.3)}>
                    <span className="agx-caret">›</span> Put yourself on Ghostly… Your name on Ghostly: <b>Casper</b>
                  </p>
                  <Cmd {...b(1, 0.1)}>ghostly profile set --name &quot;Casper&quot;</Cmd>
                  <Cmd {...b(1, 0.6)}>ghostly daemon --detach</Cmd>
                  <Cmd {...b(2, 0)}>ghostly invite create --label owner</Cmd>
                  <p className="agx-out agx-rise" {...b(2, 0.5)}>
                    &quot;link&quot;: &quot;https://ghostly.tools/#ghostly1…&quot;
                  </p>
                  <Cmd {...b(2, 2.2)}>ghostly send owner &quot;Hi!&quot;</Cmd>
                  <Cmd {...b(3, 0)}>ghostly listen --turns --from owner</Cmd>
                  <p className="agx-json agx-rise" {...b(3, 1.3)}>
                    {`{"type":"agent.turn",`}
                    <br />
                    {` "messageId":"${MSG_ID}",`}
                    <br />
                    {" "}
                    <span className="agx-untrusted">
                      &quot;untrusted&quot;:{`{"text":"${t.ask}"}`}
                    </span>
                    {"}"}
                  </p>
                  <Cmd {...b(4, 0)}>ghostly send owner --reply {MSG_ID} --stdin</Cmd>
                  <p className="agx-guard agx-rise" {...b(5, 0.5)}>
                    # {t.data}
                  </p>
                  <p className="agx-guard agx-rise" {...b(5, 0.9)}>
                    # {t.keys}
                  </p>
                </div>
                <span className="agx-shield agx-pop" {...b(5, 0.1)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2.5 4.5 5.5v6c0 4.6 3.1 8.4 7.5 10 4.4-1.6 7.5-5.4 7.5-10v-6z" />
                    <path className="agx-shield-lock" d="M9 11.5h6v4.5H9zM10.2 11.5V10a1.8 1.8 0 0 1 3.6 0v1.5" />
                  </svg>
                </span>
              </div>

              <div className="agx-app">
                <div className="agx-bar agx-bar--app">
                  <span className="agx-head" {...b(0, 0, 1)}>
                    {t.app}
                  </span>
                  <span className="agx-head agx-rise" {...b(2, 1.4)}>
                    <GhostMark className="agx-avatar" />
                    <span>
                      Casper <small>{t.online}</small>
                    </span>
                  </span>
                </div>
                <div className="agx-chat">
                  <p className="agx-empty" {...b(0, 0, 1)}>
                    {t.chats}
                  </p>
                  <p className="agx-sys agx-rise" {...b(2, 1.6)}>
                    {t.connected}
                  </p>
                  <p className="agx-msg agx-msg--in agx-rise" {...b(2, 2.6)}>
                    {t.hi}
                  </p>
                  <p className="agx-msg agx-msg--out agx-rise" {...b(3, 0)}>
                    {t.ask}
                  </p>
                  <p className="agx-msg agx-msg--in agx-typing agx-rise" {...b(3, 1.8, 3)}>
                    <span className="agx-dots">
                      <i />
                      <i />
                      <i />
                    </span>{" "}
                    {t.thinking}
                  </p>
                  <div className="agx-msg agx-msg--in agx-rise" {...b(4, 1.1)}>
                    <span className="agx-quote">{t.ask}</span>
                    {t.answer}
                  </div>
                </div>
              </div>

              <span className="agx-fly agx-fly--link" {...b(2, 0.6, 2)}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1" />
                </svg>
                <span className="mono">ghostly1…</span>
              </span>
              <span className="agx-fly agx-fly--msg" {...b(3, 0.3, 3)} />
              <span className="agx-fly agx-fly--reply" {...b(4, 0.3, 4)} />
            </div>
          </div>
        </figure>

        <div className="psx-controls agx-controls">
          <button type="button" className="psx-btn psx-replay" onClick={replay} data-testid="agent-steps-replay">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10a6 6 0 1 0 2-4.5M4 3v3.5h3.5" />
            </svg>
            <span>{t.replay}</span>
          </button>
        </div>

        <div className="psx-copy agx-copy">
          {t.steps.map((s, i) => (
            <article
              key={s.id}
              className="psx-card"
              data-step-id={s.id}
              data-state={i === shown ? "current" : i < shown ? "before" : "after"}
              data-active={i === shown}
              aria-hidden={calm || i === shown ? undefined : true}
            >
              <p className="psx-count mono">
                {count(i + 1)} / {count(n)} · {s.label}
              </p>
              <h3 className="psx-title">{s.title}</h3>
              <p className="psx-body">{s.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/** A command the agent runs, typed out. */
function Cmd({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) {
  return (
    <p className="agx-cmd" {...rest}>
      <span className="agx-ps">$</span> <span className="agx-typed">{children}</span>
    </p>
  );
}
