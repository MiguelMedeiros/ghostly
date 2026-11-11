import type { ReactNode } from "react";
import { INVISIBLE } from "../../lib/parse/links";
import { Marked } from "../chat/ChatSearch";

const HAS_INVISIBLE = new RegExp(INVISIBLE.source, "u");
const EACH_INVISIBLE = new RegExp(`(${INVISIBLE.source})`, "u");

/** Whether `text` holds a direction control or another character that draws nothing (links.ts `INVISIBLE`). */
export function holdsInvisible(text: string): boolean {
  return HAS_INVISIBLE.test(text);
}

/**
 * Code's `text` as drawn: each direction control and invisible character as a muted `<U+202E>`, so none of them can
 * reorder or hide what is drawn and the code reads in the order it is copied; the rest as is, with what falls in it
 * of a chat search's `ranges` (counted from `start`, the markers over their character) marked.
 */
export function showInvisible(text: string, start = 0, ranges: readonly [number, number][] = []): ReactNode {
  if (!holdsInvisible(text)) return ranges.length ? <Marked text={text} start={start} ranges={ranges} /> : text;
  const parts: ReactNode[] = [];
  let at = start;
  text.split(EACH_INVISIBLE).forEach((part, i) => {
    if (i % 2) {
      const point = part.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      parts.push(<span key={i} className="rich-hidden-char">{`<U+${point}>`}</span>);
    } else if (part) parts.push(ranges.length ? <Marked key={i} text={part} start={at} ranges={ranges} /> : part);
    at += part.length;
  });
  return parts;
}
