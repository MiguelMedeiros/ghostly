import { utf8Encode } from "./bytes";
import { REPLY_ID } from "./replies";

/**
 * Reactions to messages (WISP 400 § Reactions): one emoji per person per message, like WhatsApp. Whoever reacts says
 * which message (the id both sides know it by, as a reply names it), the emoji, and a number of its own that only
 * grows; an empty emoji takes the reaction back. For each person and message the highest number wins, whatever order
 * the frames arrive in, so a new reaction replaces the old one and a late frame changes nothing.
 *
 * A 1:1 chat says it on the live session once both sides list `react/1` in `paired-capabilities`, and the contact
 * confirms each number it took:
 *
 *     {"t":"paired-reaction","id":"<message id>","e":"❤️","n":1790000000000}
 *     {"t":"paired-reacted","n":1790000000000}
 *
 * Off the live session they ride on the DHT envelopes (WISP 403 § Reactions). Groups carry them in their own frames
 * (WISP 9xx § Reactions). Older apps drop all of these: a `t` they do not know, or a trailing element they skip.
 */

export const REACTION_FRAME = "paired-reaction";
export const REACTED_FRAME = "paired-reacted";
/** A reaction in a private group, over the edge from the member who reacts (WISP 9xx group mesh § Reactions). */
export const GROUP_REACTION_FRAME = "group-react";
/** A reaction in a community, as an application frame sealed to the group (WISP 9xx group community § Reactions). */
export const COMMUNITY_REACTION_FRAME = "reaction";

/** The quick bar, in order: what most reactions are. Any other emoji comes from the picker. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export const REACTION_LIMITS = {
  /** UTF-8 bytes of one emoji: a family or a subdivision flag fits, a run of emoji does not. */
  emojiBytes: 32,
  /** Reaction frames a receiver takes per window on one chat; the rest are dropped unconfirmed and come again. */
  receive: 30,
  /** Reactions a sender says per window on one chat; the newest of each message waits for room. */
  send: 20,
  windowMs: 10_000,
  /** A reaction to a message not here yet waits this long for it, at most `buffer` of them per chat. */
  bufferMs: 60_000,
  buffer: 64,
  /** Reactions of this side not confirmed yet, per chat: the oldest is dropped past it. */
  pending: 32,
  /** Reactions one DHT envelope carries at most, room allowing. */
  dht: 8,
} as const;

/** One reaction as it goes on the wire: the message's id, the emoji ("" takes it back) and the reactor's number. */
export interface WireReaction { id: string; e: string; n: number }

const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|\u20E3/u;
/** Emoji_Component holds the joiner, the selector, the keycap, skin tones, tags and regional indicators. */
const EMOJI_POINT = /^[\p{Emoji}\p{Emoji_Component}]$/u;
const PRESENTATION = /^\p{Emoji_Presentation}$/u;

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;
function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    const Ctor = (globalThis as { Intl?: { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter } }).Intl?.Segmenter;
    segmenter = Ctor ? new Ctor(undefined, { granularity: "grapheme" }) : null;
  }
  if (segmenter) return Array.from(segmenter.segment(text), s => s.segment);
  // Without a segmenter (none of the apps' runtimes): a sequence joined by ZWJ, modifiers or tags counts as one.
  return text ? [text] : [];
}

/**
 * The emoji a reaction may carry, in one form (so the same emoji from two apps is one chip), or null when it is not
 * one: exactly one grapheme, made of emoji code points only, with a pictograph in it, at most
 * `REACTION_LIMITS.emojiBytes`. A single pictograph drawn as text by default gets the emoji selector (❤ → ❤️); one
 * drawn as emoji by default loses a redundant one (👍️ → 👍). Sequences keep their selectors as sent.
 */
export function reactionEmoji(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > REACTION_LIMITS.emojiBytes) return null;
  let emoji = raw.normalize("NFC");
  const points = [...emoji.replace(/\uFE0F/g, "")];
  if (points.length === 1) emoji = PRESENTATION.test(points[0]) ? points[0] : `${points[0]}\uFE0F`;
  if (utf8Encode(emoji).length > REACTION_LIMITS.emojiBytes) return null;
  if (![...emoji].every(point => EMOJI_POINT.test(point)) || !PICTOGRAPH.test(emoji)) return null;
  return graphemes(emoji).length === 1 ? emoji : null;
}

/** A reactor's number: valid on the wire (a positive safe integer). */
export function validReactionNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/**
 * The number for this side's next reaction in a chat: the clock in milliseconds, or one past the last, whichever is
 * higher. It only grows, even when the clock goes back.
 */
export function nextReactionNumber(last = 0, now = Date.now()): number {
  return Math.max(Math.floor(now), last + 1);
}

/** Whether a reaction numbered `n` replaces what a person's reaction to that message is now. */
export function reactionIsNewer(current: { n: number } | undefined, n: number): boolean {
  return !current || n > current.n;
}

/**
 * A reaction as a receiver takes it, or null: a message id of a chat's shape (as a reply names it), an emoji that
 * holds or "" (taken back), and a valid number. Anything else says nothing and is not confirmed.
 */
export function readReaction(raw: unknown): WireReaction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, e, n } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !REPLY_ID.test(id) || !validReactionNumber(n)) return null;
  if (e === "") return { id, e: "", n };
  const emoji = reactionEmoji(e);
  return emoji ? { id, e: emoji, n } : null;
}

/** Only the wire fields, in a fixed order. */
export const wireReaction = (r: WireReaction): WireReaction => ({ id: r.id, e: r.e, n: r.n });

export function reactionFrame(r: WireReaction): string {
  return JSON.stringify({ t: REACTION_FRAME, ...wireReaction(r) });
}

export function reactedFrame(n: number): string {
  return JSON.stringify({ t: REACTED_FRAME, n });
}

/** The reaction a `paired-reaction` frame says, or null when it is malformed. */
export function parseReactionFrame(frame: Record<string, unknown>): WireReaction | null {
  return frame?.t === REACTION_FRAME ? readReaction(frame) : null;
}

/** The number a `paired-reacted` frame confirms, or null when it is malformed. */
export function parseReactedFrame(frame: Record<string, unknown>): number | null {
  return frame?.t === REACTED_FRAME && validReactionNumber(frame.n) ? frame.n : null;
}

/**
 * A DHT envelope's reactions (its thirteenth element): `[[id, emoji, n], …]`. What does not hold is skipped, never the
 * envelope; at most `REACTION_LIMITS.dht` are read.
 */
export function readDhtReactions(raw: unknown): WireReaction[] {
  if (!Array.isArray(raw)) return [];
  const out: WireReaction[] = [];
  for (const entry of raw.slice(0, REACTION_LIMITS.dht)) {
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const reaction = readReaction({ id: entry[0], e: entry[1], n: entry[2] });
    if (reaction) out.push(reaction);
  }
  return out;
}

/**
 * This side's reactions not confirmed yet, after one more: the newest per message (a new one replaces a pending one
 * for the same message), in the order of their numbers, the oldest dropped past `REACTION_LIMITS.pending`.
 */
export function queueReaction(pending: readonly WireReaction[], reaction: WireReaction): WireReaction[] {
  return [...pending.filter(p => p.id !== reaction.id), wireReaction(reaction)].sort((a, b) => a.n - b.n).slice(-REACTION_LIMITS.pending);
}

/** A sliding window of `limit` events per `windowMs`: a sender's pace and a receiver's limit. */
export class ReactionWindow {
  private recent: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs: number = REACTION_LIMITS.windowMs, private readonly now: () => number = Date.now) {}

  /** Counts one now; false (and not counted) when the window is full. */
  take(): boolean {
    const now = this.now();
    this.recent = this.recent.filter(at => now - at < this.windowMs);
    if (this.recent.length >= this.limit) return false;
    this.recent.push(now);
    return true;
  }

  /** Milliseconds until the window has room again; 0 when it has room now. */
  wait(): number {
    const now = this.now();
    this.recent = this.recent.filter(at => now - at < this.windowMs);
    return this.recent.length < this.limit ? 0 : this.recent[0] + this.windowMs - now;
  }

  reset(): void { this.recent = []; }
}
