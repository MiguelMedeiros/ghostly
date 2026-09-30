import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { taskProgress, type RoutineCard } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { useOutsideDismiss, useTabTrap } from "../../hooks/useDismiss";
import { useIsMobile } from "../../hooks/useIsMobile";
import { revealMessage } from "../../hooks/useRowWindow";
import { jumpToMessage } from "../../lib/replies";
import { RESULT_TONE, STATUS_TONE, activeTaskCount, cardEntries, panelModel, untilIn, type CardEntry, type CardRow } from "../../lib/statusCards";
import { RoutineSummaryLine } from "./RoutineCard";
import { PrLine, ProgressBar } from "./StatusCard";

/*
 * The Tasks button of a chat or group header (WISP 4xx · Status Cards): there only while the chat has a bot's card,
 * with the number of tasks still going. It opens a panel: per sender (a bot each, in a group), its tasks still going,
 * then its routines folded into one line; the finished tasks folded at the end. A row scrolls to its card and marks it,
 * as a quote's tap does. On a wide screen the panel drops from the button and scrolls inside the window; on a phone it
 * is a sheet from the bottom.
 */

const icon = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** The popover's width, its tallest, and the space kept from the window's edges and from the button. */
const WIDTH = 352, TALLEST = 560, MARGIN = 8, GAP = 4;

const rowClass = "flex w-full min-w-0 snap-start flex-col gap-1 px-3 py-1.5 text-start transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none cursor-pointer max-md:min-h-11 max-md:justify-center";

/**
 * A bot's name and the open Finished line stay at the top of the list while their rows scroll under them: they are all
 * this high, and the list keeps as much room above a row it scrolls to (and snaps its rows there), so no row stops
 * half under one of them.
 */
const STICKY = "sticky top-0 z-10 h-8 bg-surface-alt";
const UNDER_STICKY = "scroll-pt-8";

/** After a fold opens: as much of it in view as fits, its line kept clear of the name stuck above it. */
function reveal(toggle: HTMLElement | null) {
  const list = toggle?.closest<HTMLElement>("[data-testid=chat-tasks-scroll]");
  const block = toggle?.parentElement;
  if (!toggle || !list || !block) return;
  const view = list.getBoundingClientRect();
  const room = toggle.getBoundingClientRect().top - view.top - (parseFloat(getComputedStyle(list).scrollPaddingTop) || 0);
  const below = block.getBoundingClientRect().bottom - view.bottom;
  if (below > 0 && room > 0) list.scrollBy({ top: Math.min(below, room) });
}
/**
 * Scrolled to its end, the list would stop wherever its height puts it, maybe with a row half under the name stuck at
 * the top. The spacer at its end (less than a row high) makes its end one of the places where a row sits whole under it.
 */
function endOnRow(spacer: HTMLElement | null) {
  const list = spacer?.parentElement;
  if (!spacer || !list) return;
  spacer.style.height = "0px";
  const end = list.scrollHeight - list.clientHeight;
  if (end <= 0) return;
  const origin = list.getBoundingClientRect().top - list.scrollTop + (parseFloat(getComputedStyle(list).scrollPaddingTop) || 0);
  const stops = [...list.querySelectorAll<HTMLElement>("[data-panel-row]")].map((row) => row.getBoundingClientRect().top - origin).filter((at) => at >= end - 0.5);
  if (stops.length) spacer.style.height = `${Math.min(...stops) - end}px`;
}
const opening = (open: boolean, toggle: HTMLElement) => { if (!open) requestAnimationFrame(() => reveal(toggle)); };

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 text-text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : "rtl:-scale-x-100"}`}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function TaskRow({ entry, from, onOpen }: { entry: CardEntry; from?: string; onOpen: () => void }) {
  const { t } = useI18n();
  if (entry.card.kind !== "task") return null;
  const card = entry.card;
  const tone = STATUS_TONE[card.status];
  const progress = taskProgress(card);
  return (
    <button type="button" data-panel-row data-testid="chat-tasks-item" data-card-id={card.id} data-kind="task" data-status={card.status} data-active={entry.active ? "" : undefined}
      onClick={onOpen} className={rowClass}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
        <bdi className="min-w-0 flex-1 truncate text-sm text-text-primary">{card.title}</bdi>
        <span data-testid="chat-tasks-item-status" className={`shrink-0 text-xs font-medium ${tone.label}`}>
          {tone.mark && <span aria-hidden="true">{tone.mark} </span>}{t(`cards.task.status.${card.status}`)}
        </span>
      </span>
      {entry.active && (
        <span className="flex w-full min-w-0 items-center gap-2 ps-4 text-xs text-text-muted">
          <ProgressBar card={card} className="flex-1" />
          {progress !== undefined && <span className="shrink-0 tabular-nums">{progress}%</span>}
          {card.pr && <PrLine card={card} />}
        </span>
      )}
      {!entry.active && (from || card.pr) && (
        <span className="flex w-full min-w-0 items-center gap-1.5 ps-4 text-xs text-text-muted">
          {from && <bdi className="min-w-0 truncate">{from}</bdi>}
          {from && card.pr && <span aria-hidden="true">·</span>}
          {card.pr && <PrLine card={card} />}
        </span>
      )}
    </button>
  );
}

/** A routine on one line: ↻, its name, when it runs next (or that it is paused), and its last run's mark. */
function RoutineRow({ entry, onOpen }: { entry: CardEntry; onOpen: () => void }) {
  const { t, language } = useI18n();
  if (entry.card.kind !== "routine") return null;
  const card = entry.card;
  const last = card.lastRun;
  const paused = card.state === "paused";
  return (
    <button type="button" data-panel-row data-testid="chat-tasks-item" data-card-id={card.id} data-kind="routine" data-state={card.state} data-result={last?.result}
      onClick={onOpen} title={card.schedule} className={rowClass}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`w-2 shrink-0 text-center text-[13px] leading-none ${paused ? "text-text-muted" : "text-accent"}`}>↻</span>
        <bdi className="min-w-0 flex-1 truncate text-sm text-text-primary">{card.name}</bdi>
        <span data-testid="chat-tasks-item-next" className="shrink-0 text-xs text-text-muted">
          {paused ? t("cards.routine.state.paused") : card.nextRunAt ? untilIn(language)(card.nextRunAt) : ""}
        </span>
        <span data-testid="chat-tasks-item-last" className={`w-3 shrink-0 text-center text-xs font-semibold ${last ? RESULT_TONE[last.result].label : "text-text-muted"}`}>
          <span aria-hidden="true">{last ? RESULT_TONE[last.result].mark : ""}</span>
          <span className="sr-only">{last ? t("cards.routine.lastRun", { result: t(`cards.routine.result.${last.result}`) }) : t("cards.routine.noRuns")}</span>
        </span>
      </span>
    </button>
  );
}

/** A sender's routines: one row for a single one, else one line folding them all, opened on a tap. */
function Routines({ entries, startOpen, onOpen }: { entries: CardEntry[]; startOpen: boolean; onOpen: (entry: CardEntry) => void }) {
  const [open, setOpen] = useState(startOpen);
  const listId = useId();
  if (entries.length === 1) return <div data-testid="chat-tasks-routines"><RoutineRow entry={entries[0]} onOpen={() => onOpen(entries[0])} /></div>;
  return (
    <div data-testid="chat-tasks-routines" data-open={open ? "" : undefined}>
      <button type="button" data-panel-row data-testid="chat-tasks-routines-toggle" aria-expanded={open} aria-controls={listId}
        onClick={(e) => { opening(open, e.currentTarget); setOpen(!open); }}
        className={`${rowClass} !flex-row items-center gap-2 text-xs`}>
        <span aria-hidden="true" className="w-2 shrink-0 text-center text-[13px] leading-none text-accent">↻</span>
        <span className="min-w-0 flex-1"><RoutineSummaryLine cards={entries.map((e) => e.card as RoutineCard)} /></span>
        <Chevron open={open} />
      </button>
      {open && (
        <div id={listId} role="group" className="ms-4 border-s border-border">
          {entries.map((entry) => <RoutineRow key={entry.card.id} entry={entry} onOpen={() => onOpen(entry)} />)}
        </div>
      )}
    </div>
  );
}

/** Where the popover goes: under the button, lined up with its end edge, inside the window, never taller than it. */
function usePlace(phone: boolean, anchorRef: RefObject<HTMLElement | null>) {
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  useLayoutEffect(() => {
    if (phone) return;
    const fit = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      // happy-dom lays nothing out: its sizes are zeros, and the root's width is 0.
      const vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight;
      const opener = anchor.getBoundingClientRect();
      const width = Math.min(WIDTH, vw - 2 * MARGIN);
      // The end edge is the left one in a right-to-left page.
      const start = getComputedStyle(anchor).direction === "rtl" ? opener.left : opener.right - width;
      const left = Math.max(MARGIN, Math.min(start, vw - MARGIN - width));
      const top = opener.bottom + GAP;
      const maxHeight = Math.max(160, Math.min(vh * 0.7, TALLEST, vh - top - MARGIN));
      setPlace((was) => (was && was.left === left && was.top === top && was.width === width && was.maxHeight === maxHeight ? was : { left, top, width, maxHeight }));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [phone, anchorRef]);
  return place;
}

function TasksPanel({ entries, nameOf, anchorRef, onClose, onJump }: {
  entries: CardEntry[];
  nameOf?: (author: string) => string;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onJump: (entry: CardEntry) => void;
}) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [info, setInfo] = useState(false);
  const model = useMemo(() => panelModel(entries, !!nameOf), [entries, nameOf]);
  const [finishedOpen, setFinishedOpen] = useState(!model.sections.length);
  const place = usePlace(phone, anchorRef);
  useOutsideDismiss(ref, true, onClose, anchorRef);
  useTabTrap(ref);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  // After every draw (a fold opened or closed) and on resize: the list's end lined up with a row.
  const spacer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = () => endOnRow(spacer.current);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });

  // The arrow keys, Home and End move between the rows.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = [...ref.current?.querySelectorAll<HTMLElement>("[data-panel-row]") ?? []];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1
      : e.key === "ArrowDown" ? (at + 1) % rows.length : (at <= 0 ? rows.length : at) - 1;
    rows[next].focus();
  };

  const summary = [
    model.active ? t("cards.panel.activeCount", { count: model.active }) : t("cards.panel.idle"),
    ...(model.routines ? [model.routines === 1 ? t("cards.panel.routinesOne") : t("cards.panel.routinesMany", { count: model.routines })] : []),
  ].join(" · ");
  const soleRoutines = model.sections.length === 1 && !model.sections[0].active.length;

  const body: ReactNode = <>
    <div className={`flex shrink-0 items-start gap-1 border-b border-border ps-3 pe-1.5 pb-2 ${phone ? "pt-4" : "pt-2"}`}>
      {phone && <div aria-hidden="true" className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-border-bright" />}
      <div className="min-w-0 flex-1 pt-0.5">
        <h2 id={titleId} className="m-0 text-sm font-semibold text-text-primary">{t("cards.panel.title")}</h2>
        <p data-testid="chat-tasks-summary" className="m-0 truncate text-xs text-text-muted">{summary}</p>
      </div>
      <button type="button" data-testid="chat-tasks-info" aria-expanded={info} onClick={() => setInfo(!info)} aria-label={t("common.moreInfo")} title={t("common.moreInfo")}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-muted hover:text-accent hover:bg-surface-hover cursor-pointer aria-expanded:text-accent">
        <svg {...icon} width={15} height={15}><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
      </button>
      <button type="button" data-testid="chat-tasks-close" onClick={onClose} aria-label={t("cards.panel.close")} title={t("cards.panel.close")}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-hover cursor-pointer">
        <svg {...icon} width={16} height={16}><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    {info && <p data-testid="chat-tasks-info-text" className="m-0 shrink-0 border-b border-border px-3 py-2 text-xs leading-relaxed text-text-secondary">{t("cards.panel.info")}</p>}
    {/* `relative`: the rows' screen-reader words (sr-only, absolute) are placed and clipped in the list. Placed by the
        panel instead, those far down the list made the panel itself taller than its box, and a row scrolled into view
        (a click, a focus) scrolled the panel: its header went out of sight, a blank under the list. */}
    <div data-testid="chat-tasks-scroll"
      className={`relative min-h-0 flex-1 snap-y snap-proximity overflow-y-auto overscroll-contain ${nameOf || finishedOpen ? UNDER_STICKY : ""} ${phone ? "pb-safe" : "pb-1"}`}>
      {!model.sections.length && <p data-testid="chat-tasks-empty" className="m-0 px-3 py-3 text-center text-xs text-text-muted">{t("cards.panel.empty")}</p>}
      {model.sections.map((section, i) => (
        <section key={section.author} data-testid={nameOf ? "chat-tasks-sender" : undefined} data-author={nameOf ? section.author : undefined}
          aria-label={nameOf ? nameOf(section.author) : undefined} className={i > 0 ? "border-t border-border" : ""}>
          {nameOf && (
            <h3 className={`${STICKY} m-0 flex items-center gap-2 px-3 pt-1 text-[11px] font-normal text-text-muted`}>
              <bdi data-testid="chat-tasks-sender-name" className="min-w-0 truncate font-semibold text-text-secondary">{nameOf(section.author)}</bdi>
              {section.active.length > 0 && <span data-testid="chat-tasks-sender-count" className="shrink-0">{t("cards.panel.activeCount", { count: section.active.length })}</span>}
            </h3>
          )}
          {section.active.length > 0 && (
            <div data-testid="chat-tasks-active" className={nameOf ? "" : "pt-1"}>
              {section.active.map((entry) => <TaskRow key={`${entry.card.kind}\n${entry.card.id}`} entry={entry} onOpen={() => onJump(entry)} />)}
            </div>
          )}
          {section.routines.length > 0 && <Routines entries={section.routines} startOpen={soleRoutines} onOpen={onJump} />}
        </section>
      ))}
      {model.finished.length > 0 && (
        <div data-testid="chat-tasks-finished" data-open={finishedOpen ? "" : undefined} className={model.sections.length ? "border-t border-border" : ""}>
          <button type="button" data-panel-row data-testid="chat-tasks-finished-toggle" aria-expanded={finishedOpen}
            onClick={(e) => { opening(finishedOpen, e.currentTarget); setFinishedOpen(!finishedOpen); }}
            className={`${rowClass} !flex-row items-center gap-2 text-xs font-medium text-text-secondary ${finishedOpen ? `${STICKY} !py-0 max-md:!min-h-0` : ""}`}>
            <span className="min-w-0 flex-1 truncate">{t("cards.panel.finishedCount", { count: model.finished.length })}</span>
            <Chevron open={finishedOpen} />
          </button>
          {finishedOpen && model.finished.map((entry) => (
            <TaskRow key={`${entry.author}\n${entry.card.kind}\n${entry.card.id}`} entry={entry} from={nameOf?.(entry.author)} onOpen={() => onJump(entry)} />
          ))}
        </div>
      )}
      <div ref={spacer} aria-hidden="true" data-testid="chat-tasks-spacer" />
    </div>
  </>;

  const common = { ref, role: "dialog", "aria-modal": true, "aria-labelledby": titleId, tabIndex: -1, "data-testid": "chat-tasks-panel", onKeyDown: keys } as const;
  if (phone) return createPortal(<>
    <div aria-hidden="true" data-testid="chat-tasks-backdrop" className="fixed inset-0 z-50 bg-black/40 animate-fade-in" />
    <div {...common} data-layout="sheet"
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[calc(100dvh-2.5rem)] flex-col rounded-t-2xl border-t border-border bg-surface-alt shadow-2xl outline-none animate-fade-in">
      {body}
    </div>
  </>, document.body);
  return createPortal(
    <div {...common} data-layout="popover"
      style={place ? { left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight } : { visibility: "hidden" }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-alt shadow-lg outline-none animate-fade-in">
      {body}
    </div>, document.body);
}

/**
 * `nameOf`: in a group, the name of each card's sender. The panel is then one section per sender (a bot each, in a
 * group like "Sala de Máquinas"), those with the most tasks going first, each saying how many it has going.
 */
export function TasksButton({ rows, nameOf }: { rows: readonly CardRow[]; nameOf?: (author: string) => string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entries = useMemo(() => cardEntries(rows), [rows]);
  if (!entries.length) return null;
  const active = activeTaskCount(entries);
  const close = () => {
    // Back to the button, unless a tap outside put the focus somewhere else.
    const at = document.activeElement;
    setOpen(false);
    if (!at || at === document.body || at.closest("[data-testid=chat-tasks-panel]")) button.current?.focus({ preventScroll: true });
  };
  const jump = ({ messageId }: CardEntry) => {
    setOpen(false);
    const land = () => {
      if (!jumpToMessage(messageId)) return false;
      const row = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((el) => el.dataset.messageId === messageId);
      row?.querySelector<HTMLElement>("[data-testid=status-card-toggle]")?.focus({ preventScroll: true });
      return true;
    };
    // Its row may not be in the page in a long chat (useRowWindow): the rows around it first, then go.
    if (!land() && revealMessage(messageId)) requestAnimationFrame(land);
  };
  const label = active ? t("cards.panel.buttonCount", { count: active }) : t("cards.panel.button");
  return (
    <div className="relative" ref={ref}>
      <button ref={button} type="button" data-testid="chat-tasks" onClick={() => (open ? close() : setOpen(true))} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label}
        className="relative p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer">
        <svg {...icon}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" /></svg>
        {active > 0 && (
          <span data-testid="chat-tasks-count" aria-hidden="true"
            className="absolute top-0.5 end-0.5 min-w-4 h-4 px-1 rounded-full bg-accent text-on-accent text-[10px] font-bold leading-4 text-center">{active > 99 ? "99+" : active}</span>
        )}
      </button>
      {open && <TasksPanel entries={entries} nameOf={nameOf} anchorRef={ref} onClose={close} onJump={jump} />}
    </div>
  );
}
