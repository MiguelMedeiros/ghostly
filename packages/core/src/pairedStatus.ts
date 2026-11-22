import { plainStatusLine } from "./pairedTyping";
import { reactionEmoji } from "./reactions";

/**
 * Presence and a set status in a 1:1 chat (WISP 401 § Presence and status): whether the person is there, and a status
 * they set (Slack-like), said to the contact on the live session only.
 *
 *     {"t":"paired-status","p":"active"}
 *     {"t":"paired-status","p":"idle","s":{"a":"busy","e":"🍕","m":"At lunch","u":1762603600000}}
 *     {"t":"paired-status"}
 *
 * It needs `status/1` in `paired-capabilities` on both sides. Each frame is the whole state and replaces the one before.
 * Like typing, it is presence, not a message: no message id (older apps drop it), never stored, held or put on the DHT.
 * `p` is absent when the person does not share when they are online; `s` is absent when they set no status.
 */

export const STATUS_FRAME = "paired-status";

/** What a person can say they are: `dnd` is Do not disturb. */
export const STATUS_AVAILABILITIES = ["available", "busy", "away", "dnd"] as const;
export type StatusAvailability = (typeof STATUS_AVAILABILITIES)[number];
/** Whether the person uses the app now (`active`) or not for a while (`idle`). */
export const PRESENCES = ["active", "idle"] as const;
export type Presence = (typeof PRESENCES)[number];

/** Longest status text kept, in characters (code points). */
export const STATUS_TEXT_MAX = 60;
/** No input in the app for this long: the person is idle. */
export const STATUS_IDLE_AFTER_MS = 600_000;
/** The sender says at most one frame per this; a change in between goes when it ends, the latest state only. */
export const STATUS_SEND_INTERVAL_MS = 5_000;
/** The reader drops frames past this many per window: room above the sender's 12 a minute. */
export const STATUS_RATE_LIMIT = 15;
export const STATUS_RATE_WINDOW_MS = 60_000;

/** A status a person set. Every field is optional; `until` is when it ends (Unix milliseconds). */
export interface PersonStatus { availability?: StatusAvailability; emoji?: string; text?: string; until?: number }
/** What one side says of itself: presence only when it shares it, a status only when it set one. */
export interface StatusState { presence?: Presence; status?: PersonStatus }

// Types, not interfaces: they are read back as plain frame records.
export type WireStatus = { a?: StatusAvailability; e?: string; m?: string; u?: number };
export type StatusFrame = { t: typeof STATUS_FRAME; p?: Presence; s?: WireStatus };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validUntil = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const availabilityOf = (value: unknown): StatusAvailability =>
  (STATUS_AVAILABILITIES as readonly unknown[]).includes(value) ? value as StatusAvailability : "available";
const presenceOf = (value: unknown): Presence => (PRESENCES as readonly unknown[]).includes(value) ? value as Presence : "active";

/** A status text as it may be shown: one line, no invisible characters, no link or markup, at most 60 characters. */
export function sanitizeStatusText(value: unknown): string | undefined {
  return plainStatusLine(value, STATUS_TEXT_MAX);
}

/** A status with each field checked; undefined when nothing is left of it. An unknown availability reads as available. */
export function personStatus(raw: { availability?: unknown; emoji?: unknown; text?: unknown; until?: unknown } | undefined): PersonStatus | undefined {
  if (!isObject(raw)) return undefined;
  const status: PersonStatus = {};
  if (raw.availability !== undefined) status.availability = availabilityOf(raw.availability);
  const emoji = reactionEmoji(raw.emoji);
  if (emoji) status.emoji = emoji;
  const text = sanitizeStatusText(raw.text);
  if (text) status.text = text;
  if (validUntil(raw.until)) status.until = raw.until;
  return Object.keys(status).length ? status : undefined;
}

/** The status while it lasts: undefined once its `until` is past by this clock. */
export function liveStatus(status: PersonStatus | undefined, now = Date.now()): PersonStatus | undefined {
  return status && (status.until === undefined || status.until > now) ? status : undefined;
}

/** A state with its fields checked. */
export function statusState(raw: StatusState): StatusState {
  const state: StatusState = {};
  if (raw.presence !== undefined) state.presence = presenceOf(raw.presence);
  const status = personStatus(raw.status);
  if (status) state.status = status;
  return state;
}

export function statusFrame(state: StatusState): StatusFrame {
  const frame: StatusFrame = { t: STATUS_FRAME };
  const clean = statusState(state);
  if (clean.presence) frame.p = clean.presence;
  const status = clean.status;
  if (status) {
    const wire: WireStatus = {};
    if (status.availability) wire.a = status.availability;
    if (status.emoji) wire.e = status.emoji;
    if (status.text) wire.m = status.text;
    if (status.until !== undefined) wire.u = status.until;
    frame.s = wire;
  }
  return frame;
}

/**
 * The state a `paired-status` frame says, or null when it is malformed (then the reader keeps what it had): `s` not an
 * object, or `p` or `s.a` present and not a string. A field that does not hold (an emoji that is not one, a text with a
 * link, a bad `u`) is left out, not the frame.
 */
export function parseStatusFrame(frame: Record<string, unknown>): StatusState | null {
  if (frame?.t !== STATUS_FRAME) return null;
  if (frame.p !== undefined && typeof frame.p !== "string") return null;
  if (frame.s !== undefined && !isObject(frame.s)) return null;
  const s = frame.s as Record<string, unknown> | undefined;
  if (s?.a !== undefined && typeof s.a !== "string") return null;
  return statusState({
    ...(frame.p !== undefined ? { presence: frame.p as Presence } : {}),
    ...(s ? { status: { availability: s.a, emoji: s.e, text: s.m, until: s.u } as PersonStatus } : {}),
  });
}

const sameStatus = (a?: PersonStatus, b?: PersonStatus) =>
  a?.availability === b?.availability && a?.emoji === b?.emoji && a?.text === b?.text && a?.until === b?.until;
/** Two states say the same. */
export const sameStatusState = (a: StatusState, b: StatusState) => a.presence === b.presence && sameStatus(a.status, b.status);

/**
 * This side's word: what it says, and when. One per chat. A new session owes the whole state (`reset`); a change owes
 * it again. Frames go at most one per `STATUS_SEND_INTERVAL_MS`, across sessions, so the reader's window always has room.
 */
export class StatusSender {
  private state: StatusState = {};
  private owed = true;
  private sentAt = -Infinity;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** What this side says now. */
  get current(): StatusState { return this.state; }

  /** This side's presence or status changed: owed again when it says something new. */
  set(state: StatusState): void {
    const clean = statusState(state);
    if (sameStatusState(clean, this.state)) return;
    this.state = clean;
    this.owed = true;
  }

  /**
   * On a session that agreed `status/1`: the frame to send now; or how long to wait before asking again (the interval
   * has not passed); or null when nothing is owed.
   */
  take(): { frame: StatusFrame } | { wait: number } | null {
    if (!this.owed) return null;
    const now = this.now(), wait = this.sentAt + STATUS_SEND_INTERVAL_MS - now;
    // A clock set back does not hold the frame: `now` before the last send says it at once.
    if (wait > 0 && now >= this.sentAt) return { wait };
    this.owed = false;
    this.sentAt = now;
    return { frame: statusFrame(this.state) };
  }

  /** The session ended: the next one is owed the whole state. */
  reset(): void { this.owed = true; }
}

/**
 * The contact's word, with a rate limit. Presence ends with the session (`endSession`); the status stays until a new
 * frame replaces it or its `until` passes (read through `peer`). `onChange` hears changes only.
 */
export class StatusReceiver {
  private state: StatusState = {};
  private recent: number[] = [];

  constructor(private readonly onChange: (state: StatusState) => void, private readonly now: () => number = () => Date.now()) {}

  /** What the contact says now, a status past its `until` left out. */
  get peer(): StatusState {
    const status = liveStatus(this.state.status, this.now());
    return { ...(this.state.presence ? { presence: this.state.presence } : {}), ...(status ? { status } : {}) };
  }

  /** A `paired-status` frame from the contact. False when it was dropped: malformed, or over the rate limit. */
  receive(frame: Record<string, unknown>): boolean {
    const now = this.now();
    this.recent = this.recent.filter(at => at <= now && now - at < STATUS_RATE_WINDOW_MS);
    if (this.recent.length >= STATUS_RATE_LIMIT) return false;
    this.recent.push(now);
    const state = parseStatusFrame(frame);
    if (!state) return false;
    this.set(state);
    return true;
  }

  /** The session ended: the contact is not online any more; its status stands. */
  endSession(): void {
    if (this.state.presence) this.set(this.state.status ? { status: this.state.status } : {});
  }

  private set(state: StatusState): void {
    if (sameStatusState(state, this.state)) return;
    this.state = state;
    this.onChange(this.peer);
  }
}
