import { useId, useState } from "react";
import { cardLinkHost, type RoutineCard, type RunResult } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { externalLinkProps } from "../../lib/externalLink";
import { agoIn } from "../../lib/relativeTime";
import { RESULT_TONE, untilIn } from "../../lib/statusCards";

/*
 * A bot's routine in the chat (WISP 4xx · Status Cards): something it runs on a schedule. Compact: the name, the
 * schedule, the last run's result and time, the next run as a relative time; opened in place, the recent runs, the cron
 * line and the links. The app keeps no schedule and runs nothing: it shows what the bot last said.
 */

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
      className="my-0.5 w-[min(320px,72vw)] max-w-full rounded-lg border border-text-primary/10 bg-text-primary/5 text-start">
      <button type="button" data-testid="status-card-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="block w-full cursor-pointer rounded-lg p-2.5 text-start focus-visible:outline-2 focus-visible:outline-accent">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className={`shrink-0 text-[13px] ${paused ? "text-text-primary/50" : "text-accent"}`}>↻</span>
          <bdi data-testid="status-card-title" className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-text-primary">{card.name}</bdi>
          <span data-testid="status-card-status" className={`shrink-0 text-[11px] font-medium ${paused ? "text-text-primary/65" : "text-accent"}`}>{t(`cards.routine.state.${card.state}`)}</span>
        </span>
        <bdi data-testid="status-card-schedule" className="mt-1 block truncate text-xs text-text-primary/80">{card.schedule}</bdi>
        <span className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
          <span data-testid="status-card-last" className="min-w-0">
            {card.lastRun ? <RunLine result={card.lastRun.result} at={card.lastRun.at} /> : <span className="text-text-primary/65">{t("cards.routine.noRuns")}</span>}
          </span>
          {card.nextRunAt && !paused && (
            <span data-testid="status-card-next" className="shrink-0 text-text-primary/65">{t("cards.routine.next", { when: untilIn(language)(card.nextRunAt) })}</span>
          )}
        </span>
      </button>
      {open && (
        <div id={detailsId} data-testid="status-card-details" className="space-y-2 border-t border-text-primary/10 px-2.5 pb-2.5 pt-2 text-xs leading-snug text-text-primary/80">
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
