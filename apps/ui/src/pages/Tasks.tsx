import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TaskStatus } from "@ghostly/core";
import { PageHeader } from "../components/layout";
import { MemberFace } from "../components/chat/SenderAvatar";
import { BoardCard } from "../components/tasks/BoardCard";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useIsMobile } from "../hooks/useIsMobile";
import { JUMP_TO } from "../hooks/useJumpTo";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { useTaskBoard, type TaskBoardData } from "../hooks/useTaskBoard";
import { RESULT_TONE, sortRoutines, untilIn } from "../lib/statusCards";
import { COLUMN_PAGE, boardModel, boardMove, type BoardColumn, type BoardEntry, type BoardGroup, type BoardGrouping, type BoardRoutine } from "../lib/taskBoard";

/*
 * The Tasks board (WISP 405 · Status Cards § The Tasks board): every task card of this profile, from all its chats and
 * groups, in one place. Columns by status (Queued, Running, Blocked, Done, Stopped: failed and cancelled together), or
 * a column per bot or per chat; a text filter; routines on their own tab, a line each. A phone shows one column at a
 * time, under tabs with each column's count, and a swipe moves between them. Cards are display only: nothing here
 * changes a task, and a card opens its chat on its message.
 */

const GROUPINGS: readonly BoardGrouping[] = ["status", "bot", "chat"];
const icon = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** A column's dot, by status: the tones the cards themselves use. */
const COLUMN_DOT: Record<BoardColumn, string> = { queued: "bg-text-muted", running: "bg-accent", blocked: "bg-amber-500", review: "bg-link", done: "bg-success", closed: "bg-danger" };

function Column({ group, name, dot, grouping, board, now, older, onOlder, onOpen, onTag, phone, labelledBy }: {
  group: BoardGroup; name: string; dot?: string; grouping: BoardGrouping; board: TaskBoardData; now: number; onTag: (tag: string) => void;
  older: boolean; onOlder: () => void; onOpen: (entry: BoardEntry) => void; phone: boolean; labelledBy?: string;
}) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(COLUMN_PAGE);
  const titleId = useId();
  const shown = group.tasks.slice(0, limit);
  const rest = group.tasks.length - shown.length;

  // The arrow keys move between cards and columns; Home and End to a column's ends.
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const columns = [...event.currentTarget.closest("[data-testid=tasks-board]")?.querySelectorAll<HTMLElement>("[data-board-column]") ?? []];
    const cards = columns.map((column) => [...column.querySelectorAll<HTMLElement>("[data-board-card]")]);
    const column = cards.findIndex((list) => list.includes(event.currentTarget));
    if (column < 0) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const to = boardMove(cards.map((list) => list.length), { column, row: cards[column].indexOf(event.currentTarget) }, event.key, rtl);
    if (!to) return;
    const target = cards[to.column][to.row];
    target.focus();
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  return (
    <section data-testid="board-column" data-board-column data-column={group.id} aria-labelledby={labelledBy ?? titleId}
      {...(phone ? { role: "tabpanel", id: `${labelledBy}-panel` } : {})}
      className={phone ? "flex h-full w-full shrink-0 snap-start flex-col min-h-0" : "flex max-h-full min-w-64 max-w-96 flex-1 basis-64 flex-col rounded-xl bg-text-primary/[0.04]"}>
      {!phone && (
        <h2 id={titleId} className="m-0 flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-1.5 text-xs font-semibold text-text-secondary">
          {dot && <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
          <bdi className="min-w-0 truncate">{name}</bdi>
          <span data-testid="board-column-count" className="shrink-0 font-normal tabular-nums text-text-muted">{group.tasks.length}</span>
        </h2>
      )}
      <div data-testid="board-column-cards" className={`flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain ${phone ? "px-3 pt-2 pb-4" : "px-1.5 pb-1.5"}`}>
        {shown.map((task) => (
          <BoardCard key={task.key} task={task} grouping={grouping} face={board.faceOf(task)} now={now} onOpen={() => onOpen(task)} onOpenPart={onOpen} onKeys={keys} onTag={onTag} />
        ))}
        {!group.tasks.length && <p data-testid="board-column-empty" className="m-0 px-2 py-3 text-center text-xs text-text-muted">{t("cards.board.none")}</p>}
        {rest > 0 && (
          <button type="button" data-testid="board-column-more" onClick={() => setLimit(limit + COLUMN_PAGE)}
            className="shrink-0 cursor-pointer rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11">
            {t("cards.board.showMore", { count: rest })}
          </button>
        )}
        {group.old > 0 && (
          <button type="button" data-testid="board-column-older" aria-pressed={older} onClick={onOlder}
            className="shrink-0 cursor-pointer rounded-lg px-2 py-1.5 text-xs text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11">
            {older ? t("cards.board.hideOlder") : t("cards.board.showOlder", { count: group.old })}
          </button>
        )}
      </div>
    </section>
  );
}

/** A routine on one line: ↻, its name, whose it is and where, when it runs next (or that it is paused), its last run's mark. */
function RoutineLine({ routine, board, onOpen }: { routine: BoardRoutine; board: TaskBoardData; onOpen: () => void }) {
  const { t, language } = useI18n();
  const { card } = routine;
  const last = card.lastRun;
  const paused = card.state === "paused";
  const face = board.faceOf(routine);
  const where = routine.botKey === "me" || routine.bot === routine.chat ? routine.chat : t("cards.board.card.from", { bot: routine.bot, chat: routine.chat });
  return (
    <li className="m-0 list-none">
      <button type="button" data-testid="board-routine" data-card-id={card.id} data-state={card.state} onClick={onOpen} title={`${card.name} · ${card.schedule}`}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-start hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-md:min-h-11">
        <span aria-hidden="true" className={`w-3 shrink-0 text-center text-[13px] leading-none ${paused ? "text-text-muted" : "text-accent"}`}>↻</span>
        <bdi className="min-w-0 shrink truncate text-sm text-text-primary">{card.name}</bdi>
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs text-text-muted">
          {face && <MemberFace face={face} size={14} />}
          <bdi className="min-w-0 truncate">{where}</bdi>
        </span>
        <span className="shrink-0 text-xs text-text-muted">{paused ? t("cards.routine.state.paused") : card.nextRunAt ? untilIn(language)(card.nextRunAt) : card.schedule}</span>
        <span className={`w-3 shrink-0 text-center text-xs font-semibold ${last ? RESULT_TONE[last.result].label : "text-text-muted"}`}>
          <span aria-hidden="true">{last ? RESULT_TONE[last.result].mark : ""}</span>
          <span className="sr-only">{last ? t("cards.routine.lastRun", { result: t(`cards.routine.result.${last.result}`) }) : t("cards.routine.noRuns")}</span>
        </span>
      </button>
    </li>
  );
}

export function Tasks() {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const phone = useIsMobile();
  const board = useTaskBoard();
  const [view, setView] = useState<"tasks" | "routines">("tasks");
  const [grouping, setGrouping] = useState<BoardGrouping>("status");
  const [filter, setFilter] = useState("");
  const [older, setOlder] = useState(false);
  const [tag, setTag] = useState<string>();
  const [info, setInfo] = useState(false);
  const [tab, setTab] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const tabsId = useId();
  const now = useMinuteClock(pageRef);

  const statusWord = (status: TaskStatus) => t(`cards.task.status.${status}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `statusWord` follows `t`
  const model = useMemo(() => boardModel(board.tasks, { grouping, filter, tag, now, older, statusWord }), [board.tasks, grouping, filter, tag, now, older, t]);
  const routines = useMemo(() => sortRoutines(board.routines), [board.routines]);
  const nameOf = (group: BoardGroup) => group.label ?? t(`cards.board.column.${group.id as BoardColumn}`);
  const showing = routines.length && (view === "routines" || !board.tasks.length) ? "routines" : "tasks";
  const at = Math.min(tab, Math.max(0, model.groups.length - 1));

  const open = (entry: BoardEntry) => {
    const path = board.pathOf(entry.linkId);
    if (path) nav.conversation(path, { [JUMP_TO]: entry.messageId });
  };

  // A phone: the column on screen is the chosen tab's; a swipe to another column chooses its tab.
  const toTab = (index: number, smooth = true) => {
    setTab(index);
    const scroller = boardRef.current;
    const column = scroller?.querySelectorAll<HTMLElement>("[data-board-column]")[index];
    if (scroller && column) scroller.scrollTo?.({ left: column.offsetLeft - scroller.offsetLeft, behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  };
  useEffect(() => {
    const scroller = boardRef.current;
    if (!phone || !scroller) return;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = scroller.clientWidth;
        if (width) setTab(Math.round(Math.abs(scroller.scrollLeft) / width));
      });
    };
    scroller.addEventListener("scroll", settle, { passive: true });
    return () => { cancelAnimationFrame(frame); scroller.removeEventListener("scroll", settle); };
  }, [phone, showing]);
  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const last = model.groups.length - 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? last : Math.max(0, Math.min(last, at + ((event.key === "ArrowRight") !== rtl ? 1 : -1)));
    toTab(next);
    event.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  };

  const empty = !board.tasks.length && !routines.length;
  const summary = [
    model.active ? t("cards.panel.activeCount", { count: model.active }) : t("cards.panel.idle"),
    model.total === 1 ? t("cards.board.tasksOne") : t("cards.board.tasksMany", { count: model.total }),
  ].join(" · ");
  const pill = (on: boolean) => `cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-9 ${on ? "bg-accent text-on-accent" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"}`;

  return (
    <div ref={pageRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-chat-bg" data-testid="tasks-page">
      <PageHeader title={t("cards.board.title")} trailing={
        <button type="button" data-testid="tasks-info" aria-expanded={info} onClick={() => setInfo(!info)} aria-label={t("common.moreInfo")} title={t("common.moreInfo")}
          className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted hover:bg-surface-hover hover:text-accent aria-expanded:text-accent">
          <svg {...icon} width={18} height={18}><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
        </button>} />
      {info && <p data-testid="tasks-info-text" className="m-0 shrink-0 border-b border-border bg-panel-header px-4 py-2 text-xs leading-relaxed text-text-secondary">{t("cards.board.info")}</p>}

      {empty ? (
        <div data-testid="tasks-empty" className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <svg {...icon} width={40} height={40} strokeWidth={1.5} className="mb-2 text-text-muted"><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" /></svg>
          <p className="m-0 text-sm text-text-secondary">{t("cards.board.empty")}</p>
          <p className="m-0 text-xs text-text-muted">{t("cards.board.emptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
            <p data-testid="tasks-summary" className="m-0 text-xs text-text-secondary">{summary}</p>
            {routines.length > 0 && board.tasks.length > 0 && (
              <div role="group" aria-label={t("cards.board.view.label")} className="flex items-center gap-1">
                <button type="button" data-testid="tasks-view-tasks" aria-pressed={showing === "tasks"} onClick={() => setView("tasks")} className={pill(showing === "tasks")}>{t("cards.board.view.tasks")} <span className="tabular-nums opacity-80">{model.total}</span></button>
                <button type="button" data-testid="tasks-view-routines" aria-pressed={showing === "routines"} onClick={() => setView("routines")} className={pill(showing === "routines")}>{t("cards.board.view.routines")} <span className="tabular-nums opacity-80">{routines.length}</span></button>
              </div>
            )}
            {showing === "tasks" && (
              <>
                <div role="radiogroup" aria-label={t("cards.board.groupBy.label")} className="flex items-center gap-1">
                  <span aria-hidden="true" className="text-xs text-text-muted">{t("cards.board.groupBy.label")}</span>
                  {GROUPINGS.map((g) => (
                    <button key={g} type="button" role="radio" aria-checked={grouping === g} data-testid={`tasks-group-${g}`} onClick={() => { setGrouping(g); toTab(0, false); }} className={pill(grouping === g)}>
                      {t(`cards.board.groupBy.${g}`)}
                    </button>
                  ))}
                </div>
                <label className="ms-auto flex min-w-36 flex-1 items-center gap-2 rounded-lg bg-search-bg px-2.5 py-1 md:max-w-64">
                  <svg {...icon} width={14} height={14} className="shrink-0 text-text-muted"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
                  <input type="search" data-testid="tasks-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("cards.board.filter")} aria-label={t("cards.board.filter")}
                    className="min-w-0 flex-1 border-none bg-transparent py-0.5 text-sm text-text-primary placeholder-text-muted focus:outline-none" />
                </label>
              </>
            )}
          </div>

          {showing === "routines" ? (
            <ul data-testid="tasks-routines" aria-label={t("cards.board.view.routines")} className="m-0 flex-1 overflow-y-auto p-2">
              {routines.map((routine) => <RoutineLine key={routine.key} routine={routine} board={board} onOpen={() => open(routine)} />)}
            </ul>
          ) : (
            <>
              {model.tags.length > 0 && (
                <div role="group" aria-label={t("cards.board.tags")} data-testid="tasks-tags" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 py-1.5 [scrollbar-width:none]">
                  <span aria-hidden="true" className="shrink-0 text-xs text-text-muted">{t("cards.board.tags")}</span>
                  {model.tags.map((name) => (
                    <button key={name} type="button" data-testid="tasks-tag" aria-pressed={tag === name} onClick={() => setTag(tag === name ? undefined : name)} className={`${pill(tag === name)} max-w-40 shrink-0 truncate`}>
                      <bdi>{name}</bdi>
                    </button>
                  ))}
                </div>
              )}
              {(filter.trim() || tag) && !model.shown && <p data-testid="tasks-no-match" className="m-0 shrink-0 px-4 pt-3 text-center text-xs text-text-muted">{t("cards.board.noMatch")}</p>}
              {phone && (
                <div role="tablist" aria-label={t("cards.board.columns")} data-testid="tasks-tabs" onKeyDown={tabKeys}
                  className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5 [scrollbar-width:none]">
                  {model.groups.map((group, i) => (
                    <button key={group.id} type="button" role="tab" id={`${tabsId}-${i}`} aria-selected={i === at} aria-controls={`${tabsId}-${i}-panel`} tabIndex={i === at ? 0 : -1}
                      data-testid="tasks-tab" data-column={group.id} onClick={() => toTab(i)}
                      className={`flex min-h-9 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-accent ${i === at ? "bg-accent text-on-accent" : "text-text-secondary"}`}>
                      <bdi className="min-w-0 truncate">{nameOf(group)}</bdi>
                      <span data-testid="tasks-tab-count" className="tabular-nums opacity-80">{group.tasks.length}</span>
                    </button>
                  ))}
                </div>
              )}
              <div ref={boardRef} data-testid="tasks-board" data-grouping={grouping} data-layout={phone ? "tabs" : "columns"}
                className={phone ? "flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]" : "flex min-h-0 flex-1 items-start gap-3 overflow-x-auto p-3"}>
                {model.groups.map((group, i) => (
                  <Column key={group.id} group={group} name={nameOf(group)} dot={grouping === "status" ? COLUMN_DOT[group.id as BoardColumn] : undefined} grouping={grouping}
                    board={board} now={now} older={older} onOlder={() => setOlder(!older)} onOpen={open} onTag={(name) => setTag(tag === name ? undefined : name)} phone={phone} labelledBy={phone ? `${tabsId}-${i}` : undefined} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
