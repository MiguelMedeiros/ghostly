/**
 * A message that is JSON (an object or an array with something in it) shows pretty-printed. The text is
 * re-indented, not parsed and printed again: a number too big for a double, a duplicate key or an escape stays
 * exactly as written.
 */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Object.keys(value).length === 0) return null;
  } catch {
    return null;
  }
  return reindent(trimmed);
}

/** Valid JSON, one value per line, two spaces a level; strings are copied as they are. */
function reindent(json: string): string {
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
      depth++;
      out += c + newline();
    } else if (c === "}" || c === "]") {
      depth--;
      out += newline() + c;
    } else if (c === ",") out += "," + newline();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
  }
  return out;
}
