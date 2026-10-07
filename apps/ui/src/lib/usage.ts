import { usageLeft, type UsageCard } from "@ghostly/core";
import type { CardIndexRow } from "@ghostly/browser/shared/types";
import type { Language } from "./settings";
import { formatAt } from "./time";

/*
 * A bot's usage card (WISP 405 § Usage): how much of its quota it has left, shown at a glance on its chat's row and in
 * the chat's header. One stands per chat: the latest a contact changed. Colour only when it runs low, and none once
 * the numbers are too old to trust (stale): the bot stopped saying, or the window it spoke of has started again.
 */

/** Below this percent left, the meter turns amber. */
export const USAGE_LOW = 20;
/** Below this percent left, the meter turns red. */
export const USAGE_CRITICAL = 5;
/** Numbers older than this are stale: shown muted, never coloured. */
export const USAGE_STALE_MS = 6 * 60 * 60_000;

export type UsageLevel = "ok" | "low" | "critical" | "stale";

/** A chat's usage card, with when it last changed (its update, else when it came). */
export interface UsageEntry { card: UsageCard; messageId: string; at: number }

/** When the bot read its numbers: the card's own time, else when its message last changed. */
export const usageReadAt = (entry: UsageEntry): number => entry.card.updatedAt ?? entry.at;

/**
 * How the meter reads: stale when the numbers are older than `USAGE_STALE_MS` or the window has reset since (what was
 * left before means nothing now), else critical below `USAGE_CRITICAL`, low below `USAGE_LOW`, ok.
 */
export function usageLevel(entry: UsageEntry, now: number): UsageLevel {
  if (now - usageReadAt(entry) > USAGE_STALE_MS || (entry.card.resetsAt !== undefined && entry.card.resetsAt <= now)) return "stale";
  const left = usageLeft(entry.card);
  return left < USAGE_CRITICAL ? "critical" : left < USAGE_LOW ? "low" : "ok";
}

/** The meter's colours by level: none while there is plenty, amber when low, red when nearly out, muted when stale. */
export const USAGE_TONE: Record<UsageLevel, { text: string; bar: string; pill: string }> = {
  ok: { text: "text-text-secondary", bar: "bg-text-secondary", pill: "bg-text-primary/[0.06]" },
  low: { text: "text-warn-ink", bar: "bg-amber-500", pill: "bg-amber-500/15" },
  critical: { text: "text-danger", bar: "bg-danger", pill: "bg-danger/15" },
  stale: { text: "text-text-muted", bar: "bg-text-muted", pill: "bg-text-primary/[0.04]" },
};

/**
 * The usage card that stands for each 1:1 chat, by the chat's id: of the contact's usage cards there, the one changed
 * last. My own (I may be the bot) and a group's are left out: the meter is a contact's.
 */
export function usageByChat(rows: readonly CardIndexRow[]): Map<string, UsageEntry> {
  const by = new Map<string, UsageEntry>();
  for (const row of rows) {
    if (row.card.kind !== "usage" || row.sender !== "peer" || row.linkId.startsWith("group:")) continue;
    const at = row.editedAt ?? row.timestamp, was = by.get(row.linkId);
    if (!was || at >= was.at) by.set(row.linkId, { card: row.card, messageId: row.id, at });
  }
  return by;
}

/**
 * When the window starts again, short: the time of day within a day ("18:00"), else the weekday and time ("Fri 09:00"),
 * else the date. In the app's language.
 */
export function resetTime(at: number, now: number, language?: Language): string {
  if (at - now < 20 * 60 * 60_000) return formatAt(at, { hour: "2-digit", minute: "2-digit" }, language);
  if (at - now < 6 * 24 * 60 * 60_000) return formatAt(at, { weekday: "short", hour: "2-digit", minute: "2-digit" }, language);
  return formatAt(at, { month: "short", day: "numeric" }, language);
}
