import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cardLinkHost, type RoutineCard, type RunResult } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { externalLinkProps } from "../../lib/externalLink";
import { agoIn } from "../../lib/relativeTime";
import { JUMP_EVENT } from "../../lib/replies";
import { RESULT_TONE, routineSummary, untilIn } from "../../lib/statusCards";
import { useMemberText } from "../../contexts/MemberColorsContext";
import { SenderAvatar, type MessageAuthor } from "./SenderAvatar";

/*
 * A bot's routine in the chat (WISP 405 · Status Cards): something it runs on a schedule. Small, as a bot may post ten
 * of them: the name, then the schedule, the next run as a relative time and the last run's result (one line on a wide
 * card, two on a narrow one); opened in place, the last run's words, the recent runs, the cron line and the links. The app keeps no schedule and runs nothing:
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
export function RoutineStack({ name, cards, mine, children, author, onOpenAuthor }: {
  name?: string; cards: readonly RoutineCard[]; mine: boolean; children: ReactNode;
  /** A group member's row: their colour on the name, their picture beside it when it ends a run of theirs (SenderAvatar). */
  author?: MessageAuthor; onOpenAuthor?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const memberText = useMemberText();
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
      <div className={`flex ${mine ? "justify-end" : "justify-start"} gap-1 mb-3.5 message-row-x`}>
        {/* Open, the picture goes down beside the last of its cards (GroupChat passes them the run's end), not here too. */}
        {!mine && author && <SenderAvatar author={open ? { ...author, last: false } : author} onOpen={onOpenAuthor} />}
        {/* A card's look, as the cards it folds (MessageBubble): the sender's name above it, as over their cards. */}
        <div className={`flex min-w-0 w-[min(420px,85%)] flex-col ${mine ? "items-end" : "items-start"}`}>
          {name && <bdi data-testid="routine-stack-name" data-key={author?.key} className={`mb-0.5 block max-w-full truncate px-1 text-[12.8px] font-medium leading-[20px] ${author ? memberText(author.key) : "text-accent-hover"}`}>~{name}</bdi>}
          <button type="button" data-testid="routine-stack-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}
            className="status-card-surface flex w-full min-w-0 cursor-pointer items-center gap-2 py-2 ps-3.5 pe-3 text-start text-[12px] text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <span aria-hidden="true" className="w-4 shrink-0 text-center text-[14px] text-accent">↻</span>
            <span className="min-w-0 flex-1"><RoutineSummaryLine cards={cards} /></span>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`shrink-0 text-text-primary/65 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : "rtl:-scale-x-100"}`}><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </div>
      </div>
      <div id={listId} hidden={!open}>{children}</div>
    </div>
  );
}

/** The "·" between two facts on a line. */
const Sep = ({ className = "" }: { className?: string }) => <span aria-hidden="true" className={`shrink-0 text-text-muted ${className}`}>·</span>;

/** "● Failed 2 h ago · CI flaked": a run, its words cut to the line (whole on hover). */
function RunLine({ result, at, summary }: { result: RunResult; at: number; summary?: string }) {
  const { t, language } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={summary}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${RESULT_TONE[result].dot}`} />
      <span className={`shrink-0 font-medium ${RESULT_TONE[result].label}`}>{t(`cards.routine.result.${result}`)}</span>
      <span className="shrink-0 text-text-secondary">{agoIn(language)(at / 1000)}</span>
      {summary && <><Sep /><bdi className="min-w-0 truncate text-text-secondary">{summary}</bdi></>}
    </span>
  );
}

/**
 * A routine's card. Closed, its line: ↻ and its name, then its next run and last run at the end of the line on a card
 * 24rem wide or more (the `@min-[24rem]:` classes), or under the name with its schedule on a narrower one. Nothing on
 * it is wider than the card: the name ends in "…", whole on hover and opened. Opened in place: the whole name, the last
 * run and its words, the next run, the schedule and cron line, the recent runs, the links, and when the card last
 * changed (`time`). `marks`: my own card's delivery marks, at the end of its line.
 */
export function RoutineView({ card, time, marks }: { card: RoutineCard; time?: ReactNode; marks?: ReactNode }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const paused = card.state === "paused";
  const last = card.lastRun;
  const next = card.nextRunAt && !paused ? untilIn(language)(card.nextRunAt) : undefined;
  return (
    <div data-testid="status-card" data-kind="routine" data-card-id={card.id} data-state={card.state} data-open={open ? "" : undefined}
      className="@container w-full min-w-0 text-start">
      <div className="flex min-w-0 items-center">
        {/* A long press or a swipe on it is the message's, as on a bubble (MessageBubble's gestures let this button through). */}
        <button type="button" data-testid="status-card-toggle" data-press-through aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-[9px] py-2 ps-3.5 pe-3 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
          <span aria-hidden="true" className={`w-4 shrink-0 text-center text-[14px] leading-5 ${paused ? "text-text-muted" : "text-accent"}`}>↻</span>
          <span className={`flex min-w-0 flex-1 flex-col gap-0.5 ${open ? "" : "@min-[24rem]:flex-row @min-[24rem]:items-center @min-[24rem]:gap-3"}`}>
            <bdi data-testid="status-card-title" title={card.name}
              className={`min-w-0 flex-1 text-[13px] font-semibold leading-5 text-text-primary ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>{card.name}</bdi>
            {/* Opened, the details say all of this. Wide, the schedule is left to them (and the next run's hover): the
                name comes first. */}
            <span className={`${open ? "hidden" : "flex"} min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-text-secondary @min-[24rem]:shrink-0`}>
              <bdi data-testid="status-card-schedule" className="min-w-0 shrink-[100] truncate @min-[24rem]:hidden">{card.schedule}</bdi>
              <Sep className="@min-[24rem]:hidden" />
              <span data-testid="status-card-status" className={paused ? "shrink-0 font-medium" : "sr-only"}>{t(`cards.routine.state.${card.state}`)}</span>
              {paused && <Sep />}
              {next && <><span data-testid="status-card-next" title={card.schedule} className="shrink-0 whitespace-nowrap">{next}</span><Sep /></>}
              <span data-testid="status-card-last" data-result={last?.result}
                className={`inline-flex items-center gap-1 ${last ? `shrink-0 font-medium ${RESULT_TONE[last.result].label}` : "min-w-0"}`}>
                {last ? <>
                  <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${RESULT_TONE[last.result].dot}`} />
                  <span aria-hidden="true" className="min-w-0 truncate">{t(`cards.routine.result.${last.result}`)}</span>
                  <span className="sr-only">{t("cards.routine.lastRun", { result: t(`cards.routine.result.${last.result}`) })}</span>
                </> : <span className="min-w-0 truncate">{t("cards.routine.noRuns")}</span>}
              </span>
            </span>
          </span>
        </button>
        {marks && <span className="flex shrink-0 items-center gap-[3px] pe-3 text-[11px] text-text-secondary">{marks}</span>}
      </div>
      {open && (
        <div id={detailsId} data-testid="status-card-details" className="mx-3.5 flex flex-col gap-2.5 border-t border-text-primary/10 pb-1 pt-2.5 text-xs leading-snug text-text-primary/85">
          <p data-testid="status-card-last-run" className="m-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            {last ? <RunLine result={last.result} at={last.at} /> : <span className="text-text-secondary">{t("cards.routine.noRuns")}</span>}
            {card.nextRunAt && !paused && <span className="shrink-0 text-text-secondary">{t("cards.routine.next", { when: untilIn(language)(card.nextRunAt) })}</span>}
          </p>
          {last?.summary && (
            <p data-testid="status-card-summary"
              className={`m-0 rounded-md bg-text-primary/[0.05] px-2.5 py-1.5 [overflow-wrap:anywhere] ${last.result === "failed" ? "border-s-2 border-danger/70" : ""}`}>
              <bdi>{last.summary}</bdi>
            </p>
          )}
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-text-secondary">{t("cards.routine.schedule")}</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]"><bdi>{card.schedule}</bdi></dd>
            {card.cron && <>
              <dt className="text-text-secondary">{t("cards.routine.cron")}</dt>
              <dd className="m-0 min-w-0"><bdi className="font-mono" dir="ltr">{card.cron}</bdi></dd>
            </>}
          </dl>
          {card.runs && (
            <div>
              <p className="m-0 mb-1 text-text-secondary">{t("cards.routine.runs")}</p>
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
                <li key={i} className="min-w-0 [overflow-wrap:anywhere]">
                  <a data-testid="status-card-link" {...externalLinkProps(link.url)} className="text-link underline decoration-dotted" dir="ltr"><bdi>{link.label ?? cardLinkHost(link.url)}</bdi></a>
                  <span className="text-text-muted"> {cardLinkHost(link.url)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {open && time && <div className="flex justify-end px-3.5 pb-2 pt-1 text-[11px] leading-4 text-text-secondary">{time}</div>}
    </div>
  );
}
