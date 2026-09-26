import type { Detector, ParseContext, Segment, SpanStyle } from "./types";

/**
 * The inline tokenizer: a paragraph's text in, segments out. Three passes, each linear in the text:
 *
 * 1. `code`: backtick spans (a run of N backticks up to the next run of exactly N on the same line). What is
 *    inside is never read again: no links, no markers.
 * 2. Detectors, over the text between code spans: links, long blobs, times, and whatever other cards register.
 *    What they recognise is opaque too, so a `*` or `_` inside a URL stays part of it.
 * 3. Markers, over what is left: `*bold*` (or `**bold**`), `_italic_` (or `__italic__`), `~~strike~~` and
 *    `||spoiler||`, paired within a line. A marker opens after a space, a punctuation mark or the start, before
 *    something that is not a space, and closes the other way round, so `snake_case_name`, `2*3*4` and
 *    `__init__.py` stay text. Openers left unclosed, and closers with no opener, are text too.
 */

/** Which runs of marker characters mean something, and what. A run of any other length is text. */
const MARKERS: Record<string, SpanStyle> = { "*": "bold", "**": "bold", "_": "italic", "__": "italic", "~~": "strike", "||": "spoiler" };
const MARKER_CHARS = new Set(["*", "_", "~", "|"]);

/** Punctuation or a symbol: what a marker may lean on besides a space. */
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
const WORD = /[\p{L}\p{N}]/u;

const compiled = new WeakMap<Detector, RegExp>();
function patternOf(detector: Detector): RegExp {
  let re = compiled.get(detector);
  if (!re) {
    const { source, flags } = detector.pattern;
    re = new RegExp(source, flags.includes("g") ? flags : flags + "g");
    compiled.set(detector, re);
  }
  return re;
}

type Found = { start: number; end: number; data: unknown };

/** The detector's next accepted match in `text` at or after `from`. */
function findNext(detector: Detector, text: string, from: number, ctx: ParseContext): Found | null {
  const re = patternOf(detector);
  let at = from;
  while (at <= text.length) {
    re.lastIndex = at;
    const match = re.exec(text);
    if (!match) return null;
    const accepted = match[0] ? detector.accept(match, text, ctx) : null;
    const matchEnd = match.index + match[0].length;
    if (accepted) {
      const end = Math.min(accepted.end ?? matchEnd, matchEnd);
      if (end > match.index) return { start: match.index, end, data: accepted.data };
    }
    at = Math.max(matchEnd, match.index + 1);
  }
  return null;
}

type Item = { t: "text"; s: string } | { t: "seg"; seg: Segment } | Mark;
interface Mark { t: "mark"; run: string; canOpen: boolean; canClose: boolean; pair?: "open" | "close" }

/** Pass 2: the detectors' atoms in a stretch of text outside code, and the text between them. */
function detect(text: string, detectors: readonly Detector[], ctx: ParseContext, out: (string | Segment)[]) {
  const next = detectors.map((d) => findNext(d, text, 0, ctx));
  let cursor = 0;
  for (;;) {
    let best = -1;
    for (let i = 0; i < next.length; i++) {
      const found = next[i];
      if (found && (best < 0 || found.start < next[best]!.start)) best = i;
    }
    if (best < 0) break;
    const found = next[best]!;
    if (found.start > cursor) out.push(text.slice(cursor, found.start));
    const detector = detectors[best];
    out.push({ type: "atom", kind: detector.kind, text: text.slice(found.start, found.end), data: found.data });
    cursor = found.end;
    // Whatever started inside the atom is gone; look again from its end.
    for (let i = 0; i < next.length; i++) if (next[i] && next[i]!.start < cursor) next[i] = findNext(detectors[i], text, cursor, ctx);
  }
  if (cursor < text.length) out.push(text.slice(cursor));
}

/** Pass 1: code spans. Backtick runs pair with the next run of the same length on the same line. */
function codeSpans(text: string): (string | Segment)[] {
  const out: (string | Segment)[] = [];
  const runs: { at: number; len: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "`") continue;
    let j = i;
    while (text[j] === "`") j++;
    runs.push({ at: i, len: j - i });
    i = j - 1;
  }
  if (!runs.length) return [text];
  // For each run, the next run of the same length (found right to left, so this stays linear).
  const nextSame = new Array<number>(runs.length).fill(-1);
  const seen = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    nextSame[i] = seen.get(runs[i].len) ?? -1;
    seen.set(runs[i].len, i);
  }
  // Where each line ends, so a span never crosses one.
  const lineEnd = (at: number) => { const n = text.indexOf("\n", at); return n < 0 ? text.length : n; };
  let cursor = 0;
  let endOfLine = -1;
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    if (open.at < cursor) continue;
    if (open.at > endOfLine) endOfLine = lineEnd(open.at);
    const j = nextSame[i];
    if (j < 0) continue;
    const close = runs[j];
    const inner = text.slice(open.at + open.len, close.at);
    if (close.at > endOfLine || !inner.trim()) continue;
    if (open.at > cursor) out.push(text.slice(cursor, open.at));
    // As in Markdown, one space on each side lets a span start or end with a backtick.
    out.push({ type: "code", text: inner.length > 2 && inner[0] === " " && inner[inner.length - 1] === " " ? inner.slice(1, -1) : inner });
    cursor = close.at + close.len;
    i = j;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/**
 * Pass 3, splitting: text into plain stretches and marker runs that could open or close something. `before` and
 * `after` are the characters around the text in the message (an atom's or a code span's edge counts as a word
 * character there: "*see https://x.example*" closes after the link).
 */
function splitMarkers(text: string, prev: string | undefined, nextChar: string | undefined, items: Item[]) {
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (!MARKER_CHARS.has(text[i])) continue;
    let j = i;
    while (text[j] === text[i]) j++;
    const run = text.slice(i, j);
    if (MARKERS[run]) {
      if (i > from) items.push({ t: "text", s: text.slice(from, i) });
      const before = i > 0 ? text[i - 1] : prev;
      const after = j < text.length ? text[j] : nextChar;
      const afterNext = j + 1 < text.length ? text[j + 1] : undefined;
      const mark: Mark = {
        t: "mark",
        run,
        canOpen: after !== undefined && !SPACE.test(after) && (before === undefined || SPACE.test(before) || (PUNCT.test(before) && before !== run[0])),
        canClose:
          before !== undefined && !SPACE.test(before) && (after === undefined || SPACE.test(after) || (PUNCT.test(after) && after !== run[0]))
          // "__init__.py": a full stop or colon followed straight by a word is part of a name, not the sentence.
          && !(after !== undefined && /[.,:;]/.test(after) && afterNext !== undefined && WORD.test(afterNext)),
      };
      items.push(mark);
      from = j;
    }
    i = j - 1;
  }
  if (from < text.length) items.push({ t: "text", s: text.slice(from) });
}

/** Pass 3, pairing: per-run stacks, so a closer finds its opener in O(1) and each marker is dropped at most once. */
function pairMarkers(items: Item[]) {
  // Open markers in order, where each one sits in that list, and the same markers per run.
  const stack: number[] = [];
  const depthOf = new Map<number, number>();
  const byRun = new Map<string, number[]>();
  const popTo = (depth: number) => {
    while (stack.length > depth) byRun.get((items[stack.pop()!] as Mark).run)!.pop();
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.t === "text") {
      // Markers pair within a line.
      if (item.s.includes("\n")) popTo(0);
      continue;
    }
    if (item.t !== "mark") continue;
    const openers = byRun.get(item.run);
    if (item.canClose && openers?.length) {
      const opener = openers[openers.length - 1];
      // Whatever opened after it and is still open never closes: "*a _b* c_" is bold "a _b", then text.
      popTo(depthOf.get(opener)!);
      (items[opener] as Mark).pair = "open";
      item.pair = "close";
    } else if (item.canOpen) {
      depthOf.set(i, stack.length);
      stack.push(i);
      if (openers) openers.push(i);
      else byRun.set(item.run, [i]);
    }
  }
}

/** The paired items as a tree; unpaired markers are text, and neighbouring text is joined. */
function build(items: Item[]): Segment[] {
  const root: Segment[] = [];
  const parents: Segment[][] = [root];
  const push = (seg: Segment) => {
    const list = parents[parents.length - 1];
    const last = list[list.length - 1];
    if (seg.type === "text" && last?.type === "text") last.text += seg.text;
    else list.push(seg);
  };
  for (const item of items) {
    if (item.t === "text") push({ type: "text", text: item.s });
    else if (item.t === "seg") push(item.seg);
    else if (item.pair === "open") {
      const span = { type: "span" as const, style: MARKERS[item.run], children: [] as Segment[] };
      push(span);
      parents.push(span.children);
    } else if (item.pair === "close") {
      parents.pop();
    } else push({ type: "text", text: item.run });
  }
  return root;
}

/** One paragraph's segments. `detectors` is the registry's list unless a test gives its own. */
export function tokenizeInline(text: string, detectors: readonly Detector[], ctx: ParseContext = {}): Segment[] {
  const pieces: (string | Segment)[] = [];
  for (const piece of codeSpans(text)) {
    if (typeof piece === "string") detect(piece, detectors, ctx, pieces);
    else pieces.push(piece);
  }
  const items: Item[] = [];
  // What sits on either side of a stretch of text: an atom's or a code span's edge reads as a word character.
  const edge = (piece: string | Segment | undefined, first: boolean) =>
    piece === undefined ? undefined : typeof piece === "string" ? piece[first ? 0 : piece.length - 1] : "a";
  pieces.forEach((piece, i) => {
    if (typeof piece === "string") splitMarkers(piece, edge(pieces[i - 1], false), edge(pieces[i + 1], true), items);
    else items.push({ t: "seg", seg: piece });
  });
  pairMarkers(items);
  return build(items);
}
