import { DETECTORS } from "./detectors";
import { tokenizeInline } from "./inline";
import { prettyJson } from "./json";
import type { Block, Detector, ListBlock, ListItem, ParseContext } from "./types";

/** What may follow an opening fence as a language name ("```ts", "```c++", "```objective-c"). */
const LANG = /^[A-Za-z][\w+#.-]{0,19}$/;

/**
 * A list item's line: an indent, then `-`, `*` or `•`, or a number (at most 9 digits) with `.` or `)`, then a space
 * and something. "1.5 kg" and "-5 °C" are not items: the marker needs the space.
 */
const ITEM = /^( {0,6}|\t)(?:([-*\u2022])|(\d{1,9})([.)])) +(?=\S)/;
/** How far in an item's line starts for it to sit under the item before it (one level; deeper counts the same). */
const NESTED = 2;
/** A quote's line: `>` then a space, or `>` alone (an empty line of the quote). */
const QUOTE = /^ {0,3}>(?: |$)/;
const HEADING = /^(#{1,3}) +(?=\S)/;
const BLANK = /^\s*$/;

/**
 * The lines of text outside code as blocks: lists, quotes and headings where a line starts with one, paragraphs for
 * the rest. Text with none of them is one paragraph, exactly as written. A blank line next to a list, a quote or a
 * heading is the room around it, which the block's own margin gives, so it goes; the line break between them goes
 * too, the way the one before a fence does. Each line is read once here (twice inside a quote), so this stays linear.
 */
function proseBlocks(text: string, detectors: readonly Detector[], ctx: ParseContext, quotes: boolean): Block[] {
  const inline = (s: string) => tokenizeInline(s, detectors, ctx);
  type Unit = { t: "para"; lines: string[] } | { t: "block"; block: Block } | { t: "quote"; lines: string[]; raw: string[] };
  const units: Unit[] = [];
  const lines = text.split("\n");
  // The list being read, its last item (text still open to continuation lines) and that item's last child.
  let list: ListBlock | null = null;
  let item: { at: ListItem; text: string[] } | null = null;
  let child: { list: ListBlock; at: ListItem; text: string[] } | null = null;
  const closeChild = () => { if (child) { child.at.segments = inline(child.text.join("\n")); child = null; } };
  const closeItem = () => { closeChild(); if (item) { item.at.segments = inline(item.text.join("\n")); item = null; } };
  const closeList = () => { closeItem(); list = null; };
  const last = () => units[units.length - 1];

  for (const line of lines) {
    const m = ITEM.exec(line);
    if (m) {
      const ordered = m[3] !== undefined;
      const at: ListItem = { marker: ordered ? m[3] + m[4] : "\u2022", ...(ordered ? { number: Number(m[3]) } : {}), segments: [], children: [] };
      const body = line.slice(m[0].length);
      const indent = m[1] === "\t" ? NESTED : m[1].length;
      if (list && item && indent >= NESTED) {
        closeChild();
        const kids = item.at.children;
        let under = kids[kids.length - 1];
        if (!under || under.ordered !== ordered) kids.push(under = { type: "list", ordered, items: [] });
        under.items.push(at);
        child = { list: under, at, text: [body] };
        continue;
      }
      if (!list || list.ordered !== ordered) {
        closeList();
        list = { type: "list", ordered, items: [] };
        units.push({ t: "block", block: list });
      }
      closeItem();
      list.items.push(at);
      item = { at, text: [body] };
      continue;
    }
    // An indented line under an item goes on with it, as a line of its own.
    if (item && /^(?: {2}|\t)/.test(line) && !BLANK.test(line)) {
      (child ?? item).text.push(line.trimStart());
      continue;
    }
    closeList();
    if (quotes && QUOTE.test(line)) {
      const inner = line.replace(/^ {0,3}> ?/, "");
      const unit = last();
      if (unit?.t === "quote") { unit.lines.push(inner); unit.raw.push(line); }
      else units.push({ t: "quote", lines: [inner], raw: [line] });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      units.push({ t: "block", block: { type: "heading", level: h[1].length as 1 | 2 | 3, segments: inline(line.slice(h[0].length)) } });
      continue;
    }
    const unit = last();
    if (unit?.t === "para") unit.lines.push(line);
    else units.push({ t: "para", lines: [line] });
  }
  closeList();

  // A quote with nothing in it (">" alone) is the text it was, one paragraph with the lines around it.
  const merged: Unit[] = [];
  for (const unit of units) {
    const now: Unit = unit.t === "quote" && unit.lines.every((l) => BLANK.test(l)) ? { t: "para", lines: unit.raw } : unit;
    const before = merged[merged.length - 1];
    if (now.t === "para" && before?.t === "para") before.lines.push(...now.lines);
    else merged.push(now);
  }

  const blocks: Block[] = [];
  merged.forEach((unit, i) => {
    if (unit.t === "block") { blocks.push(unit.block); return; }
    if (unit.t === "quote") {
      blocks.push({ type: "quote", blocks: proseBlocks(unit.lines.join("\n"), detectors, ctx, false) });
      return;
    }
    let { lines: body } = unit;
    let from = 0;
    let to = body.length;
    if (i > 0) while (from < to && BLANK.test(body[from])) from++;
    if (i < merged.length - 1) while (to > from && BLANK.test(body[to - 1])) to--;
    body = body.slice(from, to);
    const joined = body.join("\n");
    if (joined) blocks.push({ type: "paragraph", segments: inline(joined) });
  });
  return blocks;
}

/**
 * A message's text as blocks. A message that is JSON is one pretty-printed block. Otherwise a fence (```) at the
 * start of a line opens a code block, with an optional language name after it, and the next ``` closes it; a fence
 * that never closes is text. Everything else is lists, quotes, headings and paragraphs of inline segments
 * (`proseBlocks`, then `tokenizeInline`).
 */
export function parseMessage(text: string, ctx: ParseContext = {}, detectors: readonly Detector[] = DETECTORS): Block[] {
  const json = prettyJson(text);
  if (json !== null) return [{ type: "codeblock", code: json, lang: "json" }];

  const blocks: Block[] = [];
  const paragraph = (from: number, to: number) => {
    if (to > from) blocks.push(...proseBlocks(text.slice(from, to), detectors, ctx, true));
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
