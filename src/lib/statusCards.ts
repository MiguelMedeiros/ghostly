import { ACTIVE_TASK_STATUSES, type StatusCard, type TaskStatus } from "@ghostly/core";

/*
 * The status cards of a chat or group, as its Tasks panel lists them (WISP 4xx · Status Cards): the newest message of
 * each card (per author, kind and id) stands for it; active tasks first, then finished ones, then routines.
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

/** Whether a message shows as its card: a kind this app draws. Anything else shows the message's text. */
export function showsCard(card: StatusCard | undefined): card is StatusCard {
  return card?.kind === "task";
}
