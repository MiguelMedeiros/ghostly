import { REPLY_ID } from "./replies";
import { nextReactionNumber, validReactionNumber } from "./reactions";

/**
 * A pinned message (WISP 400 § Pinned message): one per chat, shown in a bar at the top. Whoever pins says which
 * message (the id both sides know it by, as a reply names it) and a number: the clock in milliseconds, past the pin
 * it replaces. An empty id unpins. The highest number wins, whatever order the frames arrive in, so the last pin wins
 * on every side and a late frame changes nothing.
 *
 * A 1:1 chat says it on the live session once both sides list `pin/1` in `paired-capabilities`, and the contact
 * confirms the number it took:
 *
 *     {"t":"paired-pin","id":"<message id>","n":1790000000000}
 *     {"t":"paired-pinned","n":1790000000000}
 *
 * A private group signs it and passes it over the edges (`group-pin`); a community seals it to the group as an
 * application frame (`pin`). Older apps drop all of these: a `t` they do not know.
 */

export const PIN_FRAME = "paired-pin";
export const PINNED_FRAME = "paired-pinned";
/** A pin in a private group, signed by the member who pinned, passed on by every member that takes it. */
export const GROUP_PIN_FRAME = "group-pin";
/** A pin in a community, as an application frame sealed to the group. */
export const COMMUNITY_PIN_FRAME = "pin";

export const PIN_LIMITS = {
  /** Pin frames a receiver takes per window on one chat; the rest are dropped unconfirmed and come again. */
  receive: 10,
  windowMs: 10_000,
  /** A pin said on the live session and not confirmed is said again after this long. */
  resendMs: 30_000,
} as const;

/** A pin as it goes on the wire: the message's id ("" unpins) and the pinner's number. */
export interface WirePin { id: string; n: number }

/**
 * Who may pin in a group. The one place the rule lives (WISP 400 § Pinned message): in a private group any member,
 * in a community only its admin.
 */
export function mayPin(kind: "mesh" | "community", member: string, admin: string | undefined): boolean {
  return kind === "mesh" || member === admin;
}

/** The number for a new pin: the clock, or one past the pin shown now, whichever is higher. */
export function nextPinNumber(current = 0, now = Date.now()): number {
  return nextReactionNumber(current, now);
}

/**
 * Whether `pin` replaces the chat's pin now: a higher number wins; two pins with the same number (two sides at the
 * same millisecond) are settled by the id, so every side ends on the same one.
 */
export function pinIsNewer(current: WirePin | undefined, pin: WirePin): boolean {
  return !current || pin.n > current.n || (pin.n === current.n && pin.id > current.id);
}

/** A pin as a receiver takes it, or null: an id of a chat's shape or "" (unpinned), and a valid number. */
export function readPin(raw: unknown): WirePin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, n } = raw as Record<string, unknown>;
  if (typeof id !== "string" || (id !== "" && !REPLY_ID.test(id)) || !validReactionNumber(n)) return null;
  return { id, n };
}

export function pinFrame(pin: WirePin): string {
  return JSON.stringify({ t: PIN_FRAME, id: pin.id, n: pin.n });
}

export function pinnedFrame(n: number): string {
  return JSON.stringify({ t: PINNED_FRAME, n });
}

/** The pin a `paired-pin` frame says, or null when it is malformed. */
export function parsePinFrame(frame: Record<string, unknown>): WirePin | null {
  return frame?.t === PIN_FRAME ? readPin(frame) : null;
}

/** The number a `paired-pinned` frame confirms, or null when it is malformed. */
export function parsePinnedFrame(frame: Record<string, unknown>): number | null {
  return frame?.t === PINNED_FRAME && validReactionNumber(frame.n) ? frame.n : null;
}
