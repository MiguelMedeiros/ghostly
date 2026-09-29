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

/** How many tasks are still going: the number on the Tasks button. */
export function activeTaskCount(entries: readonly CardEntry[]): number {
  return entries.filter((e) => e.active).length;
}

/** A status's dot and bar: the accent while it goes or when it is done, amber when blocked, red when it failed. */
export const STATUS_TONE: Record<TaskStatus, { dot: string; bar: string }> = {
  queued: { dot: "bg-text-muted", bar: "bg-text-muted" },
  running: { dot: "bg-accent", bar: "bg-accent" },
  blocked: { dot: "bg-amber-500", bar: "bg-amber-500" },
  done: { dot: "bg-accent", bar: "bg-accent" },
  failed: { dot: "bg-danger", bar: "bg-danger" },
  cancelled: { dot: "bg-text-muted", bar: "bg-text-muted" },
};

/** Whether a message shows as its card: a kind this app draws. Anything else shows the message's text. */
export function showsCard(card: StatusCard | undefined): card is StatusCard {
  return card?.kind === "task";
}
