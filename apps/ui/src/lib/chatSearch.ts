import { foldText } from "@ghostly/browser/shared/fold";
import { englishT, type Translate } from "../locales/translate";
import { parseMessage, type Block, type ListBlock, type MdLinkData, type Segment } from "./parse";
import { markMentions, type MentionView } from "./parse/mentions";
import type { ChatFile, ChatMessage } from "./types";

/**
 * Search inside a chat: only what this device keeps of it, never the network. A message's text as it reads (its
 * formatting's markers left out), or a file's name for a
 * file (not the line its message carries), matched whatever the case and the accents ("cafe" finds "Café"). A voice
 * message, a video or a picture is also found by what it is, in the profile's language and in English: the recorder
 * names a voice message in English ("Voice message …webm"), and a Portuguese profile looks for "voz".
 */

/** A message as search reads it: its text already folded, once per search session rather than once per keystroke. */
export interface Searchable {
  id: string;
  folded: string;
}

/** Lower case, accents off: "Ação" reads "acao". The engine's chat search folds the same way (`chatsFound`). */
export { foldText };

/** A character that may start inline formatting or a `[label](link)`: a text without one reads as it is written. */
const MARKUP = /[*_~|`[]/;

/**
 * A text as its bubble reads (lib/parse), so "**hello** world" is found by "hello world" and not by "**". A spoiler's
 * words count (they show once tapped); a `[label](link)` is found by its label in place and by its address, after the
 * rest, so the address never runs into the words around the label.
 */
function shownText(text: string, mentions?: readonly MentionView[]): string {
  if (!mentions?.length && !MARKUP.test(text)) return text;
  // A group message's mentions read as its bubble shows them, "@" and the member's name now (parse/mentions).
  const key = mentions?.length ? [text, ...mentions.map(m => `${m.o}:${m.l}:${m.name}`)].join("\u0000") : text;
  let shown = shownCache.get(key);
  if (shown === undefined) {
    // An open search folds the chat again for each message that comes: a formatted text is parsed once, not each time.
    if (shownCache.size >= SHOWN_CACHE_MAX) shownCache.clear();
    shown = parsedText(text, mentions);
    shownCache.set(key, shown);
  }
  return shown;
}
const SHOWN_CACHE_MAX = 20_000;
const shownCache = new Map<string, string>();

function parsedText(text: string, mentions?: readonly MentionView[]): string {
  const links: string[] = [];
  const segments = (list: readonly Segment[]): string => list.map((segment) => {
    if (segment.type === "span") return segments(segment.children);
    if (segment.type === "atom" && segment.kind === "member-mention") return `@${(segment.data as MentionView).name}`;
    if (segment.type !== "atom" || segment.kind !== "md-link") return segment.text;
    const data = segment.data as MdLinkData;
    links.push(data.url);
    return segments(data.label);
  }).join("");
  const list = (part: ListBlock): string => part.items.map((item) => [`${item.marker} ${segments(item.segments)}`, ...item.children.map(list)].join("\n")).join("\n");
  const block = (part: Block): string => {
    switch (part.type) {
      case "codeblock": return part.code;
      case "paragraph": case "heading": return segments(part.segments);
      case "quote": return part.blocks.map(block).join("\n");
      case "list": return list(part);
    }
  };
  const blocks = mentions?.length ? parseMessage(markMentions(text, mentions), { mentions }) : parseMessage(text);
  return [...blocks.map(block), ...links].join("\n");
}

/** A file's kind in words, the same the app shows for it: a voice message, a video, a picture; none for other files. */
export function fileKindWords(file: ChatFile, t: Translate): string | undefined {
  if (file.voice) return t("chat.voice.message");
  if (file.video) return t("messageDetails.label.video");
  if (file.mime.startsWith("image/")) return t("messageDetails.kind.picture");
  return undefined;
}

/**
 * A received text's translation where its bubble shows one in place of the text (hooks/useTranslation.ts
 * `useShownTranslations`): search finds the words on screen, and the bubble marks them there.
 */
export type TranslatedText = (message: ChatMessage) => string | undefined;

/**
 * What a message offers search: a file's name and its kind in `t`'s language and in English, a text's text as its
 * bubble shows it (`translated`, where it is shown translated; a group's mentions by the names they show); nothing for
 * notices, call lines and payments.
 */
export function searchText(message: ChatMessage, t: Translate = englishT, translated?: TranslatedText): string | undefined {
  if (message.sender === "system" || message.systemEvent || message.callEvent || message.paymentId) return undefined;
  if (!message.file) {
    const translation = translated?.(message);
    return translation !== undefined ? shownText(translation) : shownText(message.text, message.mentions);
  }
  const words = new Set([fileKindWords(message.file, t), fileKindWords(message.file, englishT)]);
  return [message.file.name, ...words].filter(Boolean).join("\n");
}

/** The messages that can be found, in the timeline's order, folded. */
export function searchable(messages: readonly ChatMessage[], t: Translate = englishT, translated?: TranslatedText): Searchable[] {
  const out: Searchable[] = [];
  for (const message of messages) {
    const text = searchText(message, t, translated);
    if (text) out.push({ id: message.id, folded: foldText(text) });
  }
  return out;
}

/** The ids of the messages that hold `query`, newest first. */
export function searchMessages(items: readonly Searchable[], query: string): string[] {
  const needle = foldText(query.trim());
  if (!needle) return [];
  const found: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].folded.includes(needle)) found.push(items[i].id);
  return found;
}

/** Where `query` is in `text` as written, `[from, to)` each: for marking the matches in a bubble. */
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = foldText(query.trim());
  if (!needle) return [];
  // The folded text, and for each of its units the place in `text` of the character it came from.
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length;) {
    const size = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    const part = foldText(text.slice(i, i + size));
    folded += part;
    for (let j = 0; j < part.length; j++) from.push(i);
    i += size;
  }
  const ranges: [number, number][] = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    const last = from[at + needle.length - 1];
    let end = last + ((text.codePointAt(last) ?? 0) > 0xffff ? 2 : 1);
    // A combining accent after the last letter goes with it.
    while (end < text.length && foldText(text[end]) === "") end++;
    ranges.push([from[at], end]);
  }
  return ranges;
}
