/*
 * A forwarded message (WISP 400 § Forwards): a text or a file someone sends on from another chat, as a new message of
 * theirs. Only the content goes, never who wrote it first or where it came from; what travels with it is a hop count,
 * how many times it has been forwarded, so the reader can say "Forwarded" and, past a few hops, "Forwarded many times".
 * An app without forwards ignores the field and shows a message like any other.
 */

export const FORWARD_LIMITS = {
  /** The count stops here: a message forwarded more often still says it was forwarded many times. */
  max: 255,
  /** From this many hops on, the reader says "Forwarded many times". */
  many: 5,
} as const;

/** A hop count as a receiver takes it: a whole number from 1 to `FORWARD_LIMITS.max`. Anything else is not forwarded. */
export function readForwarded(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= FORWARD_LIMITS.max ? raw : undefined;
}

/** The count a message carries once forwarded again: one more hop than it had (none for a message never forwarded). */
export function forwardedAgain(hops?: number): number {
  return Math.min(FORWARD_LIMITS.max, (readForwarded(hops) ?? 0) + 1);
}

/** Whether a message has come far enough to be called "Forwarded many times". */
export function forwardedMany(hops?: number): boolean {
  return (readForwarded(hops) ?? 0) >= FORWARD_LIMITS.many;
}
