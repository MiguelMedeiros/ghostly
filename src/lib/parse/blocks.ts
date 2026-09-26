import { DETECTORS } from "./detectors";
import { tokenizeInline } from "./inline";
import { prettyJson } from "./json";
import type { Block, Detector, ParseContext } from "./types";

/** What may follow an opening fence as a language name ("```ts", "```c++", "```objective-c"). */
const LANG = /^[A-Za-z][\w+#.-]{0,19}$/;

/**
 * A message's text as blocks. A message that is JSON is one pretty-printed block. Otherwise a fence (```) at the
 * start of a line opens a code block, with an optional language name after it, and the next ``` closes it; a fence
 * that never closes is text. Everything else is paragraphs of inline segments (see `tokenizeInline`).
 */
export function parseMessage(text: string, ctx: ParseContext = {}, detectors: readonly Detector[] = DETECTORS): Block[] {
  const json = prettyJson(text);
  if (json !== null) return [{ type: "codeblock", code: json, lang: "json" }];

  const blocks: Block[] = [];
  const paragraph = (from: number, to: number) => {
    if (to > from) blocks.push({ type: "paragraph", segments: tokenizeInline(text.slice(from, to), detectors, ctx) });
  };
  const fence = /(^|\n)```/g;
  let cursor = 0;
  for (let found = fence.exec(text); found; found = fence.exec(text)) {
    const open = found.index + found[1].length;
    if (open < cursor) continue;
    const lineEnd = text.indexOf("\n", open);
    // "```code```" on one line is inline code, not a block.
    if (lineEnd < 0) break;
    const info = text.slice(open + 3, lineEnd).trim();
    const lang = LANG.test(info) ? info.toLowerCase() : undefined;
    // Without a language name, what follows the fence is the code's first line (the way chat apps write it).
    const start = lang || !info ? lineEnd + 1 : open + 3;
    const close = text.indexOf("```", start);
    // No closing fence anywhere after this one: none of the later ones closes either.
    if (close < 0) break;
    let code = text.slice(start, close);
    if (code.endsWith("\n")) code = code.slice(0, -1);
    if (!code.trim()) { fence.lastIndex = close; continue; }
    // The line break before the fence belongs to the block.
    paragraph(cursor, found.index);
    blocks.push({ type: "codeblock", code, ...(lang ? { lang } : {}) });
    // The next fence may start on the very next line: look from the line break, which the pattern needs.
    fence.lastIndex = close + 3;
    cursor = close + 3;
    if (text[cursor] === "\n") cursor++;
  }
  paragraph(cursor, text.length);
  return blocks;
}
