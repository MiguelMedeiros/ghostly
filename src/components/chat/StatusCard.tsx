import { useId, useState } from "react";
import { cardLinkHost, taskProgress, type TaskCard, type ItemState, type StatusCard } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { externalLinkProps } from "../../lib/externalLink";
import { agoIn } from "../../lib/relativeTime";
import { STATUS_TONE, isFinished } from "../../lib/statusCards";
import { RoutineView } from "./RoutineCard";

/*
 * A bot's status card in the chat (WISP 4xx · Status Cards), shown instead of the message's text, which is only its
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

function TaskView({ card }: { card: TaskCard }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const ago = agoIn(language);
  const progress = taskProgress(card);
  const links = [...(card.pr ? [{ url: card.pr.url, label: card.pr.number !== undefined ? t("cards.task.pr", { number: card.pr.number }) : t("cards.task.prNoNumber") }] : []), ...(card.links ?? [])];
  return (
    <div data-testid="status-card" data-kind="task" data-card-id={card.id} data-status={card.status} data-open={open ? "" : undefined}
      className="my-0.5 w-[min(320px,72vw)] max-w-full rounded-lg border border-text-primary/10 bg-text-primary/5 text-start">
      <button type="button" data-testid="status-card-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="block w-full cursor-pointer rounded-lg p-2.5 text-start focus-visible:outline-2 focus-visible:outline-accent">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${STATUS_TONE[card.status].dot}`} />
          <bdi data-testid="status-card-title" className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-text-primary">{card.title}</bdi>
          <span data-testid="status-card-status" className={`shrink-0 text-[11px] font-medium ${STATUS_TONE[card.status].label}`}>
            {STATUS_TONE[card.status].mark && <span aria-hidden="true">{STATUS_TONE[card.status].mark} </span>}{t(`cards.task.status.${card.status}`)}
          </span>
        </span>
        <ProgressBar card={card} className="mt-2" />
        <span className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-text-primary/65">
          <span className="min-w-0 truncate">
            {progress !== undefined && <span>{progress}%</span>}
            {card.done !== undefined && card.total !== undefined && <span>{progress !== undefined ? " · " : ""}{t("cards.task.steps", { done: card.done, total: card.total })}</span>}
          </span>
          <PrLine card={card} />
        </span>
      </button>
      {open && (
        <div id={detailsId} data-testid="status-card-details" className="space-y-2 border-t border-text-primary/10 px-2.5 pb-2.5 pt-2 text-xs leading-snug text-text-primary/80">
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
          {(card.startedAt || card.updatedAt) && (
            <p className="m-0 text-text-primary/65">
              {card.startedAt && t("cards.task.started", { ago: ago(card.startedAt / 1000) })}
              {card.startedAt && card.updatedAt && " · "}
              {card.updatedAt && t("cards.task.updated", { ago: ago(card.updatedAt / 1000) })}
            </p>
          )}
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
    </div>
  );
}


/** A message's card, for a kind `showsCard` takes. */
export function StatusCardView({ card }: { card: StatusCard }) {
  return card.kind === "task" ? <TaskView card={card} /> : <RoutineView card={card} />;
}
