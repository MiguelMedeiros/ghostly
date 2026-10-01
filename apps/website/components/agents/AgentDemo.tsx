"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";
import { Ghost } from "@/components/ghost/Ghost";
import { useCalm } from "@/lib/useCalm";
import type { agents } from "@/content/agents";

type Copy = typeof agents.demo;
type Status = "queued" | "running" | "done";
type Task = { status: Status; progress: number; done: number; doing?: number; min: number };
/**
 * The question's buttons, as the app shows them to the person who taps: asked; Merge being sent (the app's spinner);
 * pressed (✓ Merge, the other one off, and the tap's reply in the chat); then the bot's answer to the press, its
 * `button update --chosen merge --close` (Closed under the buttons) and a 👍 on the reply.
 */
type Ask = "asked" | "sending" | "pressed" | "closed";
/** One frame of the loop: what shows, which caption, and how long it holds. */
type Frame = { cap: number; ms: number; user?: true; think?: true; reply?: true; task?: Task; ask?: Ask; routine?: true };

const TOTAL = 4;
const DONE: Task = { status: "done", progress: 100, done: 4, min: 14 };
/**
 * The loop (MOTION.md, "Loops and demos"): about 18 s in nine phases, each with its caption. The task's times are the
 * story's (minutes), told in seconds. Once the task is done the bot asks with two buttons, you tap Merge, and the bot
 * closes the question. The last frame is the finished one: it holds 3 s, and it is what shows without scripts or with
 * reduced motion.
 */
const FRAMES: Frame[] = [
  { cap: 0, ms: 1600, user: true },
  { cap: 1, ms: 1800, user: true, think: true },
  { cap: 2, ms: 1500, user: true, reply: true, task: { status: "queued", progress: 0, done: 0, min: 1 } },
  { cap: 3, ms: 1100, user: true, reply: true, task: { status: "running", progress: 25, done: 1, doing: 0, min: 3 } },
  { cap: 3, ms: 1100, user: true, reply: true, task: { status: "running", progress: 75, done: 3, doing: 2, min: 11 } },
  { cap: 4, ms: 1800, user: true, reply: true, task: DONE },
  { cap: 5, ms: 2200, user: true, reply: true, task: DONE, ask: "asked" },
  { cap: 6, ms: 700, user: true, reply: true, task: DONE, ask: "sending" },
  { cap: 6, ms: 1300, user: true, reply: true, task: DONE, ask: "pressed" },
  { cap: 7, ms: 1800, user: true, reply: true, task: DONE, ask: "closed" },
  { cap: 8, ms: 3000, user: true, reply: true, task: DONE, ask: "closed", routine: true },
];
const LAST = FRAMES.length - 1;
/** The cross-fade between the finished frame and the first one (`DUR.slow`). */
const FADE_MS = 560;

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));

/**
 * A Ghostly chat with an agent, as a picture that plays by itself: you ask, Casper thinks with a status line, posts a
 * task card that goes from queued to running to done with its pull request, asks "Merge it?" with two buttons (WISP 4xx ·
 * Message Buttons, drawn as the app's MessageButtons.tsx), you tap Merge, and the bot closes the question; then a
 * routine card. Every piece is
 * always laid out (`data-on` shows it), so nothing in or around the frame moves when one arrives. It plays only while
 * half of it is on screen, pauses on hover, on focus and with Pause, and shows its finished frame with reduced motion.
 */
export function AgentDemo({ t }: { t: Copy }) {
  const root = useRef<HTMLElement>(null);
  const calm = useCalm();
  const inView = useInView(root, { amount: 0.5 });
  const [index, setIndex] = useState(LAST);
  const [fading, setFading] = useState(false);
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(false);
  const [started, setStarted] = useState(false);
  const playing = !calm && inView && !held && !paused;

  useEffect(() => {
    if (!playing) return;
    // The first time it plays, from the finished frame the page drew: fade to the first.
    const wait = !started ? 400 : fading ? FADE_MS : FRAMES[index].ms;
    const timer = setTimeout(() => {
      if (!started) {
        setStarted(true);
        setFading(true);
      } else if (fading) {
        setIndex(0);
        setFading(false);
      } else if (index === LAST) setFading(true);
      else setIndex(index + 1);
    }, wait);
    return () => clearTimeout(timer);
  }, [playing, index, fading, started]);

  const frame = calm ? FRAMES[LAST] : FRAMES[index];
  const task = frame.task ?? FRAMES[2].task!;
  const doing = task.doing !== undefined ? t.doing[task.doing] : t.doing[0];
  const elapsed = fill(task.status === "done" ? t.elapsed.took : t.elapsed[task.status], { d: `${task.min} min` });
  const caption = calm || !started ? t.still : t.captions[frame.cap];
  const ask = frame.ask;
  const answered = ask === "pressed" || ask === "closed";

  return (
    <figure
      ref={root}
      className="agd"
      data-testid="agent-demo"
      data-frame={calm ? LAST : index}
      data-playing={playing ? "" : undefined}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <div className="agd-chat" aria-hidden="true" data-fading={fading ? "" : undefined}>
        <div className="agd-head">
          <span className="agd-avatar">
            <Ghost color="#22d3ee" mood="happy" size={28} float={false} />
          </span>
          <span className="agd-who">
            <b>{t.bot}</b>
            <span className="agd-sub" data-thinking={frame.think ? "" : undefined}>
              {frame.think ? `${t.thinking} · ${t.status}` : t.online}
            </span>
          </span>
        </div>

        <div className="agd-body">
          <div className="agd-row agd-row--out" data-on={!!frame.user}>
            <p className="agd-bubble agd-bubble--out">{t.ask}</p>
          </div>

          <div className="agd-row agd-stack">
            <p className="agd-bubble agd-bubble--in" data-on={!!frame.reply}>
              {t.reply}
            </p>
            <p className="agd-typing" data-on={!!frame.think}>
              <span className="agd-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="agd-typing-status">{t.status}</span>
            </p>
          </div>

          <div className="agd-card" data-on={!!frame.task} data-status={task.status}>
            <div className="agd-card-top">
              <span className="agd-dot" />
              <b className="agd-title">{t.task}</b>
              <span className="agd-status">
                {task.status === "done" && "✓ "}
                {t.statuses[task.status]}
              </span>
            </div>
            <div className="agd-bar">
              <span style={{ transform: `scaleX(${task.progress / 100})` }} />
            </div>
            <div className="agd-meta">
              <span>
                {task.progress}% · {fill(t.steps, { done: task.done, total: TOTAL })}
              </span>
              <span className="agd-pr" data-on={task.status === "done"}>
                <span className="agd-add">+123</span> <span className="agd-del">−45</span> · {t.pr}
              </span>
            </div>
            <div className="agd-foot">
              <span className="agd-now" data-on={task.status !== "done"}>
                <b>{t.now}</b> {doing}
              </span>
              <span className="agd-elapsed">{elapsed}</span>
            </div>
          </div>

          {/* The question and its buttons, as the app draws them under a bot's message: a tap is a reply. */}
          <div className="agd-ask" data-on={!!ask} data-testid="agent-demo-ask">
            <p className="agd-bubble agd-bubble--in">{t.question}</p>
            <div className="agd-buttons" data-answered={answered ? "" : undefined}>
              {t.buttons.map((b, i) => (
                <span
                  key={b.id}
                  className="agd-button"
                  data-style={b.style}
                  data-chosen={answered && i === 0 ? "" : undefined}
                  data-sending={ask === "sending" && i === 0 ? "" : undefined}
                >
                  <span className="agd-spin" />
                  <span className="agd-check">✓</span>
                  {b.label}
                </span>
              ))}
            </div>
            <span className="agd-closed" data-on={ask === "closed"}>
              {t.closed}
            </span>
          </div>

          {/* Your tap, in the chat: a reply whose text is the label, and the bot's 👍 on it. */}
          <div className="agd-row agd-row--out agd-press-row" data-on={answered} data-testid="agent-demo-press">
            <p className="agd-bubble agd-bubble--out">
              <span className="agd-press-mark">↩</span> {t.buttons[0].label}
            </p>
            <span className="agd-react" data-on={ask === "closed"}>
              👍
            </span>
          </div>

          <div className="agd-routine" data-on={!!frame.routine}>
            <span className="agd-routine-mark">↻</span>
            <span className="agd-routine-text">
              <b>{t.routine}</b> · {t.schedule}
              <span className="agd-routine-run">
                <span className="agd-ok">✓ {t.last}</span> · {t.next}
              </span>
            </span>
          </div>
        </div>

        <div className="agd-composer">
          <span>{t.composer}</span>
        </div>
      </div>

      <figcaption className="agd-caption">
        <span className="caption" data-testid="agent-demo-caption">
          {caption}
        </span>
        {!calm && (
          <button type="button" className="agd-toggle" onClick={() => setPaused(!paused)} aria-pressed={paused} data-testid="agent-demo-toggle">
            {paused ? t.play : t.pause}
          </button>
        )}
        <span className="sr-only">{t.label}</span>
      </figcaption>
    </figure>
  );
}
