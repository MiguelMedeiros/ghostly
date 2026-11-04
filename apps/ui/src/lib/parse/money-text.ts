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

/** The web links of the last text asked about, as [start, end) in order: every scanner asks once per word it found. */
let urlSpans: { text: string; spans: [number, number][] } | null = null;

/**
 * Whether `index` falls inside a web link (`https://mempool.space/address/bc1q…`): an address there is part of
 * the link, which stays a link, not money. The links are found once per text, so a message full of words that look
 * like money costs its length, not its length per word.
 */
export function insideUrl(text: string, index: number): boolean {
  if (urlSpans?.text !== text) {
    const spans: [number, number][] = [];
    for (const url of text.matchAll(/\bhttps?:\/\/\S+/gi)) spans.push([url.index!, url.index! + url[0].length]);
    urlSpans = { text, spans };
  }
  const { spans } = urlSpans;
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (spans[mid][1] <= index) low = mid + 1;
    else high = mid;
  }
  return low < spans.length && spans[low][0] <= index;
}
