import { sanitizeDisplayText } from "./text";

/**
 * The typing indicator of a 1:1 chat (WISP 401 § Typing): "your contact is writing", said on the live session only.
 *
 *     {"t":"paired-typing","s":"start"}   {"t":"paired-typing","s":"stop"}
 *     {"t":"paired-typing","s":"start","kind":"recording"}
 *     {"t":"paired-typing","s":"start","kind":"thinking","status":"Transcribing your audio…"}
 *
 * It needs `typing/1` in `paired-capabilities` on both sides. It is presence, not a message: never sent on the
 * DHT, never stored, never counted as unread, no message id (older apps drop it). While the person keeps typing,
 * `start` is said again at most every `TYPING_REFRESH_MS`; the receiver shows it until `stop`, a message from that
 * contact, the end of the session, or `TYPING_TIMEOUT_MS` without a new `start` (so a dropped link never leaves it on).
 *
 * A `start` may say what the contact is doing (`kind`: typing, recording a voice note, thinking) and, for bots, a
 * short `status` line. Both are optional: an app that knows neither shows "typing…", and so does a kind it does not
 * know. A `start` with a new kind or status goes at once, not at the next refresh.
 */

export const TYPING_FRAME = "paired-typing";

/** How often a `start` is said again while the person keeps typing. */
export const TYPING_REFRESH_MS = 3_000;
/** How long a `start` holds on the receiving side without another. Twice the refresh, so one lost frame is no gap. */
export const TYPING_TIMEOUT_MS = 6_000;
/** At most this many typing frames count per `TYPING_RATE_WINDOW_MS`; the rest are dropped unread. */
export const TYPING_RATE_LIMIT = 8;
export const TYPING_RATE_WINDOW_MS = 10_000;
/**
 * The sender keeps under the reader's limit: a `start` goes only while fewer than this many frames went in the
 * window, so the `stop` that follows it always has room (and a clock skew between the two sides has one frame more).
 */
export const TYPING_SEND_LIMIT = TYPING_RATE_LIMIT - 2;

/** What the contact is doing: writing, recording a voice note, or working on an answer (a bot). */
export const TYPING_KINDS = ["typing", "recording", "thinking"] as const;
export type TypingKind = (typeof TYPING_KINDS)[number];
/** Longest status line kept, in characters (code points). */
export const TYPING_STATUS_MAX = 40;

/** A `start`'s word: the kind, and a bot's status line when it gave one. */
export interface TypingActivity { kind: TypingKind; status?: string }

export type TypingState = "start" | "stop";

// A type, not an interface: it is read back as a plain frame record.
export type TypingFrame = { t: typeof TYPING_FRAME; s: TypingState; kind?: Exclude<TypingKind, "typing">; status?: string };

/** A scheme (`https://`, `nostr:npub…`, `javascript:`), `www.`, or a tag: a status that holds one is not shown. */
const LINK_OR_MARKUP = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:mailto|javascript|data|nostr|lightning|bitcoin|ghostly|magnet|tel|sms|file):|<\/?[a-z!]/i;

/**
 * A status line as it may be shown: one line (line breaks and runs of spaces become one space), no invisible or
 * direction-changing characters, at most `TYPING_STATUS_MAX` characters. Undefined when nothing is left, or when it
 * holds a link or markup (it is plain text, never a way to put a link on the contact's screen).
 */
export function sanitizeTypingStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const oneLine = value.slice(0, 4 * TYPING_STATUS_MAX).replace(/\s+/g, " ");
  const clean = sanitizeDisplayText(oneLine, TYPING_STATUS_MAX);
  if (!clean || LINK_OR_MARKUP.test(clean)) return undefined;
  return clean;
}

/** A kind as it arrived: anything this app does not know reads as plain typing. */
export function typingKindOf(value: unknown): TypingKind {
  return typeof value === "string" && (TYPING_KINDS as readonly string[]).includes(value) ? value as TypingKind : "typing";
}

/** The activity as it goes on the wire and is shown: kind checked, status sanitized. */
export function typingActivity(kind?: unknown, status?: unknown): TypingActivity {
  const clean = sanitizeTypingStatus(status);
  return { kind: typingKindOf(kind), ...(clean ? { status: clean } : {}) };
}

export function typingFrame(state: TypingState, activity?: TypingActivity): TypingFrame {
  const frame: TypingFrame = { t: TYPING_FRAME, s: state };
  if (state !== "start" || !activity) return frame;
  if (activity.kind !== "typing") frame.kind = activity.kind;
  const status = sanitizeTypingStatus(activity.status);
  if (status) frame.status = status;
  return frame;
}

/** The state a `paired-typing` frame says, or null when it is malformed (then it says nothing). */
export function parseTypingFrame(frame: Record<string, unknown>): TypingState | null {
  if (frame?.t !== TYPING_FRAME) return null;
  return frame.s === "start" || frame.s === "stop" ? frame.s : null;
}

/** What a `start` says the contact is doing: `typing` when it says nothing (an older app) or a kind unknown here. */
export function parseTypingActivity(frame: Record<string, unknown>): TypingActivity {
  return typingActivity(frame?.kind, frame?.status);
}

const sameActivity = (a: TypingActivity | null, b: TypingActivity | null) => a?.kind === b?.kind && a?.status === b?.status;

/** This side's word: when to say `start` again, and whether a `stop` is owed. One per session. */
export class TypingSender {
  private startedAt = 0;
  private standing: TypingActivity | null = null;
  private recent: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The person typed (or records, or thinks): the frame to send now, or null when a `start` with the same word went
   * out less than a refresh ago, or the window is full (the next call tries again).
   */
  typing(activity: TypingActivity = { kind: "typing" }): TypingFrame | null {
    const now = this.now();
    const word = typingActivity(activity.kind, activity.status);
    if (this.startedAt && now - this.startedAt < TYPING_REFRESH_MS && sameActivity(this.standing, word)) return null;
    this.recent = this.recent.filter(at => now - at < TYPING_RATE_WINDOW_MS);
    if (this.recent.length >= TYPING_SEND_LIMIT) return null;
    this.recent.push(now);
    this.startedAt = now;
    this.standing = word;
    return typingFrame("start", word);
  }

  /** The person stopped (cleared the text, sent it, left the chat): a `stop`, only when a `start` is standing. */
  stopped(): TypingFrame | null {
    if (!this.startedAt) return null;
    this.recent.push(this.now());
    this.startedAt = 0;
    this.standing = null;
    return typingFrame("stop");
  }

  /** A `start` is standing on this session. */
  get active(): boolean { return this.startedAt !== 0; }

  /** The session ended: nothing is standing on the next one. */
  reset(): void { this.startedAt = 0; this.standing = null; }
}

/**
 * The contact's word, with its timeout and a rate limit. `onChange` hears every change, and only changes: typing on
 * or off, and a new kind or status while it is on.
 */
export class TypingReceiver {
  private activity: TypingActivity | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recent: number[] = [];

  constructor(private readonly onChange: (typing: boolean, activity: TypingActivity | null) => void, private readonly now: () => number = Date.now) {}

  /** The contact is typing now. */
  get peerTyping(): boolean { return this.activity !== null; }
  /** What the contact is doing now, or null. */
  get peerActivity(): TypingActivity | null { return this.activity; }

  /**
   * A `paired-typing` frame from the contact. False when it was dropped: malformed, or over the rate limit (a
   * contact flooding frames gets its word held where it was until the window lets it speak again).
   */
  receive(frame: Record<string, unknown>): boolean {
    const now = this.now();
    this.recent = this.recent.filter(at => now - at < TYPING_RATE_WINDOW_MS);
    if (this.recent.length >= TYPING_RATE_LIMIT) return false;
    this.recent.push(now);
    const state = parseTypingFrame(frame);
    if (!state) return false;
    if (state === "stop") { this.clear(); return true; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.set(null); }, TYPING_TIMEOUT_MS);
    this.set(parseTypingActivity(frame));
    return true;
  }

  /** A message from the contact arrived, or the session ended: it is not typing any more. */
  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.set(null);
  }

  private set(activity: TypingActivity | null): void {
    if (sameActivity(activity, this.activity)) return;
    this.activity = activity;
    this.onChange(activity !== null, activity);
  }
}
