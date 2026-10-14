import type { CardIndexRow } from "@ghostly/browser/shared/types";
import { boardEntries } from "./taskBoard";

/*
 * Whether a bot is working now (WISP 405 § Showing a card), read from its task cards: a small mark on its chat's row.
 * Working while one of the contact's tasks is running and was updated lately; stale once its running tasks have all
 * gone quiet (the bot may have stopped without saying so); nothing when no task of its is running.
 */

/** A running task not updated for longer than this is stale: the mark turns muted. */
export const WORKING_FRESH_MS = 15 * 60_000;

export type WorkingState = "working" | "stale";

/** A chat's running tasks: the one updated last (its title, its step and when), and how many there are. */
export interface WorkingEntry { title: string; step?: string; at: number; count: number }

/**
 * The running tasks of each 1:1 chat, by the chat's id; a chat with none is not in it. The newest message of a card
 * stands for it, as on the Tasks board. My own cards (I may be the bot) and a group's are left out: the mark is a
 * contact's.
 */
export function workingByChat(rows: readonly CardIndexRow[]): Map<string, WorkingEntry> {
  const by = new Map<string, WorkingEntry>();
  // Most recently changed first: the first running task of a chat is its newest.
  for (const { linkId, author, card, at } of boardEntries(rows)) {
    if (card.kind !== "task" || card.status !== "running" || author !== "peer" || linkId.startsWith("group:")) continue;
    const was = by.get(linkId);
    if (was) was.count++;
    else by.set(linkId, { title: card.title, ...(card.step && { step: card.step }), at, count: 1 });
  }
  return by;
}

/** How long ago the newest running task was updated; never negative, whatever the sender's clock says. */
export const workingQuietMs = (entry: WorkingEntry, now: number): number => Math.max(0, now - entry.at);

/** Working while the newest running task was updated in the last `WORKING_FRESH_MS`, else stale. */
export const workingState = (entry: WorkingEntry, now: number): WorkingState => workingQuietMs(entry, now) > WORKING_FRESH_MS ? "stale" : "working";
