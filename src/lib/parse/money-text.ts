import { linkEnd } from "@ghostly/core";

/** The message without what was found in it, for the text shown above the card. */
export function cut(text: string, index: number, length: number): string {
  return (text.slice(0, index) + text.slice(index + length)).trim();
}

/** Characters of a payment link worth reading: longer is no link anyone shares, and is left as text. */
export const URI_MAX_CHARS = 4 * 1024;

/**
 * A link's own characters, without the sentence's closing punctuation or an unbalanced bracket around it (the web
 * links' rule, linear however many ")" end it).
 */
export const trimUriEnd = linkEnd;

/**
 * Whether `index` falls inside a web link (`https://mempool.space/address/bc1q…`): an address there is part of
 * the link, which stays a link, not money.
 */
export function insideUrl(text: string, index: number): boolean {
  for (const url of text.matchAll(/\bhttps?:\/\/\S+/gi)) {
    if (index >= url.index! && index < url.index! + url[0].length) return true;
  }
  return false;
}
