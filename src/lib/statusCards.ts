import { ACTIVE_TASK_STATUSES, type RoutineCard, type RunResult, type StatusCard, type TaskStatus } from "@ghostly/core";

/*
 * The status cards of a chat or group, as its Tasks panel lists them (WISP 4xx · Status Cards): the newest message of
 * each card (per author, kind and id) stands for it; per sender, its tasks still going, then its routines; the
 * finished tasks last.
 */

/** What the panel needs of a row: a 1:1 chat's and a group's messages both have it. */
export interface CardRow { id: string; card?: StatusCard; sender: string; member?: string; timestamp: number; edit?: { at: number } }

export interface CardEntry {
  messageId: string;
  card: StatusCard;
  /** Who sent it: `me`, `peer`, or a group member's key. */
  author: string;
  /** When it last changed: its last update, else when it was sent. */
  at: number;
  /** A task still going (queued, running, blocked): counted on the Tasks button. */
  active: boolean;
}

const author = (row: CardRow) => row.member ?? row.sender;

export function isActiveCard(card: StatusCard): boolean {
  return card.kind === "task" && ACTIVE_TASK_STATUSES.includes(card.status);
}

/** Every card of these rows (oldest first, as a chat keeps them), the newest message of each, in the panel's order. */
export function cardEntries(rows: readonly CardRow[]): CardEntry[] {
  const latest = new Map<string, CardEntry>();
  for (const row of rows) {
    if (!row.card) continue;
    const key = `${author(row)}\n${row.card.kind}\n${row.card.id}`;
    latest.delete(key);
    latest.set(key, { messageId: row.id, card: row.card, author: author(row), at: row.edit?.at ?? row.timestamp, active: isActiveCard(row.card) });
  }
  const rank = (e: CardEntry) => (e.card.kind === "routine" ? 2 : e.active ? 0 : 1);
  return [...latest.values()].sort((a, b) => rank(a) - rank(b) || b.at - a.at);
}

/** A group's cards, one list per sender: senders with more tasks going first, then the most recently changed. */
export function cardsBySender(entries: readonly CardEntry[]): { author: string; active: number; entries: CardEntry[] }[] {
  const by = new Map<string, CardEntry[]>();
  for (const entry of entries) by.set(entry.author, [...(by.get(entry.author) ?? []), entry]);
  const latest = (list: CardEntry[]) => Math.max(...list.map((e) => e.at));
  return [...by].map(([author, list]) => ({ author, active: activeTaskCount(list), entries: list }))
    .sort((a, b) => b.active - a.active || latest(b.entries) - latest(a.entries));
}

/** A sender's part of the Tasks panel: its tasks still going, then its routines. */
export interface PanelSection {
  /** The sender; empty in a 1:1 chat, where the panel has one section and no names. */
  author: string;
  active: CardEntry[];
  routines: CardEntry[];
}

/**
 * The Tasks panel, top to bottom: one section per sender (in a group; one without a name in a 1:1 chat), each with its
 * tasks still going and then its routines, the senders with more going first; the finished tasks of everyone after.
 */
export function panelModel(entries: readonly CardEntry[], grouped: boolean): { active: number; routines: number; sections: PanelSection[]; finished: CardEntry[] } {
  const going = entries.filter((e) => e.card.kind !== "task" || e.active);
  const senders = grouped ? cardsBySender(going) : going.length ? [{ author: "", entries: going }] : [];
  return {
    active: activeTaskCount(entries),
    routines: entries.filter((e) => e.card.kind === "routine").length,
    sections: senders.map(({ author, entries: list }) => ({
      author,
      active: list.filter((e) => e.active),
      routines: sortRoutines(list.filter((e) => e.card.kind === "routine")),
    })),
    finished: entries.filter((e) => e.card.kind === "task" && !e.active),
  };
}

/** Routines in the order the panel lists them: a failed last run first, then the next to run, the paused ones last. */
export function sortRoutines(entries: readonly CardEntry[]): CardEntry[] {
  const rank = (card: RoutineCard) => (card.state === "paused" ? 2 : card.lastRun?.result === "failed" ? 0 : 1);
  const next = (card: RoutineCard) => (card.state === "active" && card.nextRunAt) || Number.MAX_SAFE_INTEGER;
  return [...entries].sort((a, b) => {
    const x = a.card as RoutineCard, y = b.card as RoutineCard;
    return rank(x) - rank(y) || next(x) - next(y);
  });
}

/** What some routines come to, on one line: how many, the soonest next run, and how their last runs went. */
export interface RoutineSummary { count: number; next?: number; failed: number; ran: number }

export function routineSummary(cards: readonly RoutineCard[]): RoutineSummary {
  const nexts = cards.filter((c) => c.state === "active" && c.nextRunAt).map((c) => c.nextRunAt!);
  return {
    count: cards.length,
    ...(nexts.length && { next: Math.min(...nexts) }),
    failed: cards.filter((c) => c.lastRun?.result === "failed").length,
    ran: cards.filter((c) => c.lastRun).length,
  };
}

/** Routine cards in a row from one sender, from this many, fold into one row of the chat. */
export const ROUTINE_STACK_MIN = 3;

/**
 * The chat's runs of routine cards from one sender, at least `ROUTINE_STACK_MIN` in a row, by the id of each run's first
 * message: the chat draws a run as one row (`RoutineStack`). `messageOf` is a row's message, if it is one.
 */
export function routineStacks<R, M extends { id: string; card?: StatusCard; sender: string; member?: string }>(rows: readonly R[], messageOf: (row: R) => M | undefined): Map<string, M[]> {
  const stacks = new Map<string, M[]>();
  let run: M[] = [];
  const end = () => { if (run.length >= ROUTINE_STACK_MIN) stacks.set(run[0].id, run); run = []; };
  for (const row of rows) {
    const m = messageOf(row);
    if (m?.card?.kind !== "routine") { end(); continue; }
    if (run.length && (run[0].member ?? run[0].sender) !== (m.member ?? m.sender)) end();
    run.push(m);
  }
  end();
  return stacks;
}

/** How many tasks are still going: the number on the Tasks button. */
export function activeTaskCount(entries: readonly CardEntry[]): number {
  return entries.filter((e) => e.active).length;
}

/**
 * A status's dot, bar and word: the accent while it runs, success with ✓ when done, red with ✕ when it failed, amber
 * when blocked, muted while queued or once cancelled.
 */
export const STATUS_TONE: Record<TaskStatus, { dot: string; bar: string; label: string; mark?: string }> = {
  queued: { dot: "bg-text-muted", bar: "bg-text-muted", label: "text-text-primary/65" },
  running: { dot: "bg-accent", bar: "bg-accent", label: "text-accent" },
  blocked: { dot: "bg-amber-500", bar: "bg-amber-500", label: "text-amber-500" },
  done: { dot: "bg-success", bar: "bg-success", label: "text-success", mark: "✓" },
  failed: { dot: "bg-danger", bar: "bg-danger", label: "text-danger-ink", mark: "✕" },
  cancelled: { dot: "bg-text-muted", bar: "bg-text-muted", label: "text-text-primary/65" },
};

/** A task that is over: done, failed or cancelled. It no longer says what it is doing now. */
export const isFinished = (status: TaskStatus) => status === "done" || status === "failed" || status === "cancelled";

/** A routine run's dot, word and mark: green ✓ when it went well, red ✕ when it failed, muted – when it was skipped. */
export const RESULT_TONE: Record<RunResult, { dot: string; label: string; mark: string }> = {
  ok: { dot: "bg-success", label: "text-success", mark: "✓" },
  failed: { dot: "bg-danger", label: "text-danger-ink", mark: "✕" },
  skipped: { dot: "bg-text-muted", label: "text-text-primary/65", mark: "–" },
};

/** "in 3 h", "tomorrow" in the interface's language: a routine's next run from now. */
export function untilIn(language: string): (at: number, now?: number) => string {
  return (at, now = Date.now()) => {
    const d = Math.max(0, (at - now) / 1000);
    const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
    if (d < 60) return rtf.format(0, "second");
    if (d < 3600) return rtf.format(Math.round(d / 60), "minute");
    if (d < 86_400) return rtf.format(Math.round(d / 3600), "hour");
    return rtf.format(Math.round(d / 86_400), "day");
  };
}

/** Whether a message shows as its card: a kind this app draws. Anything else shows the message's text. */
export function showsCard(card: StatusCard | undefined): card is StatusCard {
  return card?.kind === "task" || card?.kind === "routine";
}
