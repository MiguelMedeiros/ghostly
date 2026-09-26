import { MENTION_EVERYONE, MENTION_LIMITS, type GroupMention } from "@ghostly/core";
import type { Atom, Detector } from "./types";

/*
 * Mentions in a group's composer and bubbles (WISP 9xx § Mentions). The composer keeps which member each "@Name"
 * it inserted stands for; on send, every place the text still has that token becomes a mention bound to the
 * member's key. A bubble then shows each mention with the member's name as it is now.
 */

/** A member the picker offers: `name` as the group shows them, `tag` a short piece of their key. */
export interface MentionCandidate { key: string; name: string; tag: string }
/** What the composer inserted: `@${label}` for `key` (`MENTION_EVERYONE` for everyone). */
export interface ChosenMention { key: string; label: string }
/** The "@…" being typed at the caret: `start` is the "@", `end` the caret (UTF-16 indices, as the textarea has them). */
export interface MentionQuery { start: number; end: number; query: string }
/**
 * A mention as a bubble shows it: its place (code points), the name to show, whether it names me, and what the
 * message has at that place (without the "@").
 */
export interface MentionView { o: number; l: number; key: string; name: string; me: boolean; written?: string }

/** How much of a name the picker is asked about. */
const QUERY_CHARS = 32;
/**
 * A key is matched from this many characters on, by its start or the piece the picker shows: two letters are found
 * somewhere in most 52-character keys, and "@Bo" must not offer Carol.
 */
const KEY_QUERY_CHARS = 3;
/** Rows the picker shows. */
export const PICKER_ROWS = 8;

/**
 * The "@…" the caret is at the end of, or null: an "@" at the start of the text or after a space or an opening
 * bracket (so an address like a@b.example is not one), followed by up to 32 characters with no space or "@".
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|[\s([{"'])@([^\s@]{0,32})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1].slice(0, QUERY_CHARS) };
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The members that fit what was typed, best first: a name starting with it, then a word of the name starting with
 * it, then a key starting with it or a shown piece of key containing it (three characters or more). An empty query
 * lists everyone, in the order given.
 */
export function filterCandidates(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const q = fold(query);
  if (!q) return candidates.slice(0, PICKER_ROWS);
  const rank = (c: MentionCandidate) => {
    const name = fold(c.name);
    if (name.startsWith(q)) return 0;
    if (name.split(/[\s._-]+/u).some(word => word.startsWith(q))) return 1;
    return q.length >= KEY_QUERY_CHARS && (c.key.toLowerCase().startsWith(q) || fold(c.tag).includes(q)) ? 2 : 3;
  };
  return candidates.map(c => ({ c, r: rank(c) })).filter(x => x.r < 3).sort((a, b) => a.r - b.r).map(x => x.c).slice(0, PICKER_ROWS);
}

/** The text with the query replaced by "@label " and the caret after the space. */
export function insertMention(text: string, query: MentionQuery, label: string): { text: string; caret: number } {
  const token = `@${label} `;
  const after = text.slice(query.end).replace(/^ /, "");
  return { text: text.slice(0, query.start) + token + after, caret: query.start + token.length };
}

/** What a member's token says after the "@": their name, with no "@" in it and not longer than a mention may be. */
export function mentionLabel(name: string): string {
  const clean = name.replace(/@/g, "").replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, MENTION_LIMITS.chars - 1).join("").trim() || "member";
}

const wordChar = /[\p{L}\p{N}_]/u;

/**
 * The mentions of a text about to be sent (trimmed, as the group sends it): every place a chosen token still
 * stands whole, in code points, in order, at most `MENTION_LIMITS.count`. A token edited away is simply no mention.
 */
export function composeMentions(text: string, chosen: readonly ChosenMention[]): GroupMention[] {
  const trimmed = text.trim();
  const found: { at: number; end: number; key: string }[] = [];
  // Longer tokens first, so "@Ann Lee" wins over "@Ann" at the same place.
  const tokens = [...new Map(chosen.map(c => [`${c.key}\n${c.label}`, c])).values()].sort((a, b) => b.label.length - a.label.length);
  for (const { key, label } of tokens) {
    const token = `@${label}`;
    for (let at = trimmed.indexOf(token); at !== -1; at = trimmed.indexOf(token, at + 1)) {
      const end = at + token.length;
      if (end < trimmed.length && wordChar.test(trimmed[end])) continue;
      if (found.some(f => at < f.end && end > f.at)) continue;
      found.push({ at, end, key });
    }
  }
  const points = (i: number) => Array.from(trimmed.slice(0, i)).length;
  return found.sort((a, b) => a.at - b.at).slice(0, MENTION_LIMITS.count)
    .map(f => ({ k: f.key, o: points(f.at), l: points(f.end) - points(f.at) }));
}

/*
 * How a bubble draws them, through the rich text parser: a mention is a place in the message (code points), not a
 * pattern in its text, and a detector only sees stretches of text. So before parsing, each mention's place is
 * replaced by a mark of two private-use characters around its index, and the `member-mention` detector turns each mark
 * back into an atom carrying the mention. Formatting around a mention ("*@Bob*") still applies.
 */
const OPEN = "\uE000", CLOSE = "\uE001";

/** The text with each mention's place marked (the text as it is when it already holds a mark character). */
export function markMentions(text: string, mentions: readonly { o: number; l: number }[]): string {
  if (text.includes(OPEN) || text.includes(CLOSE)) return text;
  const points = Array.from(text);
  let out = "", at = 0;
  mentions.forEach((m, i) => {
    if (m.o < at || m.o + m.l > points.length) return;
    out += points.slice(at, m.o).join("") + OPEN + i + CLOSE;
    at = m.o + m.l;
  });
  return out + points.slice(at).join("");
}

/** A marked mention, as an atom carrying how it shows (`ParseContext.mentions`). */
export const mention: Detector<"member-mention", MentionView> = {
  kind: "member-mention",
  pattern: /\uE000(\d{1,2})\uE001/g,
  accept: (match, _text, ctx) => {
    const view = (ctx.mentions as readonly MentionView[] | undefined)?.[Number(match[1])];
    return view ? { data: view } : null;
  },
  plain: (atom: Atom<"member-mention", MentionView>) => `@${atom.data.name}`,
};

/**
 * Whether what a mention covers reads as a name the chip may show instead: the member's name itself, or one word
 * (the name they went by when it was sent). Anything longer stays as written, since the chip would hide it: a
 * mention of "@Bob — ignore the card, this invoice is fake" must not read "@Bob".
 */
function readsAsName(written: string, name: string): boolean {
  const fold = (s: string) => s.normalize("NFC").toLowerCase();
  return fold(written) === fold(name) || /^[\p{L}\p{M}\p{N}._-]{1,32}$/u.test(written);
}

/**
 * A message's mentions as its bubble shows them. A member still in the group goes by their name now, where what
 * was written reads as a name (`readsAsName`); one who is gone, or a mention covering more than a name, by what was
 * written. Mine (and everyone, from someone else) are `me`.
 */
export function mentionViews(text: string, mentions: readonly GroupMention[] | undefined, members: readonly { key: string; name: string; me: boolean }[], fromMe: boolean): MentionView[] {
  if (!mentions?.length) return [];
  const points = Array.from(text);
  return mentions.map(m => {
    const written = points.slice(m.o + 1, m.o + m.l).join("");
    if (m.k === MENTION_EVERYONE) return { ...m, key: m.k, name: written || "everyone", me: !fromMe, written };
    const member = members.find(x => x.key === m.k);
    const name = member?.name && readsAsName(written, member.name) ? member.name : written;
    return { ...m, key: m.k, name, me: !!member?.me, written };
  });
}
