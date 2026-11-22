import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { Root } from "hast";

/**
 * The syntax highlighter, loaded only when a message has a code block that names a language (CodeBlock imports
 * this module lazily). lowlight gives highlight.js's result as a tree, not as HTML, so the page never parses
 * markup built from a message. The languages are the ones people here paste most; their aliases (js, ts, sh, py,
 * rs, html, yml…) come with them. Another is one import and one name below, at 0.3 to 3 kB gzipped each.
 */
const lowlight = createLowlight({ bash, c, diff, go, javascript, json, python, rust, sql, typescript, xml, yaml });

/**
 * highlight.js runs on the page's thread with no budget, and some shapes make its work grow with the square of their
 * length (C's declaration rule rescans a run of words, every grammar rescans one long word): 16 kB of `int int …`
 * took a second. A block highlights only when it is short enough and has none of those shapes; otherwise it shows
 * plain. With these cuts the worst block measured took about 10 ms on a desktop, ordinary code of that size a few.
 */
export const HIGHLIGHT_MAX = 4_000;
const LINE_MAX = 1_000;
const WORD_MAX = 100;
/** C's declaration rule spans words, spaces, line ends, `*`, `&`, `::` and `<…>`; it never crosses other marks. */
const C_RUN = /(?:[\w\s*&:]|<[^<>]*>)+/g;
const C_RUN_MAX = 200;

function longest(code: string, run: RegExp): number {
  let most = 0;
  for (const [match] of code.matchAll(run)) most = Math.max(most, match.length);
  return most;
}

function bounded(code: string, lang: string): boolean {
  if (code.length > HIGHLIGHT_MAX || longest(code, /[^\n]+/g) > LINE_MAX || longest(code, /[\w$]+/g) > WORD_MAX) return false;
  return !["c", "h"].includes(lang.toLowerCase()) || longest(code, C_RUN) <= C_RUN_MAX;
}

/** Trees already made this session, so a chat opened again does not redo them; the oldest go first past the cap. */
const made = new Map<string, Root | null>();
const MADE_MAX = 200;

/** The code as highlight.js's token tree, or null for a language this build does not know or a block left plain. */
export function highlight(code: string, lang: string): Root | null {
  if (!lowlight.registered(lang)) return null;
  const key = `${lang}\n${code}`;
  if (made.has(key)) return made.get(key)!;
  let tree: Root | null = null;
  if (bounded(code, lang)) {
    try {
      tree = lowlight.highlight(lang, code);
    } catch {
      // a grammar that throws leaves the block plain
    }
  }
  made.set(key, tree);
  if (made.size > MADE_MAX) made.delete(made.keys().next().value!);
  return tree;
}
