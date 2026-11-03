import { nextPinNumber, pinNumberHolds, PIN_LIMITS } from "./pins";
import { validReactionNumber } from "./reactions";

/**
 * Disappearing messages in a 1:1 chat (WISP 400 § Disappearing messages, 401 § Disappearing messages): a per-chat
 * timer, in seconds (0 = off), after which new messages go from both devices. Either side sets it, and the last
 * setting wins on both: its number follows a pin's rule (`pins.ts`), the setter's clock in milliseconds or one past the
 * setting it replaces, at most `PIN_CLOCK_SKEW_MS` past the reader's clock, the highest wins.
 *
 * It goes on the live session once both sides list `timer/1` in `paired-capabilities`, and the contact confirms the
 * number it took:
 *
 *     {"t":"paired-timer","s":86400,"n":1790000000000}
 *     {"t":"paired-timered","n":1790000000000}
 *
 * Each message sent under a timer carries it as `ttl` (seconds) on `paired-message`, a file's `pf-offer` and `pf-start`,
 * and a held item's meta; a reader applies the shorter of `ttl` and its own setting. Neither frame rides the DHT floor,
 * and neither carries a message id: older apps drop both, and ignore `ttl`.
 */

export const TIMER_FRAME = "paired-timer";
export const TIMED_FRAME = "paired-timered";

const HOUR = 3_600;
const DAY = 24 * HOUR;

/** What a person picks from (WISP 400, decision 1): Off, 1 hour, 1 day, 1 week, 4 weeks. The wire takes more. */
export const TIMER_CHOICES: readonly number[] = [0, HOUR, DAY, 7 * DAY, 28 * DAY];

export const TIMER_LIMITS = {
  /** A timer or a `ttl`, when on: a whole number of seconds from a minute to a year. Custom values need no new format. */
  minS: 60,
  maxS: 365 * DAY,
  /** Timer frames a receiver takes per window on one chat, and when an unconfirmed one is said again: a pin's. */
  receive: PIN_LIMITS.receive,
  windowMs: PIN_LIMITS.windowMs,
  resendMs: PIN_LIMITS.resendMs,
  /** A contact's message never shown still goes this long after it arrived. */
  unreadMaxS: 28 * DAY,
  /** A swept message's id is kept this long (past a hold's 7 days and the outbox's week), at most this many per chat. */
  sweptKeepMs: 8 * DAY * 1000,
  sweptPerChat: 10_000,
} as const;

/** A chat's timer as it goes on the wire: seconds (0 = off) and the setter's number. */
export interface WireTimer { s: number; n: number }

/** Seconds a timer that is on may hold, or a message's `ttl`: a whole number from a minute to a year. */
function timedSeconds(s: unknown): s is number {
  return typeof s === "number" && Number.isSafeInteger(s) && s >= TIMER_LIMITS.minS && s <= TIMER_LIMITS.maxS;
}

/** The number for a new setting: the clock, or one past the setting kept now, as a pin's (`nextPinNumber`). */
export function nextTimerNumber(current = 0, now = Date.now()): number {
  return nextPinNumber(current, now);
}

/**
 * Whether `timer` replaces the chat's setting now: a higher number wins. Two with the same number (both sides at the
 * same millisecond) end on the shorter timer, off counting as the longest, so every side ends on the same one. A kept
 * setting whose number does not hold counts as none: any setting replaces it.
 */
export function timerIsNewer(current: WireTimer | undefined, timer: WireTimer, now = Date.now()): boolean {
  if (!current || !pinNumberHolds(current.n, now) || timer.n > current.n) return true;
  if (timer.n < current.n) return false;
  const length = (s: number) => s === 0 ? Infinity : s;
  return length(timer.s) < length(current.s);
}

/**
 * A setting as a receiver takes it at `now`, or null: `s` 0 (off) or a whole number of seconds from a minute to a year,
 * and a number that holds (`pinNumberHolds`). One refused is not confirmed: its setter says it again.
 */
export function readTimer(raw: unknown, now = Date.now()): WireTimer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { s, n } = raw as Record<string, unknown>;
  if ((s !== 0 && !timedSeconds(s)) || !pinNumberHolds(n, now)) return null;
  return { s: s as number, n };
}

/** Only the wire fields, in a fixed order. */
export function timerFrame(timer: WireTimer): string {
  return JSON.stringify({ t: TIMER_FRAME, s: timer.s, n: timer.n });
}

export function timedFrame(n: number): string {
  return JSON.stringify({ t: TIMED_FRAME, n });
}

/** The setting a `paired-timer` frame says, or null when it is malformed or numbered too far ahead. */
export function parseTimerFrame(frame: Record<string, unknown>, now = Date.now()): WireTimer | null {
  return frame?.t === TIMER_FRAME ? readTimer(frame, now) : null;
}

/** The number a `paired-timered` frame confirms, or null when it is malformed. */
export function parseTimedFrame(frame: Record<string, unknown>): number | null {
  return frame?.t === TIMED_FRAME && validReactionNumber(frame.n) ? frame.n : null;
}

/**
 * The `ttl` of a `paired-message`, a `pf-offer` or `pf-start`, or a held item's meta, in seconds; undefined when it is
 * absent or not a whole number from a minute to a year. A bad `ttl` is dropped, never the message: it then takes the
 * reader's own setting (`effectiveTtl`).
 */
export function readTtl(frame: unknown): number | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const { ttl } = frame as Record<string, unknown>;
  return timedSeconds(ttl) ? ttl : undefined;
}

/**
 * How long a message lives on this side, in seconds, or undefined when it is not timed: the shorter of the `ttl` it
 * came with and this side's setting (0 = off). With no `ttl` (an older app, the DHT floor, one dropped), the setting.
 */
export function effectiveTtl(ttl: number | undefined, setting: number): number | undefined {
  const own = setting > 0 ? setting : undefined;
  if (ttl === undefined) return own;
  return own === undefined ? ttl : Math.min(ttl, own);
}
