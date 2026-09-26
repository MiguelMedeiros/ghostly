import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
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
 * markup built from a message. The languages are the ones people paste most; their aliases (js, ts, sh, py, rs,
 * html, yml…) come with them.
 */
const lowlight = createLowlight({ bash, c, cpp, css, diff, go, java, javascript, json, python, rust, sql, typescript, xml, yaml });

/** Past this, a block shows plain: highlighting a pasted log of megabytes would hold up the chat. */
export const HIGHLIGHT_MAX = 20_000;

/** The code as highlight.js's token tree, or null for a language this build does not know. */
export function highlight(code: string, lang: string): Root | null {
  if (code.length > HIGHLIGHT_MAX || !lowlight.registered(lang)) return null;
  try {
    return lowlight.highlight(lang, code);
  } catch {
    return null;
  }
}
