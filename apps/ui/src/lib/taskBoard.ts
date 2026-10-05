import { ACTIVE_TASK_STATUSES, taskProgress, type RoutineCard, type TaskCard, type TaskStatus } from "@ghostly/core";
import type { CardIndexRow } from "@ghostly/browser/shared/types";
import type { Translate } from "../contexts/I18nContext";
import { foldText } from "./chatSearch";

/*
 * The Tasks board (WISP 405 · Status Cards § The Tasks board): every task card of the profile, from all its chats and
 * groups, in columns by status. This is its pure part: which message stands for a card, which column a task is in,
 * what the filter keeps and how the board is grouped. The rows come from the engine's card index (`statusCardIndex`),
 * never from the chats' histories; `useTaskBoard` gives them names and faces.
 */

/** A card on the board: the newest message of one card (per chat, author, kind and id). */
export interface BoardEntry<C extends TaskCard | RoutineCard = TaskCard | RoutineCard> {
  /** Stable for the card across its updates: its chat, author, kind and id. */
  key: string;
  /** The chat's id, or `group:<id>`. */
  linkId: string;
  messageId: string;
  card: C;
  /** Who sent it: `me`, `peer` (a 1:1 chat's contact), or a group member's key. */
  author: string;
  /** When it last changed: its last edit, else when it was sent. */
  at: number;
}

const authorOf = (row: Pick<CardIndexRow, "sender" | "member">) => row.member ?? row.sender;

/**
 * The cards of these rows, one entry each: the newest message of a card (per chat, author, kind and id) stands for it,
 * as in a chat's Tasks panel. Rows of a chat that is not in `chats` (deleted since the rows were read) are left out;
 * without `chats`, every row counts. Most recently changed first.
 */
export function boardEntries(rows: readonly CardIndexRow[], chats?: ReadonlySet<string>): BoardEntry[] {
  const latest = new Map<string, BoardEntry & { sent: number }>();
  for (const row of rows) {
    if (chats && !chats.has(row.linkId)) continue;
    if (row.card.kind !== "task" && row.card.kind !== "routine") continue;
    const author = authorOf(row);
    const key = `${row.linkId}\n${author}\n${row.card.kind}\n${row.card.id}`;
    const was = latest.get(key);
    // The newest message, whatever order the rows came in: a later one of the same time wins, as in a chat.
    if (was && was.sent > row.timestamp) continue;
    latest.set(key, { key, linkId: row.linkId, messageId: row.id, card: row.card, author, at: row.editedAt ?? row.timestamp, sent: row.timestamp });
  }
  return [...latest.values()].map(({ sent: _sent, ...entry }) => entry).sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
}

/**
 * The board's columns, in order. Failed and cancelled tasks share the last one: both are over without being done.
 * Review is not a status: it is where a task waits while its pull request is open, and the column is there only once
 * some task says where its pull request stands (`pr.state`).
 */
export const BOARD_COLUMNS = ["queued", "running", "blocked", "review", "done", "closed"] as const;
export type BoardColumn = typeof BOARD_COLUMNS[number];

/**
 * Which column a task is in: its status, with two exceptions. Failed and cancelled share Stopped. A task queued or
 * running whose pull request is open (ready for review) is in Review; a blocked one stays in Blocked, where it is
 * seen, and a merged pull request moves nothing: the task is done when its bot says so.
 */
export function columnOf(card: Pick<TaskCard, "status" | "pr">): BoardColumn {
  if (card.status === "failed" || card.status === "cancelled") return "closed";
  if ((card.status === "running" || card.status === "queued") && card.pr?.state === "open") return "review";
  return card.status;
}

/** A finished task stays on the board this long after its last update; older ones wait behind "Show older". */
export const RECENT_MS = 24 * 60 * 60_000;
/** Cards drawn per column before "Show more", and how many more each press brings. */
export const COLUMN_PAGE = 50;

/** A task as the board shows it: its entry, with who sent it and where, by name. */
export interface BoardTask extends BoardEntry<TaskCard> {
  /** The sender, unique across chats: the contact's or member's key (`me` for my own). */
  botKey: string;
  bot: string;
  chat: string;
  /** The tasks that name this one as their parent, stacked under it (`stackTasks`), going first. */
  parts?: BoardTask[];
}
export interface BoardRoutine extends BoardEntry<RoutineCard> { botKey: string; bot: string; chat: string }

export const isActiveTask = (card: TaskCard) => ACTIVE_TASK_STATUSES.includes(card.status);

export type BoardGrouping = "status" | "bot" | "chat";

/** One column of the board. Grouped by status its id is a `BoardColumn`; by bot or chat, that bot's key or chat's id. */
export interface BoardGroup {
  id: string;
  /** The bot's or the chat's name; absent for a status column, whose name the page translates. */
  label?: string;
  tasks: BoardTask[];
  /** Tasks still going in it. */
  active: number;
  /** Its finished tasks last changed more than a day ago: left out of `tasks` until "Show older", in it after. */
  old: number;
}

/** What the text filter reads of a task, folded as the app's searches fold (case and accents). */
function haystack(task: BoardTask, statusWord: (status: TaskStatus) => string): string {
  const { card } = task;
  return foldText([card.title, task.bot, task.chat, card.step, card.branch, statusWord(card.status), card.id, ...(card.tags ?? []),
    ...(card.pr?.number !== undefined ? [`#${card.pr.number}`, `pr ${card.pr.number}`] : [])].filter(Boolean).join("\n"));
}

/** Within a column that mixes statuses (grouped by bot or chat): going first, then done, then failed and cancelled. */
const STATUS_RANK: Record<TaskStatus, number> = { running: 0, blocked: 1, queued: 2, done: 3, failed: 4, cancelled: 5 };

/**
 * The tasks with each one's parts stacked under it: a task that names a parent (`parent`: the id of another task of
 * the same sender in the same chat) goes under that task instead of standing in a column of its own. Parts of a part
 * go under the top task too: one level, however deep the bot nests. A parent that is not there (not sent, deleted, in
 * another chat, from someone else) leaves its parts as tasks of their own, and so does a ring of parents.
 */
export function stackTasks(tasks: readonly BoardTask[]): BoardTask[] {
  const scope = (task: BoardTask, id: string) => `${task.linkId}\n${task.author}\n${id}`;
  const byId = new Map(tasks.map((task) => [scope(task, task.card.id), task]));
  /** The top task above this one, or undefined when it has none (no parent, a missing one, a ring). */
  const top = (task: BoardTask): BoardTask | undefined => {
    const seen = new Set([task]);
    let at = task, up: BoardTask | undefined;
    while (at.card.parent && (up = byId.get(scope(at, at.card.parent)))) {
      if (seen.has(up)) return undefined;
      seen.add(up);
      at = up;
    }
    // The highest parent that is there: one above it that is not leaves that one standing alone, its parts under it.
    return at === task ? undefined : at;
  };
  const parts = new Map<BoardTask, BoardTask[]>();
  const roots: BoardTask[] = [];
  for (const task of tasks) {
    const above = top(task);
    if (above) parts.set(above, [...(parts.get(above) ?? []), task]);
    else roots.push(task);
  }
  return roots.map((root) => {
    const under = parts.get(root);
    return under ? { ...root, parts: under.sort((a, b) => STATUS_RANK[a.card.status] - STATUS_RANK[b.card.status] || b.at - a.at) } : root;
  });
}

/** A parent's summary: how many of its parts are done, of how many. */
export function partsDone(task: Pick<BoardTask, "parts">): { done: number; total: number } | undefined {
  return task.parts?.length ? { done: task.parts.filter((part) => part.card.status === "done").length, total: task.parts.length } : undefined;
}

/** Every tag on these tasks, the most used first (then by name): what the board offers to filter by. */
export function boardTags(tasks: readonly BoardTask[]): string[] {
  const count = new Map<string, number>();
  for (const task of tasks) for (const tag of task.card.tags ?? []) count.set(tag, (count.get(tag) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

export interface BoardOptions {
  grouping?: BoardGrouping;
  /** The text filter, as typed. */
  filter?: string;
  /** Only tasks with this tag (a parent stays when one of its parts has it). */
  tag?: string;
  now?: number;
  /** Finished tasks older than a day too. */
  older?: boolean;
  /** A status in the interface's language, so the filter finds "running" as the person reads it. */
  statusWord?: (status: TaskStatus) => string;
}

export interface BoardModel {
  /** Tasks still going, of every task the profile has (the header's line): the filter does not change it. */
  active: number;
  /** Every task, before the filter. */
  total: number;
  /** Cards the filters keep (a task with its parts under it is one). */
  shown: number;
  groups: BoardGroup[];
  /** The tags to filter by, the most used first. */
  tags: string[];
}

/**
 * The board, column by column. By status: the five columns, always (and Review among them once a task says where its
 * pull request stands), each with its tasks most recently changed first. A task's parts are stacked under it, not in
 * columns of their own; the filters keep a task when it or one of its parts matches.
 * By bot or by chat: a column per bot or chat that has a task, those with more going first, their tasks going first.
 * A finished task (done, failed, cancelled) last changed more than a day ago is counted in `old` and left out,
 * unless `older` asks for them.
 */
export function boardModel(tasks: readonly BoardTask[], { grouping = "status", filter = "", tag, now = Date.now(), older = false, statusWord = (s) => s }: BoardOptions = {}): BoardModel {
  const q = foldText(filter.trim());
  const whole = (task: BoardTask) => [task, ...(task.parts ?? [])];
  const matches = (task: BoardTask) => (!q || haystack(task, statusWord).includes(q)) && (!tag || !!task.card.tags?.includes(tag));
  const kept = stackTasks(tasks).filter((task) => whole(task).some(matches));
  // A finished task is old by the last change of it or of its parts, and never while a part is still going.
  const old = (task: BoardTask) => whole(task).every((t) => !isActiveTask(t.card)) && now - Math.max(...whole(task).map((t) => t.at)) > RECENT_MS;
  const group = (id: string, list: BoardTask[], label?: string): BoardGroup => {
    const recent = list.filter((task) => !old(task));
    const shown = older ? list : recent;
    return { id, ...(label !== undefined && { label }), tasks: shown, active: shown.flatMap(whole).filter((task) => isActiveTask(task.card)).length, old: list.length - recent.length };
  };
  let groups: BoardGroup[];
  if (grouping === "status") {
    const review = tasks.some((task) => task.card.pr?.state !== undefined);
    groups = BOARD_COLUMNS.filter((column) => column !== "review" || review)
      .map((column) => group(column, kept.filter((task) => columnOf(task.card) === column).sort((a, b) => b.at - a.at)));
  } else {
    const by = new Map<string, { label: string; list: BoardTask[] }>();
    for (const task of kept) {
      const id = grouping === "bot" ? task.botKey : task.linkId;
      const at = by.get(id) ?? { label: grouping === "bot" ? task.bot : task.chat, list: [] };
      at.list.push(task);
      by.set(id, at);
    }
    groups = [...by].map(([id, { label, list }]) => group(id, list.sort((a, b) => STATUS_RANK[a.card.status] - STATUS_RANK[b.card.status] || b.at - a.at), label))
      // A bot or chat with only old finished tasks keeps its column (its "Show older" is there), after the others.
      .sort((a, b) => b.active - a.active || b.tasks.length - a.tasks.length || (b.tasks[0]?.at ?? 0) - (a.tasks[0]?.at ?? 0) || (a.label ?? "").localeCompare(b.label ?? ""));
  }
  return { active: tasks.filter((task) => isActiveTask(task.card)).length, total: tasks.length, shown: kept.length, groups, tags: boardTags(tasks) };
}

/** "2 of 5" for a task that counts its steps, "40%" for one that gives a percent; undefined when it says neither. */
export function progressWords(card: TaskCard): { done: number; total: number } | { percent: number } | undefined {
  if (card.done !== undefined && card.total) return { done: card.done, total: card.total };
  const percent = taskProgress(card);
  return percent === undefined ? undefined : { percent };
}

/** "2 of 5", "40%", or nothing: a task's progress in words. */
export function progressText(t: Translate, task: Pick<BoardTask, "card">): string | undefined {
  const words = progressWords(task.card);
  if (!words) return undefined;
  return "percent" in words ? `${words.percent}%` : t("cards.board.card.steps", { done: words.done, total: words.total });
}

/** What a screen reader says of a card: its title, status, progress, sender and chat, pull request, and age. */
export function boardCardLabel(t: Translate, task: BoardTask, age: string): string {
  const { card } = task;
  const from = task.botKey === "me" || task.bot === task.chat ? t("cards.board.card.in", { chat: task.chat }) : t("cards.board.card.from", { bot: task.bot, chat: task.chat });
  const parts = partsDone(task);
  return [card.title, t(`cards.task.status.${card.status}`), progressText(t, task), parts && t("cards.board.card.parts", parts), from,
    card.pr && (card.pr.number !== undefined ? t("cards.task.pr", { number: card.pr.number }) : t("cards.task.prNoNumber")),
    card.pr?.state && t(`cards.board.card.prState.${card.pr.state}`), card.pr?.checks && t(`cards.board.card.checks.${card.pr.checks}`),
    ...(card.tags ?? []), t("cards.task.updated", { ago: age })].filter(Boolean).join(", ");
}

/**
 * Where an arrow key takes the focus on the board: up and down within a column (stopping at its ends), left and right
 * to the nearest column that has a card, at the same place down it or its last card; Home and End to a column's first
 * and last card. `columns`: how many cards each column shows. Undefined when there is nowhere to go.
 */
export function boardMove(columns: readonly number[], at: { column: number; row: number }, key: string, rtl = false): { column: number; row: number } | undefined {
  const rows = columns[at.column] ?? 0;
  if (key === "ArrowDown") return at.row + 1 < rows ? { column: at.column, row: at.row + 1 } : undefined;
  if (key === "ArrowUp") return at.row > 0 ? { column: at.column, row: at.row - 1 } : undefined;
  if (key === "Home") return rows && at.row !== 0 ? { column: at.column, row: 0 } : undefined;
  if (key === "End") return rows && at.row !== rows - 1 ? { column: at.column, row: rows - 1 } : undefined;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;
  const step = (key === "ArrowRight") !== rtl ? 1 : -1;
  for (let column = at.column + step; column >= 0 && column < columns.length; column += step) {
    if (columns[column] > 0) return { column, row: Math.min(at.row, columns[column] - 1) };
  }
  return undefined;
}
