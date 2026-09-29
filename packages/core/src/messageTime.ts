/**
 * How far ahead of this device's clock a received message may say it was sent: clocks drift, but a time past this
 * is the peer's choice, not its clock.
 */
export const MESSAGE_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The time a received message is kept under. A peer picks the `ts` of what it sends, and one far in the future
 * would pin its chat to the top of the list (and past 8.64e15 ms no date can hold it): it is taken as the moment
 * of receipt at the latest. A time that is not a positive number is taken as now.
 */
export function receivedTimestamp(ts: number, now = Date.now()): number {
  if (!Number.isFinite(ts) || ts <= 0) return now;
  return Math.min(ts, now + MESSAGE_CLOCK_SKEW_MS);
}
