import type { StoredMessage } from "../shared/types";

/**
 * A history stored before a received row was placed where it arrived (WISP 400, requirement 10; until 2026-10): a
 * contact's row sits under the time the contact's clock said, up to five minutes ahead of this device's. Almost all of
 * it stays as it is: its stored time is its place, so nothing moves when the app updates. Only the rows whose stored
 * time has not come yet are settled, once, at the start: they are the last rows of their chat, and left there a
 * message written in the next minutes would sort above them. Each takes a place just before now, in the order they
 * were in and after everything before them, and keeps the time its sender said beside it (`sentAt`).
 *
 * Returns the rows to write, as they are now; none when nothing is ahead. Rows of mine are never touched: their time
 * is the one both sides know them by.
 */
export function settleAhead(history: readonly StoredMessage[], now: number): StoredMessage[] {
  const ahead = history.filter((m) => m.sender === "peer" && m.sentAt === undefined && m.timestamp > now);
  if (!ahead.length) return [];
  let last = history.reduce((max, m) => (m.timestamp > now ? max : Math.max(max, m.timestamp)), 0);
  return ahead.map((m, i) => {
    last = Math.max(last + 1, now - (ahead.length - i));
    return { ...m, timestamp: last, sentAt: m.timestamp };
  });
}
