import { parseMessage } from "./blocks";
import { DETECTORS } from "./detectors";
import { SPOILER_PLAIN } from "./inline";
import { prettyJson } from "./json";
import type { Atom, Block, Detector, ListBlock, ParseContext, Segment } from "./types";

export { SPOILER_PLAIN };

function segmentsText(segments: Segment[], detectors: readonly Detector[]): string {
  let out = "";
  for (const segment of segments) {
    if (segment.type === "text" || segment.type === "code") out += segment.text;
    else if (segment.type === "span") out += segment.style === "spoiler" ? SPOILER_PLAIN : segmentsText(segment.children, detectors);
    else out += detectors.find((d) => d.kind === segment.kind)?.plain?.(segment as Atom) ?? segment.text;
  }
  return out;
}

function blockText(block: Block, detectors: readonly Detector[]): string {
  switch (block.type) {
    case "codeblock": return block.code;
    case "paragraph":
    case "heading": return segmentsText(block.segments, detectors);
    case "quote": return block.blocks.map((inner) => blockText(inner, detectors)).join("\n");
    case "list": return listText(block, detectors, "");
  }
}

/** A list keeps its markers ("•" for any bullet, the author's numbers), and what sits under an item is indented. */
function listText(list: ListBlock, detectors: readonly Detector[], indent: string): string {
  return list.items.map((item) => [
    `${indent}${item.marker} ${segmentsText(item.segments, detectors)}`,
    ...item.children.map((child) => listText(child, detectors, indent + "  ")),
  ].join("\n")).join("\n");
}

/** The message as plain text, markers stripped and spoilers hidden: the chat list's one-line preview. */
export function plainText(text: string, ctx: ParseContext = {}, detectors: readonly Detector[] = DETECTORS): string {
  // JSON reads best on one line as it was written, not as the bubble's indented block.
  if (prettyJson(text) !== null) return text.trim();
  return parseMessage(text, ctx, detectors).map((block) => blockText(block, detectors)).join("\n");
}
