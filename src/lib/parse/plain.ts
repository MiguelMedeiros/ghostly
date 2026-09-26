import { parseMessage } from "./blocks";
import { DETECTORS } from "./detectors";
import { prettyJson } from "./json";
import type { Atom, Detector, ParseContext, Segment } from "./types";

/** What a spoiler reads as where it cannot be tapped: nothing of what it hides. */
export const SPOILER_PLAIN = "▒▒▒";

function segmentsText(segments: Segment[], detectors: readonly Detector[]): string {
  let out = "";
  for (const segment of segments) {
    if (segment.type === "text" || segment.type === "code") out += segment.text;
    else if (segment.type === "span") out += segment.style === "spoiler" ? SPOILER_PLAIN : segmentsText(segment.children, detectors);
    else out += detectors.find((d) => d.kind === segment.kind)?.plain?.(segment as Atom) ?? segment.text;
  }
  return out;
}

/** The message as plain text, markers stripped and spoilers hidden: the chat list's one-line preview. */
export function plainText(text: string, ctx: ParseContext = {}, detectors: readonly Detector[] = DETECTORS): string {
  // JSON reads best on one line as it was written, not as the bubble's indented block.
  if (prettyJson(text) !== null) return text.trim();
  return parseMessage(text, ctx, detectors)
    .map((block) => (block.type === "codeblock" ? block.code : segmentsText(block.segments, detectors)))
    .join("\n");
}
