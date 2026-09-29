import { useMemo, useRef, useState } from "react";
import { taskProgress } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { drawEveryRow } from "../../hooks/useTailFirst";
import { jumpToMessage } from "../../lib/replies";
import { STATUS_TONE, activeTaskCount, cardEntries, type CardEntry, type CardRow } from "../../lib/statusCards";
import { Menu, MenuSeparator } from "../Menu";
import { PrLine, ProgressBar } from "./StatusCard";

/*
 * The Tasks button of a chat or group header (WISP 4xx · Status Cards): there only while the chat has a bot's card,
 * with the number of tasks still going. It opens a list, active tasks first with their progress, then finished ones,
 * then routines; a row scrolls to its card and marks it, as a quote's tap does.
 */

const icon = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function Row({ entry, onOpen }: { entry: CardEntry; onOpen: () => void }) {
  const { t } = useI18n();
  const { card } = entry;
  const row = "flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-start transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none cursor-pointer max-md:rounded-lg";
  if (card.kind !== "task") {
    return (
      <button type="button" role="menuitem" data-menu-item data-testid="chat-tasks-item" data-card-id={card.id} data-kind={card.kind} onClick={onOpen} className={row}>
        <bdi className="block truncate text-sm text-text-primary">{card.name}</bdi>
        <bdi className="block truncate text-xs text-text-muted">{card.schedule}</bdi>
      </button>
    );
  }
  const progress = taskProgress(card);
  return (
    <button type="button" role="menuitem" data-menu-item data-testid="chat-tasks-item" data-card-id={card.id} data-kind="task" data-status={card.status} data-active={entry.active ? "" : undefined}
      onClick={onOpen} className={row}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${STATUS_TONE[card.status].dot}`} />
        <bdi className="min-w-0 flex-1 truncate text-sm text-text-primary">{card.title}</bdi>
        <span className="shrink-0 text-xs text-text-muted">{progress !== undefined && entry.active ? `${progress}%` : t(`cards.task.status.${card.status}`)}</span>
      </span>
      {entry.active && <ProgressBar card={card} />}
      {card.pr && <span className="text-xs text-text-muted"><PrLine card={card} /></span>}
    </button>
  );
}

export function TasksButton({ rows }: { rows: readonly CardRow[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => cardEntries(rows), [rows]);
  if (!entries.length) return null;
  const active = activeTaskCount(entries);
  const tasks = entries.filter((e) => e.card.kind === "task");
  const groups: ["active" | "finished" | "routines", CardEntry[]][] = [
    ["active", tasks.filter((e) => e.active)],
    ["finished", tasks.filter((e) => !e.active)],
    ["routines", entries.filter((e) => e.card.kind === "routine")],
  ];
  const close = () => { setOpen(false); setInfo(false); };
  const go = (messageId: string) => {
    close();
    // Its row may not be drawn yet in a long chat: draw them all, then go.
    if (!jumpToMessage(messageId)) { drawEveryRow(); requestAnimationFrame(() => jumpToMessage(messageId)); }
  };
  const label = active ? t("cards.panel.buttonCount", { count: active }) : t("cards.panel.button");
  return (
    <div className="relative" ref={ref}>
      <button type="button" data-testid="chat-tasks" onClick={() => setOpen(!open)} aria-haspopup="true" aria-expanded={open} aria-label={label} title={label}
        className="relative p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer">
        <svg {...icon}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" /></svg>
        {active > 0 && (
          <span data-testid="chat-tasks-count" aria-hidden="true"
            className="absolute top-0.5 end-0.5 min-w-4 h-4 px-1 rounded-full bg-accent text-on-accent text-[10px] font-bold leading-4 text-center">{active > 99 ? "99+" : active}</span>
        )}
      </button>
      <Menu testId="chat-tasks-panel" open={open} onClose={close} anchorRef={ref} label={t("cards.panel.title")} className="md:w-80">
        <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">{t("cards.panel.title")}</span>
          <button type="button" data-testid="chat-tasks-info" aria-expanded={info} onClick={() => setInfo(!info)} aria-label={t("common.moreInfo")} title={t("common.moreInfo")}
            className="grid h-7 w-7 place-items-center rounded-full text-text-muted hover:text-accent hover:bg-surface-hover cursor-pointer aria-expanded:text-accent">
            <svg {...icon} width={15} height={15}><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
          </button>
        </div>
        {info && <p data-testid="chat-tasks-info-text" className="m-0 px-3 pb-2 text-xs leading-relaxed text-text-secondary whitespace-normal">{t("cards.panel.info")}</p>}
        {groups.filter(([, list]) => list.length).map(([name, list], i) => (
          <div key={name} data-testid={`chat-tasks-${name}`}>
            {i > 0 && <MenuSeparator />}
            <p className="m-0 px-3 pt-1 text-[11px] text-text-muted">{t(`cards.panel.${name}`)}</p>
            {list.map((entry) => <Row key={`${entry.author}\n${entry.card.kind}\n${entry.card.id}`} entry={entry} onOpen={() => go(entry.messageId)} />)}
          </div>
        ))}
      </Menu>
    </div>
  );
}
