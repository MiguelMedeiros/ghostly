import { MEMBER_KEY } from "./groupCommits";
import { utf8Encode } from "./bytes";

/*
 * Mentions in a group message (WISP 9xx Group Mesh § Mentions, Group Community § Mentions): which members a
 * message names, bound to their member keys rather than to the names they go by, since names can collide and
 * change. The text keeps a readable "@Name" at each place, so an app without mentions shows the message as it
 * was typed; the list says which member each place is.
 */

/** A place in the text that names a member: `k` their member key ("*": everyone), `o`/`l` in Unicode code points. */
export interface GroupMention { k: string; o: number; l: number }

/** Everyone in the group (a private group's admin only; never in a community). */
export const MENTION_EVERYONE = "*";

export const MENTION_LIMITS = {
  /** Mentions in one message. A longer list is refused whole. */
  count: 16,
  /** Code points of one mention in the text, its "@" included. */
  chars: 65,
} as const;

// eslint-disable-next-line no-control-regex
const NOT_IN_A_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * The mentions of a message as a receiver (or the sender) takes them: at most `count` of them, each naming a
 * member key (or everyone, when `everyone` allows it), at a place of the text that starts with "@" and holds no
 * line break or control character, in order and not overlapping. An entry that is none of that is dropped; a list
 * longer than the bound is dropped whole.
 */
export function validMentions(raw: unknown, text: string, everyone: boolean): GroupMention[] {
  if (!Array.isArray(raw) || raw.length > MENTION_LIMITS.count) return [];
  const points = Array.from(text);
  const kept: GroupMention[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { k, o, l } = entry as Record<string, unknown>;
    if (typeof k !== "string" || !(MEMBER_KEY.test(k) || (everyone && k === MENTION_EVERYONE))) continue;
    if (!isInt(o) || !isInt(l) || l < 2 || l > MENTION_LIMITS.chars || o + l > points.length || points[o] !== "@") continue;
    // A name has no line break, control or direction character: a mention holding one is not a name.
    if (NOT_IN_A_NAME.test(points.slice(o, o + l).join(""))) continue;
    kept.push({ k, o, l });
  }
  kept.sort((a, b) => a.o - b.o);
  return kept.filter((m, i) => i === 0 || m.o >= kept[i - 1].o + kept[i - 1].l);
}

/** Whether a message's mentions name this member (by key, or everyone). */
export function mentionsMember(mentions: readonly GroupMention[] | undefined, key: string): boolean {
  return !!mentions?.some(m => m.k === key || m.k === MENTION_EVERYONE);
}

/** The bytes a list of mentions adds to a message, as JSON: counted against the text's bound. */
export function mentionsBytes(mentions: readonly GroupMention[]): number {
  return mentions.length ? utf8Encode(JSON.stringify(mentions)).length : 0;
}

/** Only the wire fields, in a fixed order (what the sender seals). */
export const wireMentions = (mentions: readonly GroupMention[]): GroupMention[] => mentions.map(({ k, o, l }) => ({ k, o, l }));
