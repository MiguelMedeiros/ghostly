import { parseMessage, prettyJson, type Block, type Segment } from "./parse";
import type { Language } from "./settings";
import type { ChatMessage } from "./types";

/*
 * Which received messages are translated, and from which language (docs/AUTO-TRANSLATE.md § Source language). Pure:
 * the detector is passed in, so this file decides and never loads it. The detector is unreliable on short or slangy
 * text ("ok" is undetermined, "lol no way 😂" came out as Volapük), hence the rules: only received text, only what
 * the detector is sure of, never the app's own language, and never a few letters on their own.
 */

/** One of the detector's guesses, best first: `@qvac/langdetect-text`'s `detectMultiple` gives these. */
export interface LanguageGuess {
  /** ISO 639-1, or `und` when it cannot tell. */
  code: string;
  probability: number;
}

export type DetectLanguages = (text: string) => readonly LanguageGuess[] | Promise<readonly LanguageGuess[]>;

export interface TranslateWhichOptions {
  /** What received messages are translated into. */
  appLanguage: Language;
  detect: DetectLanguages;
  /** Whether a model exists from `language` (straight into the app's language, or through English). */
  canTranslate: (language: string) => boolean;
  /** The last language the others in this chat wrote with confidence: what a short message is taken to be in. */
  chatLanguage?: string | null;
}

export interface TranslateWhich {
  /** The language to translate the message from, or null: it is shown as it was sent. */
  from: string | null;
  /** The message's language when the detector was sure of it, the app's own included: what the chat remembers. */
  detected: string | null;
}

/** Fewer letters than this, once emoji, links, numbers and mentions are out, and the detector is not asked. */
export const MIN_LETTERS = 4;
/** The detector's top guess below this probability is no answer. */
export const MIN_PROBABILITY = 0.5;
/** How much of a long message the detector reads: its language shows long before, and the cost grows with it. */
export const DETECT_CHARS = 2_000;

const UNDETERMINED = "und";
const NONE: TranslateWhich = { from: null, detected: null };

/** A run of letters, digits and token characters with a digit in it: a number, a token, an invoice, an address, a code. */
const CODE_RUN = /[A-Za-z0-9_+/=:.-]*\d[A-Za-z0-9_+/=:.-]*|\p{N}+/gu;
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️/gu;
const LETTER = /\p{L}/gu;

function segmentsText(segments: readonly Segment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "span") return segmentsText(segment.children);
    // Code, links and the other atoms (long keys, times, mentions) are never translated, so they say nothing of the language.
    return " ";
  }).join("");
}

function blockText(block: Block): string {
  switch (block.type) {
    case "codeblock": return " ";
    case "paragraph":
    case "heading": return segmentsText(block.segments);
    case "quote": return block.blocks.map(blockText).join(" ");
    case "list": return block.items.map((item) => [segmentsText(item.segments), ...item.children.map(blockText)].join(" ")).join(" ");
  }
}

/**
 * What of `text` is language, as the detector reads it: without code, links, mentions (`mentions`, by their place in
 * code points), numbers and tokens, and emoji; one space between words. A message that is JSON has none.
 */
export function detectableText(text: string, mentions: readonly { o: number; l: number }[] = []): string {
  if (prettyJson(text) !== null) return "";
  let unmentioned = text;
  if (mentions.length) {
    const points = Array.from(text);
    for (const { o, l } of mentions) points.fill(" ", o, Math.min(o + l, points.length));
    unmentioned = points.join("");
  }
  return parseMessage(unmentioned).map(blockText).join(" ")
    .replace(CODE_RUN, " ")
    .replace(EMOJI, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const baseCode = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/**
 * Whether `message` is translated for reading, and from which language. Only text a contact or member sent: never
 * mine, a system line, a file, a payment, a status card or a call line. A short message (under `MIN_LETTERS`) is
 * taken to be in the chat's language, when it has one; anything else in what the detector is sure of. The app's
 * language and a language with no model are shown as they are.
 */
export async function translateFrom(
  message: Pick<ChatMessage, "sender" | "text" | "file" | "paymentId" | "card" | "callEvent" | "systemEvent" | "mentions">,
  { appLanguage, detect, canTranslate, chatLanguage }: TranslateWhichOptions,
): Promise<TranslateWhich> {
  if (message.sender !== "peer") return NONE;
  if (message.file || message.paymentId || message.card || message.callEvent || message.systemEvent) return NONE;

  const text = detectableText(message.text, message.mentions);
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return NONE;
  const usable = (language: string | null | undefined) =>
    language && language !== UNDETERMINED && language !== appLanguage && canTranslate(language) ? language : null;
  if (letters < MIN_LETTERS) return { from: usable(chatLanguage && baseCode(chatLanguage)), detected: null };

  const top = (await detect(text.slice(0, DETECT_CHARS)))[0];
  if (!top || top.probability < MIN_PROBABILITY) return NONE;
  const detected = baseCode(top.code);
  if (detected === UNDETERMINED) return NONE;
  return { from: usable(detected), detected };
}
