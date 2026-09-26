/**
 * What a message's text is made of, once parsed: blocks (paragraphs and fenced code), and inside a paragraph the
 * segments a renderer draws. Nothing here is HTML: every segment carries plain text, and the renderer builds
 * elements from it.
 */

/** A styled stretch of text: `*bold*`, `_italic_`, `~~strike~~`, `||spoiler||`. */
export type SpanStyle = "bold" | "italic" | "strike" | "spoiler";

/**
 * Something a detector recognised in the text (a link, a timestamp, a long key…). `text` is exactly what was
 * written, so a renderer that does not know the kind shows it unchanged; `data` is the detector's own.
 */
export interface Atom<K extends string = string, D = unknown> {
  type: "atom";
  kind: K;
  text: string;
  data: D;
}

export type Segment =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "span"; style: SpanStyle; children: Segment[] }
  | Atom;

export type Block =
  | { type: "paragraph"; segments: Segment[] }
  /** `lang` is what followed the opening fence, lower-cased, when it looks like a language name. */
  | { type: "codeblock"; code: string; lang?: string };

/** What a detector may know about the message beyond its text. */
export interface ParseContext {
  /** When the message was sent (ms): "at 14:00 UTC" means that day's 14:00. */
  sentAt?: number;
  /** A group message's mentions, by the index their marks carry (mentions.ts). */
  mentions?: readonly { key: string; name: string; me: boolean }[];
}

/**
 * An inline detector: recognises atoms in the text outside code. Adding one is one line in `detectors.ts`
 * (and, for a custom look, one line in `src/components/rich/views.ts`).
 */
export interface Detector<K extends string = string, D = unknown> {
  kind: K;
  /**
   * A global (`g`) pattern, run from left to right over each stretch of text outside code. Keep it linear: no
   * nested quantifiers, bounded repetition where a class can overlap. Any flags besides `g` are kept.
   */
  pattern: RegExp;
  /**
   * The match as an atom, or null to leave it as text. `end` (absolute, at most the match's end) shortens it,
   * the way a link leaves its trailing full stop out.
   */
  accept(match: RegExpExecArray, text: string, ctx: ParseContext): { data: D; end?: number } | null;
  /** How the atom reads in a one-line preview (the chat list). The written text when left out. */
  plain?(atom: Atom<K, D>): string;
}
