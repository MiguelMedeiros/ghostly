import type { ChatMessage } from "./types";

/**
 * Search inside a chat: only what this device keeps of it, never the network. A message's text, or a file's name for a
 * file (not the line its message carries), matched whatever the case and the accents ("cafe" finds "Café").
 */

/** A message as search reads it: its text already folded, once per search session rather than once per keystroke. */
export interface Searchable {
  id: string;
  folded: string;
}

/** Lower case, accents off: "Ação" reads "acao". */
export function foldText(text: string): string {
  return text.normalize("NFD").toLowerCase().replace(/\p{M}/gu, "");
}

/** What a message offers search: a file's name, a text's text; nothing for notices, call lines and payments. */
export function searchText(message: ChatMessage): string | undefined {
  if (message.sender === "system" || message.systemEvent || message.callEvent || message.paymentId) return undefined;
  return message.file ? message.file.name : message.text;
}

/** The messages that can be found, in the timeline's order, folded. */
export function searchable(messages: readonly ChatMessage[]): Searchable[] {
  const out: Searchable[] = [];
  for (const message of messages) {
    const text = searchText(message);
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
