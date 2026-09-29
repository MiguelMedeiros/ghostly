/**
 * What pretty-printing takes on. Re-indenting adds two spaces a level on every line, so deep nesting grows the text
 * with the square of its depth: 8 KiB of `[` and `]` would come out as about 134 million characters. A message past
 * these bounds shows as it was written.
 */
export const JSON_LIMITS = {
  /** Characters of the message, trimmed. */
  inputChars: 4 * 1024,
  /** Levels of nesting. */
  depth: 32,
  /** Characters of the pretty-printed text. */
  outputChars: 64 * 1024,
} as const;

/**
 * A message that is JSON (an object or an array with something in it) shows pretty-printed. The text is
 * re-indented, not parsed and printed again: a number too big for a double, a duplicate key or an escape stays
 * exactly as written. Null for anything else, and for JSON too big or too deep to lay out (`JSON_LIMITS`).
 */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length > JSON_LIMITS.inputChars) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return null;
  // Counted before parsing, so the parser never walks a deep tree either (brackets inside strings count too, which
  // only ever errs towards plain text).
  let depth = 0;
  for (const c of trimmed) {
    if (c === "{" || c === "[") { if (++depth > JSON_LIMITS.depth) return null; }
    else if (c === "}" || c === "]") depth--;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Object.keys(value).length === 0) return null;
  } catch {
    return null;
  }
  return reindent(trimmed);
}

/** Valid JSON, one value per line, two spaces a level; strings are copied as they are. Null past the bounds. */
function reindent(json: string): string | null {
  let out = "";
  let depth = 0;
  const newline = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      let j = i + 1;
      while (json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j;
    } else if (c === "{" || c === "[") {
      // An empty object or array stays on its line.
      let j = i + 1;
      while (/\s/.test(json[j])) j++;
      if (json[j] === (c === "{" ? "}" : "]")) { out += c + json[j]; i = j; continue; }
      if (++depth > JSON_LIMITS.depth) return null;
      out += c + newline();
    } else if (c === "}" || c === "]") {
      depth--;
      out += newline() + c;
    } else if (c === ",") out += "," + newline();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
    if (out.length > JSON_LIMITS.outputChars) return null;
  }
  return out;
}
