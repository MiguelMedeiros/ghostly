import type { GroupMention } from "@ghostly/core";
import { composeMentions } from "./parse/mentions";
import { detectableText, DETECT_CHARS, MIN_LETTERS, MIN_PROBABILITY, type DetectLanguages } from "./translateWhich";

/*
 * A draft translated before it is sent (docs/AUTO-TRANSLATE.md § Outgoing translation). Pure: the translation itself
 * is passed in. Only the words are translated: code, links, mentions, Cashu tokens, invoices and other long keys are
 * kept exactly as typed, and each line goes on its own, so the message keeps its shape.
 */

/** What the draft is made of, in order: words to translate, and what stays as typed between them. */
export type DraftPart = { kind: "words"; text: string } | { kind: "kept"; text: string };

/** Code blocks, inline code, links and payment URIs, Cashu tokens, Lightning invoices, and any long run with a digit (a key, an address). */
const KEPT = new RegExp([
  "```[\\s\\S]*?(?:```|$)",
  "`[^`\\n]+`",
  "\\b(?:https?:\\/\\/|www\\.)\\S+",
  "\\b(?:lightning|bitcoin|cashu|nostr|ghostly|mailto|lnurl):\\S+",
  "\\bcashu[AB][A-Za-z0-9_+/=-]+",
  "\\b(?:lnbc|lntb|lntbs|lnbcrt|lnurl)[0-9a-z]{10,}",
  "(?=[A-Za-z0-9_+/=:.-]*\\d)[A-Za-z0-9_+/=:.-]{20,}",
].join("|"), "gi");

const LETTER = /\p{L}/u;

/** `text` cut into words and kept runs; `mentions` (by code points, as a group sends them) are kept too. */
export function draftParts(text: string, mentions: readonly { o: number; l: number }[] = []): DraftPart[] {
  // Every kept range in UTF-16 indices: the mentions' first, then whatever the patterns find outside them.
  const points = Array.from(text);
  const unit = (point: number) => points.slice(0, point).join("").length;
  const kept: [number, number][] = mentions.map(({ o, l }) => [unit(o), unit(o + l)]);
  for (const found of text.matchAll(KEPT)) {
    const at = found.index, end = at + found[0].length;
    if (!kept.some(([from, to]) => at < to && end > from)) kept.push([at, end]);
  }
  kept.sort((a, b) => a[0] - b[0]);

  const parts: DraftPart[] = [];
  const push = (kind: DraftPart["kind"], piece: string) => {
    if (!piece) return;
    const last = parts[parts.length - 1];
    if (last?.kind === kind && kind === "kept") last.text += piece;
    else parts.push({ kind, text: piece });
  };
  /** Words, line by line; the spaces and line breaks around them, and lines without a letter, stay as typed. */
  const words = (piece: string) => {
    for (const line of piece.split(/(\n)/)) {
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line)!;
      push("kept", lead);
      push(LETTER.test(core) ? "words" : "kept", core);
      push("kept", trail);
    }
  };
  let at = 0;
  for (const [from, to] of kept) {
    words(text.slice(at, from));
    push("kept", text.slice(from, to));
    at = to;
  }
  words(text.slice(at));
  return parts;
}

/** The draft with its words replaced by `translated` (one per words part, in order). */
export function joinParts(parts: readonly DraftPart[], translated: readonly string[]): string {
  let next = 0;
  return parts.map((part) => part.kind === "words" ? translated[next++] ?? part.text : part.text).join("");
}

/**
 * `text` (`parts`) translated by `translate`, which takes the words and gives them back in the same order. A draft
 * with no words gives itself back without asking.
 */
export async function translateDraft(parts: readonly DraftPart[], translate: (texts: string[]) => Promise<string[]>): Promise<string> {
  const words = parts.filter((part) => part.kind === "words").map((part) => part.text);
  if (!words.length) return joinParts(parts, []);
  return joinParts(parts, await translate(words));
}

/**
 * The group members `named` in `draft` named in `sent` too, wherever the translation (or an edit of it) put them:
 * each mention's "@Name" is kept as typed, so it is found again by its words.
 */
export function carryMentions(draft: string, named: readonly GroupMention[], sent: string): GroupMention[] {
  if (!named.length) return [];
  const points = Array.from(draft.trim());
  const chosen = named.map(({ k, o, l }) => ({ key: k, label: points.slice(o, o + l).join("").replace(/^@/, "") }));
  return composeMentions(sent, chosen);
}

const baseCode = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/**
 * The language the draft is written in, when the detector is sure of it; null when it cannot tell (a few letters,
 * slang, a mix). `undefined` when there are no words to translate at all.
 */
export async function draftLanguage(text: string, detect: DetectLanguages, mentions: readonly { o: number; l: number }[] = []): Promise<string | null | undefined> {
  const words = detectableText(text, mentions);
  const letters = words.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return undefined;
  if (letters < MIN_LETTERS) return null;
  const top = (await detect(words.slice(0, DETECT_CHARS)))[0];
  if (!top || top.probability < MIN_PROBABILITY) return null;
  const code = baseCode(top.code);
  return code === "und" ? null : code;
}
