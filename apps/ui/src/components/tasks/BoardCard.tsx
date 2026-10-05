import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { cardLinkHost, taskProgress } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { externalLinkProps } from "../../lib/externalLink";
import { agoIn } from "../../lib/relativeTime";
import { STATUS_TONE, isFinished } from "../../lib/statusCards";
import { boardCardLabel, partsDone, progressText, type BoardGrouping, type BoardTask } from "../../lib/taskBoard";
import type { PrChecks } from "@ghostly/core";
import { MemberFace, type MemberFaceOf } from "../chat/SenderAvatar";

/*
 * A task on the Tasks board (WISP 405 · Status Cards § The Tasks board): two lines. Its title on one line (whole in its
 * tooltip, and unfolded while the keys are on it) with how long ago it last changed; then at most three chips: who sent
 * it, where, and its pull request. A thin bar along its foot is its progress. The rest is behind Details. The card is a
 * button that opens its chat on its message; it changes nothing: the bot that owns a task changes its status.
 */

/** A pull request's checks at a glance: a still mark in the status tones, with its words for a screen reader. */
const CHECKS_MARK: Record<PrChecks, { mark: string; tone: string }> = {
  passing: { mark: "✓", tone: "text-success" },
  failing: { mark: "✕", tone: "text-danger-ink" },
  pending: { mark: "●", tone: "text-amber-500" },
};

const chip = "inline-flex min-w-0 items-center gap-1 rounded-full bg-text-primary/[0.07] px-1.5 py-px text-[11px] leading-4 text-text-secondary";

export function BoardCard({ task, grouping, face, now, onOpen, onOpenPart, onKeys, onTag }: {
  task: BoardTask;
  grouping: BoardGrouping;
  face?: MemberFaceOf;
  /** Opens one of the task's parts in its chat. */
  onOpenPart?: (part: BoardTask) => void;
  /** A tag's chip filters the board by it. */
  onTag?: (tag: string) => void;
  /** The board's clock, moving once a minute. */
  now: number;
  onOpen: () => void;
  /** The arrow keys, Home and End on the card: the board moves the focus. */
  onKeys?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const detailsId = useId();
  const stackId = useId();
  const parts = partsDone(task);
  const { card } = task;
  const tone = STATUS_TONE[card.status];
  const progress = taskProgress(card);
  const age = agoIn(language)(task.at / 1000, now / 1000);
  const words = progressText(t, task);
  // A 1:1 chat's bot is its contact: one chip says both.
  const sameName = task.bot === task.chat;
  const prTitle = card.pr && [t("cards.board.card.openPr", { host: cardLinkHost(card.pr.url) }), card.pr.state && t(`cards.board.card.prState.${card.pr.state}`),
    card.pr.checks && t(`cards.board.card.checks.${card.pr.checks}`)].filter(Boolean).join(" · ");
  const chips: ReactNode[] = [
    // The column says the status when the board is in columns by status; grouped otherwise, the card does.
    ...(grouping !== "status" ? [
      <span key="status" data-testid="board-card-status" className={`${chip} shrink-0 ${tone.label}`}>
        {tone.mark ? <span aria-hidden="true">{tone.mark}</span> : <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />}
        {t(`cards.task.status.${card.status}`)}
      </span>] : []),
    ...(grouping !== "bot" ? [
      <span key="bot" data-testid="board-card-bot" className={chip}>
        {face && <MemberFace face={face} size={14} />}
        <bdi className="min-w-0 truncate">{task.bot}</bdi>
      </span>] : []),
    ...(grouping !== "chat" && !(sameName && grouping !== "bot") ? [
      <span key="chat" data-testid="board-card-chat" className={chip}>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        <bdi className="min-w-0 truncate">{task.chat}</bdi>
      </span>] : []),
    ...(card.pr ? [
      // The only thing on a card that leaves the app: an https link (the reader's rule), opened outside, by its host.
      <a key="pr" data-testid="board-card-pr" data-state={card.pr.state} {...externalLinkProps(card.pr.url)} title={prTitle}
        className={`${chip} pointer-events-auto relative z-10 shrink-0 no-underline hover:bg-text-primary/[0.14] hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent`}>
        {card.pr.checks && (
          <span data-testid="board-card-checks" data-checks={card.pr.checks} className={`font-semibold ${CHECKS_MARK[card.pr.checks].tone}`}>
            <span aria-hidden="true">{CHECKS_MARK[card.pr.checks].mark}</span>
            <span className="sr-only">{t(`cards.board.card.checks.${card.pr.checks}`)}</span>
          </span>
        )}
        <span>{card.pr.number !== undefined ? t("cards.task.pr", { number: card.pr.number }) : t("cards.task.prNoNumber")}</span>
        {(card.pr.additions !== undefined || card.pr.deletions !== undefined) && (
          <span dir="ltr" className="inline-flex gap-1 tabular-nums">
            {card.pr.additions !== undefined && <span className="text-accent">+{card.pr.additions}</span>}
            {card.pr.deletions !== undefined && <span className="text-danger-ink">−{card.pr.deletions}</span>}
          </span>
        )}
      </a>] : []),
    ...(card.tags ?? []).map((tag) => (
      <button key={`tag ${tag}`} type="button" data-testid="board-card-tag" onClick={() => onTag?.(tag)} title={t("cards.board.tagFilter", { tag })}
        className={`${chip} pointer-events-auto relative z-10 cursor-pointer border-none hover:bg-text-primary/[0.14] hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent`}>
        <bdi className="min-w-0 truncate">{tag}</bdi>
      </button>)),
  ].slice(0, 3);
  return (
    <article data-testid="board-card" data-card-id={card.id} data-status={card.status} data-open={open ? "" : undefined}
      className="relative min-w-0 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-alt text-start transition-colors hover:bg-surface-hover has-[[data-board-card]:focus-visible]:border-accent">
      {/* The card as a whole is this button; the link and Details sit above it and take their own clicks. */}
      {/* The title opens while the button has keyboard focus, by a sibling rule. Tailwind's group variant of `has` would write a
          `:has()` rule anchored on every `.group`, which each message row is, and a keystroke in a long chat pays for it. */}
      <button type="button" data-board-card data-testid="board-card-open" aria-label={boardCardLabel(t, task, age)} title={card.title} onClick={onOpen} onKeyDown={onKeys}
        className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent" />
      <div className="pointer-events-none relative px-2.5 pt-2 pb-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
          <bdi data-testid="board-card-title"
            className={`min-w-0 flex-1 text-[13px] font-medium leading-5 text-text-primary ${open ? "[overflow-wrap:anywhere]" : "truncate [[data-board-card]:focus-visible~*_&]:whitespace-normal [[data-board-card]:focus-visible~*_&]:[overflow-wrap:anywhere]"}`}>{card.title}</bdi>
          <time data-testid="board-card-age" dateTime={new Date(task.at).toISOString()} className="shrink-0 text-[11px] leading-5 text-text-muted">{age}</time>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 ps-4">
          <div data-testid="board-card-chips" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{chips}</div>
          <button type="button" data-testid="board-card-details-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
            aria-label={t("cards.board.card.details")} title={t("cards.board.card.details")}
            className="pointer-events-auto relative z-10 -my-1 -me-1 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted hover:bg-text-primary/10 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-md:h-8 max-md:w-8">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </div>
        {open && (
          <dl id={detailsId} data-testid="board-card-details" className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-text-primary/10 ps-4 pt-2 text-[11.5px] leading-snug text-text-secondary">
            <dt className="font-semibold">{t("cards.board.card.statusLabel")}</dt>
            <dd className={`m-0 ${tone.label}`}>{t(`cards.task.status.${card.status}`)}{words ? <span className="text-text-secondary"> · {words}</span> : null}</dd>
            {card.step && !isFinished(card.status) && <><dt className="font-semibold">{t("cards.task.now")}</dt><dd className="m-0 min-w-0 [overflow-wrap:anywhere]"><bdi>{card.step}</bdi></dd></>}
            <dt className="font-semibold">{t("cards.board.card.botLabel")}</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]"><bdi>{task.bot}</bdi></dd>
            <dt className="font-semibold">{t("cards.board.card.chatLabel")}</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]"><bdi>{task.chat}</bdi></dd>
            {card.branch && <><dt className="font-semibold">{t("cards.task.branch")}</dt><dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere]"><bdi>{card.branch}</bdi></dd></>}
            {(card.pr?.state || card.pr?.checks) && <><dt className="font-semibold">{t("cards.board.card.prLabel")}</dt>
              <dd data-testid="board-card-pr-standing" className="m-0">{[card.pr.state && t(`cards.board.card.prState.${card.pr.state}`), card.pr.checks && t(`cards.board.card.checks.${card.pr.checks}`)].filter(Boolean).join(" · ")}</dd></>}
            {card.pr?.files !== undefined && <><dt className="font-semibold">{t("cards.board.card.filesLabel")}</dt><dd className="m-0 tabular-nums">{card.pr.files}</dd></>}
            {card.tags && <><dt className="font-semibold">{t("cards.board.card.tagsLabel")}</dt><dd data-testid="board-card-tags" className="m-0 min-w-0 [overflow-wrap:anywhere]"><bdi>{card.tags.join(", ")}</bdi></dd></>}
            <dt className="font-semibold">{t("cards.board.card.updatedLabel")}</dt>
            <dd className="m-0">{new Date(task.at).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" })}</dd>
          </dl>
        )}
        {parts && task.parts && (
          <div data-testid="board-card-stack" data-open={stackOpen ? "" : undefined} className="mt-1.5 ps-4">
            {/* The tasks that are parts of this one, stacked under it: how many are done, and the parts on a tap. */}
            <button type="button" data-testid="board-card-stack-toggle" aria-expanded={stackOpen} aria-controls={stackId} onClick={() => setStackOpen(!stackOpen)}
              className="pointer-events-auto relative z-10 -ms-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-text-primary/10 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-8">
              <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                className={`transition-transform motion-reduce:transition-none ${stackOpen ? "rotate-90" : "rtl:-scale-x-100"}`}><path d="m9 6 6 6-6 6" /></svg>
              <span data-testid="board-card-parts">{t("cards.board.card.parts", parts)}</span>
            </button>
            {stackOpen && (
              <ul id={stackId} className="m-0 mt-1 list-none space-y-0.5 border-s border-text-primary/15 p-0 ps-2">
                {task.parts.map((part) => (
                  <li key={part.key} className="m-0">
                    <button type="button" data-testid="board-card-part" data-card-id={part.card.id} data-status={part.card.status} onClick={() => onOpenPart?.(part)} title={part.card.title}
                      className="pointer-events-auto relative z-10 flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-start text-[12px] text-text-primary hover:bg-text-primary/10 focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-8">
                      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_TONE[part.card.status].dot}`} />
                      <bdi className="min-w-0 flex-1 truncate">{part.card.title}</bdi>
                      <span className={`shrink-0 text-[11px] ${STATUS_TONE[part.card.status].label}`}>{t(`cards.task.status.${part.card.status}`)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {/* Progress along the card's foot: a still bar, never a spinner (an app nobody touches draws nothing). */}
      {progress !== undefined && (
        <div role="progressbar" aria-label={t("cards.task.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} data-testid="board-card-progress"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-text-primary/10">
          <div className={`h-full ${tone.bar}`} style={{ width: `${progress}%` }} />
        </div>
      )}
    </article>
  );
}
