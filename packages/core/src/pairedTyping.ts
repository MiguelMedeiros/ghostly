/**
 * The typing indicator of a 1:1 chat (WISP 401 § Typing): "your contact is writing", said on the live session only.
 *
 *     {"t":"paired-typing","s":"start"}   {"t":"paired-typing","s":"stop"}
 *
 * It needs `typing/1` in `paired-capabilities` on both sides. It is presence, not a message: never sent on the
 * DHT, never stored, never counted as unread, no message id (older apps drop it). While the person keeps typing,
 * `start` is said again at most every `TYPING_REFRESH_MS`; the receiver shows it until `stop`, a message from that
 * contact, the end of the session, or `TYPING_TIMEOUT_MS` without a new `start` (so a dropped link never leaves it on).
 */

export const TYPING_FRAME = "paired-typing";

/** How often a `start` is said again while the person keeps typing. */
export const TYPING_REFRESH_MS = 3_000;
/** How long a `start` holds on the receiving side without another. Twice the refresh, so one lost frame is no gap. */
export const TYPING_TIMEOUT_MS = 6_000;
/** At most this many typing frames count per `TYPING_RATE_WINDOW_MS`; the rest are dropped unread. */
export const TYPING_RATE_LIMIT = 8;
export const TYPING_RATE_WINDOW_MS = 10_000;

export type TypingState = "start" | "stop";

export function typingFrame(state: TypingState): { t: typeof TYPING_FRAME; s: TypingState } {
  return { t: TYPING_FRAME, s: state };
}

/** The state a `paired-typing` frame says, or null when it is malformed (then it says nothing). */
export function parseTypingFrame(frame: Record<string, unknown>): TypingState | null {
  if (frame?.t !== TYPING_FRAME) return null;
  return frame.s === "start" || frame.s === "stop" ? frame.s : null;
}

/** This side's word: when to say `start` again, and whether a `stop` is owed. One per session. */
export class TypingSender {
  private startedAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The person typed: the frame to send now, or null when a `start` went out less than a refresh ago. */
  typing(): ReturnType<typeof typingFrame> | null {
    const now = this.now();
    if (this.startedAt && now - this.startedAt < TYPING_REFRESH_MS) return null;
    this.startedAt = now;
    return typingFrame("start");
  }

  /** The person stopped (cleared the text, sent it, left the chat): a `stop`, only when a `start` is standing. */
  stopped(): ReturnType<typeof typingFrame> | null {
    if (!this.startedAt) return null;
    this.startedAt = 0;
    return typingFrame("stop");
  }

  /** A `start` is standing on this session. */
  get active(): boolean { return this.startedAt !== 0; }

  /** The session ended: nothing is standing on the next one. */
  reset(): void { this.startedAt = 0; }
}

/** The contact's word, with its timeout and a rate limit. `onChange` hears every change, and only changes. */
export class TypingReceiver {
  private typing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recent: number[] = [];

  constructor(private readonly onChange: (typing: boolean) => void, private readonly now: () => number = Date.now) {}

  /** The contact is typing now. */
  get peerTyping(): boolean { return this.typing; }

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
    this.timer = setTimeout(() => { this.timer = null; this.set(false); }, TYPING_TIMEOUT_MS);
    this.set(true);
    return true;
  }

  /** A message from the contact arrived, or the session ended: it is not typing any more. */
  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.set(false);
  }

  private set(typing: boolean): void {
    if (typing === this.typing) return;
    this.typing = typing;
    this.onChange(typing);
  }
}
