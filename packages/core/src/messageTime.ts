/**
 * How far ahead of this device's clock a number a peer made from its clock may be (a pin's number, a status card's
 * times): clocks drift, but a time past this is the peer's choice, not its clock.
 */
export const MESSAGE_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The time a line of a group's history is kept under (a membership change, a rename): what its commit says, but at
 * most `MESSAGE_CLOCK_SKEW_MS` past this clock, and now when it is not a positive number. Messages do not use it:
 * they are placed where they arrive (below).
 */
export function receivedTimestamp(ts: number, now = Date.now()): number {
  if (!Number.isFinite(ts) || ts <= 0) return now;
  return Math.min(ts, now + MESSAGE_CLOCK_SKEW_MS);
}

/** The latest moment a date can hold. */
const MAX_DATE_MS = 8.64e15;

/*
 * A received message has two times (WISP 400, requirement 10).
 *
 * Its place: when it was first stored on this device, kept as the row's `timestamp`. A history is sorted by it, so a
 * conversation reads in the order things happened here: what came is where it came, and what I send next goes
 * below it, whatever the sender's clock says. A peer picks the time it sends, so that time never orders anything.
 *
 * The sender's claim: kept beside it (`sentAt`) and shown on the bubble, never later than the place: a message does
 * not show a time that has not come yet.
 */

/** The time a sender says, as it is kept: a positive time a date can hold, or nothing. */
export function claimedTime(ts: unknown): number | undefined {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 && ts <= MAX_DATE_MS ? ts : undefined;
}

/**
 * The place of a row stored now: this clock, and past the last place given in its chat, so rows that come in the
 * same millisecond (a hold pickup, a group's catch-up) keep the order they came in.
 */
export function arrivalKey(now: number, last = 0): number {
  return Math.max(now, last + 1);
}

/** The time a message shows: what its sender said, never later than when it came. A row of mine shows its own time. */
export function shownTime(message: { timestamp: number; sentAt?: number }): number {
  return message.sentAt === undefined ? message.timestamp : Math.min(message.sentAt, message.timestamp);
}

/**
 * When something a peer dated happened (an edit), for this device: what the peer says, now at the latest, and now
 * when it says nothing a date can hold.
 */
export function heardTime(ts: unknown, now = Date.now()): number {
  return Math.min(claimedTime(ts) ?? now, now);
}
