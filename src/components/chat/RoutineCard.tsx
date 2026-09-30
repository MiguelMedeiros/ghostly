import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cardLinkHost, type RoutineCard, type RunResult } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { externalLinkProps } from "../../lib/externalLink";
import { agoIn } from "../../lib/relativeTime";
import { JUMP_EVENT } from "../../lib/replies";
import { RESULT_TONE, routineSummary, untilIn } from "../../lib/statusCards";

/*
 * A bot's routine in the chat (WISP 4xx · Status Cards): something it runs on a schedule. One line, as a bot may post
 * ten of them: the name, the schedule, the next run as a relative time and the last run's mark; opened in place, the
 * last run's result and time, the recent runs, the cron line and the links. The app keeps no schedule and runs nothing:
 * it shows what the bot last said. Several routines in a row from one sender fold into one row (`RoutineStack`).
 */

/** "10 routines · next in 4 min · ✓ all OK": what some routines come to, on one line. */
export function RoutineSummaryLine({ cards }: { cards: readonly RoutineCard[] }) {
  const { t, language } = useI18n();
  const s = routineSummary(cards);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span data-testid="routine-summary-count" className="shrink-0 font-medium text-text-primary">
        {s.count === 1 ? t("cards.panel.routinesOne") : t("cards.panel.routinesMany", { count: s.count })}
      </span>
      {s.next && <span className="min-w-0 truncate text-text-primary/65">· {t("cards.panel.nextRun", { when: untilIn(language)(s.next) })}</span>}
      {s.failed > 0
        ? <span data-testid="routine-summary-result" data-result="failed" className={`shrink-0 font-medium ${RESULT_TONE.failed.label}`}>· {RESULT_TONE.failed.mark} {t("cards.panel.failedCount", { count: s.failed })}</span>
        : s.ran > 0 && <span data-testid="routine-summary-result" data-result="ok" className={`shrink-0 font-medium ${RESULT_TONE.ok.label}`}>· {RESULT_TONE.ok.mark} {t("cards.panel.allOk")}</span>}
    </span>
  );
}

/**
 * Routines in a row from one sender, folded into one row of the chat: "↻ Hermes Zero · 10 routines · next in 4 min"; a
 * tap opens it on their cards. A jump to one of them (a Tasks panel row, a quote, a search) opens it first.
 */
export function RoutineStack({ name, cards, mine, children }: { name?: string; cards: readonly RoutineCard[]; mine: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    const el = ref.current;
    // Before the list measures where the row is (useChatScroll listens further up).
    const reveal = () => flushSync(() => setOpen(true));
    el?.addEventListener(JUMP_EVENT, reveal);
    return () => el?.removeEventListener(JUMP_EVENT, reveal);
  }, []);
  return (
    <div ref={ref} data-testid="routine-stack" data-count={cards.length} data-open={open ? "" : undefined}>
      <div className={`flex ${mine ? "justify-end" : "justify-start"} mb-3.5 message-row-x`}>
        {/* A bubble's look: the sender's name over the line, as on their messages. */}
        <button type="button" data-testid="routine-stack-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}
          className={`block w-[min(340px,78vw)] max-w-[85%] cursor-pointer rounded-[7.5px] px-[9px] pt-[5px] pb-[7px] text-start text-[12px] text-text-primary shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] focus-visible:outline-2 focus-visible:outline-accent ${mine ? "bg-sent-bg" : "bg-received-bg"}`}>
          {name && <bdi data-testid="routine-stack-name" className="mb-0.5 block truncate text-[12.8px] font-medium leading-[20px] text-accent-hover">~{name}</bdi>}
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="shrink-0 text-[13px] text-accent">↻</span>
            <span className="min-w-0 flex-1"><RoutineSummaryLine cards={cards} /></span>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`shrink-0 text-text-primary/65 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : "rtl:-scale-x-100"}`}><path d="m9 6 6 6-6 6" /></svg>
          </span>
        </button>
      </div>
      <div id={listId} hidden={!open}>{children}</div>
    </div>
  );
}

function RunLine({ result, at, summary }: { result: RunResult; at: number; summary?: string }) {
  const { t, language } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${RESULT_TONE[result].dot}`} />
      <span className={`shrink-0 font-medium ${RESULT_TONE[result].label}`}>{t(`cards.routine.result.${result}`)}</span>
      <span className="shrink-0 text-text-primary/65">{agoIn(language)(at / 1000)}</span>
      {summary && <bdi className="min-w-0 truncate text-text-primary/65">· {summary}</bdi>}
    </span>
  );
}

export function RoutineView({ card }: { card: RoutineCard }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const paused = card.state === "paused";
  return (
    <div data-testid="status-card" data-kind="routine" data-card-id={card.id} data-state={card.state} data-open={open ? "" : undefined}
      className="@container my-0.5 w-[min(320px,72vw)] max-w-full rounded-lg border border-text-primary/10 bg-text-primary/5 text-start">
      {/* One line: ↻, the name, the schedule, the next run (or Paused), the last run's mark. */}
      <button type="button" data-testid="status-card-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-start text-[11px] text-text-primary/65 focus-visible:outline-2 focus-visible:outline-accent">
        <span aria-hidden="true" className={`shrink-0 text-[13px] ${paused ? "text-text-primary/50" : "text-accent"}`}>↻</span>
        {/* Narrow, the schedule gives way first: the name is what tells routines apart. */}
        <bdi data-testid="status-card-title" className="me-auto min-w-12 shrink-[0.1] truncate text-[13px] font-semibold text-text-primary">{card.name}</bdi>
        <bdi data-testid="status-card-schedule" className="min-w-0 shrink-[4] truncate ps-1 @max-[17rem]:hidden">{card.schedule}</bdi>
        <span data-testid="status-card-status" className={paused ? "shrink-0 font-medium" : "sr-only"}>{t(`cards.routine.state.${card.state}`)}</span>
        {card.nextRunAt && !paused && (
          <span data-testid="status-card-next" className="shrink-0"><span aria-hidden="true">· </span>{untilIn(language)(card.nextRunAt)}</span>
        )}
        <span data-testid="status-card-last" data-result={card.lastRun?.result} className={`w-3 shrink-0 text-center font-semibold ${card.lastRun ? RESULT_TONE[card.lastRun.result].label : ""}`}>
          <span aria-hidden="true">{card.lastRun ? RESULT_TONE[card.lastRun.result].mark : ""}</span>
          <span className="sr-only">{card.lastRun ? t("cards.routine.lastRun", { result: t(`cards.routine.result.${card.lastRun.result}`) }) : t("cards.routine.noRuns")}</span>
        </span>
      </button>
      {open && (
        <div id={detailsId} data-testid="status-card-details" className="space-y-2 border-t border-text-primary/10 px-2.5 pb-2.5 pt-2 text-xs leading-snug text-text-primary/80">
          {/* The schedule, where the line above had no room for it. */}
          <p className="m-0 [overflow-wrap:anywhere] @min-[17rem]:hidden"><bdi>{card.schedule}</bdi></p>
          <p data-testid="status-card-last-run" className="m-0 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            {card.lastRun ? <RunLine result={card.lastRun.result} at={card.lastRun.at} /> : <span className="text-text-primary/65">{t("cards.routine.noRuns")}</span>}
            {card.nextRunAt && !paused && <span className="shrink-0 text-text-primary/65">{t("cards.routine.next", { when: untilIn(language)(card.nextRunAt) })}</span>}
          </p>
          {card.lastRun?.summary && <p className="m-0 [overflow-wrap:anywhere]"><bdi>{card.lastRun.summary}</bdi></p>}
          {card.cron && <p className="m-0"><span className="font-semibold">{t("cards.routine.cron")}</span> <bdi className="font-mono" dir="ltr">{card.cron}</bdi></p>}
          {card.runs && (
            <div>
              <p className="m-0 mb-1 font-semibold">{t("cards.routine.runs")}</p>
              <ol className="m-0 list-none space-y-1 p-0">
                {card.runs.map((run, i) => (
                  <li key={i} data-testid="status-card-run" data-result={run.result}><RunLine result={run.result} at={run.at} summary={run.summary} /></li>
                ))}
              </ol>
            </div>
          )}
          {card.links?.length ? (
            <ul className="m-0 list-none space-y-1 p-0">
              {card.links.map((link, i) => (
                <li key={i}>
                  <a data-testid="status-card-link" {...externalLinkProps(link.url)} className="text-link underline decoration-dotted" dir="ltr"><bdi>{link.label ?? cardLinkHost(link.url)}</bdi></a>
                  <span className="text-text-primary/50"> {cardLinkHost(link.url)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
