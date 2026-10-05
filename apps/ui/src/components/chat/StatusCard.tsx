import { useId, useRef, useState, type ReactNode } from "react";
import { cardLinkHost, taskProgress, type TaskCard, type ItemState } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { externalLinkProps } from "../../lib/externalLink";
import { agoIn } from "../../lib/relativeTime";
import { clockTime } from "../../lib/time";
import { STATUS_TONE, durationIn, isFinished, taskElapsed, type ShownCard } from "../../lib/statusCards";
import { RoutineView } from "./RoutineCard";

/*
 * A bot's status card in the chat (WISP 405 · Status Cards), shown instead of the message's text, which is only its
 * fallback. Compact: the title, a thin bar, the status, the pull request's size; a tap, a click or Enter opens it in
 * place with the rest. Display only: nothing here acts, and a link shows its host. Every string is the card's as the
 * reader kept it (one line, cleaned), drawn as plain text, never through the message renderer.
 */


const ITEM_MARK: Record<ItemState, string> = { pending: "○", running: "◐", done: "✓", failed: "✕", skipped: "–" };

/** The bar a task shows: its percent, or its steps done of total, as the bot said them; empty when it said neither. */
export function ProgressBar({ card, className = "" }: { card: TaskCard; className?: string }) {
  const { t } = useI18n();
  const progress = taskProgress(card);
  const shown = progress ?? 0;
  return (
    <div role="progressbar" aria-label={t("cards.task.progress")} aria-valuemin={0} aria-valuemax={100} {...(progress !== undefined && { "aria-valuenow": progress })}
      data-testid="status-card-progress" data-progress={progress ?? ""}
      className={`h-1 w-full overflow-hidden rounded-full bg-text-primary/10 ${className}`}>
      <div className={`h-full rounded-full ${STATUS_TONE[card.status].bar} transition-[width] duration-300 motion-reduce:transition-none`} style={{ width: `${shown}%` }} />
    </div>
  );
}

/** "+123 −45 · PR #612", or what of it the card says. */
export function PrLine({ card }: { card: TaskCard }) {
  const { t } = useI18n();
  if (!card.pr) return null;
  const { additions, deletions, number } = card.pr;
  return (
    <span data-testid="status-card-pr" className="inline-flex items-center gap-1.5 whitespace-nowrap" dir="ltr">
      {additions !== undefined && <span className="text-accent">+{additions}</span>}
      {deletions !== undefined && <span className="text-danger-ink">−{deletions}</span>}
      {(additions !== undefined || deletions !== undefined) && <span aria-hidden="true">·</span>}
      <span>{number !== undefined ? t("cards.task.pr", { number }) : t("cards.task.prNoNumber")}</span>
    </span>
  );
}

/** The "·" between two facts on a line. */
const Sep = () => <span aria-hidden="true" className="text-text-muted">·</span>;

/**
 * A task's card. Its title (cut to one line with "…", whole on hover and opened) and its status, a dot or mark and a
 * word; its bar and percent; its foot: how long it has been at it, its steps and pull request, wrapping as they need,
 * and when it last changed (`time`) with my own card's delivery marks (`marks`) at the end.
 */
function TaskView({ card, time, marks, end }: { card: TaskCard; time?: ReactNode; marks?: ReactNode; end?: number }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const ago = agoIn(language);
  const progress = taskProgress(card);
  const tone = STATUS_TONE[card.status];
  const links = [...(card.pr ? [{ url: card.pr.url, label: card.pr.number !== undefined ? t("cards.task.pr", { number: card.pr.number }) : t("cards.task.prNoNumber") }] : []), ...(card.links ?? [])];
  // The foot's facts, "·" between them: how long (`taskElapsed`: not for a cancelled one), the steps, the pull request.
  const facts = [
    ...(card.startedAt && card.status !== "cancelled" ? [<TaskElapsedLine key="elapsed" card={card} end={end} testId="status-card-elapsed" />] : []),
    ...(card.done !== undefined && card.total !== undefined ? [<span key="steps" className="whitespace-nowrap">{t("cards.task.steps", { done: card.done, total: card.total })}</span>] : []),
    ...(card.pr ? [<PrLine key="pr" card={card} />] : []),
  ].flatMap((fact, i) => (i ? [<Sep key={`sep${i}`} />, fact] : [fact]));
  return (
    <div data-testid="status-card" data-kind="task" data-card-id={card.id} data-status={card.status} data-open={open ? "" : undefined}
      className="w-full min-w-0 text-start">
      {/* A long press or a swipe on it is the message's, as on a bubble (MessageBubble's gestures let this button through). */}
      <button type="button" data-testid="status-card-toggle" data-press-through aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="block w-full cursor-pointer rounded-t-[9px] px-3.5 pt-2.5 pb-1 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
        <span className="flex min-w-0 items-start gap-2">
          <bdi data-testid="status-card-title" title={card.title}
            className={`min-w-0 flex-1 text-[13.5px] font-semibold leading-5 text-text-primary ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>{card.title}</bdi>
          <span data-testid="status-card-status" className={`inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium leading-5 ${tone.label}`}>
            {tone.mark ? <span aria-hidden="true">{tone.mark} </span> : <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />}
            {t(`cards.task.status.${card.status}`)}
          </span>
        </span>
        <span className="mt-2 flex items-center gap-2">
          <ProgressBar card={card} className="flex-1" />
          {progress !== undefined && <span className="shrink-0 text-[11px] leading-4 tabular-nums text-text-secondary">{progress}%</span>}
        </span>
      </button>
      {open && (
        <div id={detailsId} data-testid="status-card-details" className="mx-3.5 mt-1 flex flex-col gap-2 border-t border-text-primary/10 pb-1 pt-2 text-xs leading-snug text-text-primary/85">
          {card.step && !isFinished(card.status) && <p className="m-0"><span className="font-semibold">{t("cards.task.now")}</span> <bdi data-testid="status-card-step">{card.step}</bdi></p>}
          {card.items && (
            <ol className="m-0 list-none space-y-1 p-0" data-testid="status-card-items">
              {card.items.map((item, i) => (
                <li key={i} data-testid="status-card-item" data-state={item.state} className="flex items-start gap-1.5">
                  <span aria-hidden="true" className={`w-3 shrink-0 text-center ${item.state === "done" ? "text-accent" : item.state === "failed" ? "text-danger-ink" : "text-text-primary/50"}`}>{ITEM_MARK[item.state]}</span>
                  <span className="sr-only">{t(`cards.task.item.${item.state}`)}: </span>
                  <bdi className={`min-w-0 [overflow-wrap:anywhere] ${item.state === "skipped" ? "line-through opacity-60" : ""}`}>{item.text}</bdi>
                </li>
              ))}
            </ol>
          )}
          {card.branch && <p className="m-0"><span className="font-semibold">{t("cards.task.branch")}</span> <bdi className="font-mono">{card.branch}</bdi></p>}
          {/* When it started; when it was last updated is the card's foot. */}
          {card.startedAt && <p data-testid="status-card-started" className="m-0 text-text-primary/65">{t("cards.task.started", { ago: ago(card.startedAt / 1000) })}</p>}
          {links.length > 0 && (
            <ul className="m-0 list-none space-y-1 p-0">
              {links.map((link, i) => (
                <li key={i}>
                  <a data-testid="status-card-link" {...externalLinkProps(link.url)} className="text-link underline decoration-dotted" dir="ltr">
                    <bdi>{link.label ?? cardLinkHost(link.url)}</bdi>
                  </a>
                  <span className="text-text-primary/50"> {cardLinkHost(link.url)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* The card's foot: its facts at the start, when it changed and its marks at the end; a narrow card wraps them. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-3.5 pb-2 pt-1.5 text-[11.5px] leading-4 text-text-secondary">
        {facts.length > 0 && <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">{facts}</span>}
        {(time || marks) && <span className="ms-auto flex shrink-0 items-center gap-[3px] text-[11px]">{time}{marks}</span>}
      </div>
    </div>
  );
}


/**
 * A message's card, for a kind `showsCard` takes. `time` is when the message came or last changed (`CardTime`), `marks`
 * its delivery marks when it is mine: a task's foot has both, a routine's line its marks and its opened foot the time.
 * `end` the message's last change, for how long a finished task took.
 */
export function StatusCardView({ card, time, marks, end }: { card: ShownCard; time?: ReactNode; marks?: ReactNode; end?: number }) {
  return card.kind === "task" ? <TaskView card={card} time={time} marks={marks} end={end} /> : <RoutineView card={card} time={time} marks={marks} />;
}

/**
 * "running for 12 min", "blocked for 5 min", "took 42 min": how long a task has been at it (`taskElapsed`), kept
 * current once a minute by the page's one clock while it is on screen. Nothing when the card says no start.
 */
export function TaskElapsedLine({ card, end, testId, className = "" }: { card: TaskCard; end?: number; testId: string; className?: string }) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLSpanElement>(null);
  const now = useMinuteClock(ref);
  const elapsed = taskElapsed(card, now, end);
  return (
    <span ref={ref} data-testid={testId} data-kind={elapsed?.kind} className={`min-w-0 truncate ${className}`}>
      {elapsed && t(`cards.task.elapsed.${elapsed.kind}`, { duration: durationIn(language)(elapsed.ms) })}
    </span>
  );
}

/**
 * A card message's time, where a bubble has its time and "edited": updates are a card's normal life, so a card that
 * changed says when ("updated 2 min ago"), kept current like `TaskElapsedLine`; one that never did, the time it came.
 * The exact time on hover.
 */
export function CardTime({ sent, changed }: { sent: number; changed?: number }) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLSpanElement>(null);
  const now = useMinuteClock(ref);
  const at = changed ?? sent;
  const updated = changed !== undefined ? t("cards.task.updated", { ago: agoIn(language)(changed / 1000, Math.max(now, changed) / 1000) }) : undefined;
  return (
    <span ref={ref} data-testid="status-card-time" data-updated={changed !== undefined || undefined} title={clockTime(at, language)} className="shrink-0 whitespace-nowrap">
      {updated ?? clockTime(at, language)}
    </span>
  );
}
