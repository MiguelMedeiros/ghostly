import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ARIA 1.2 does not let a generic element (b, span, div, pre…) or a paragraph or a text-level one take a name, and
// screen readers often drop it there: what such a label says goes in text they read, or the element gets a role.
const site = fileURLToPath(new URL("../", import.meta.url));
const UNNAMED = new Set(["b", "i", "u", "s", "span", "div", "pre", "p", "small", "strong", "em", "code", "mark", "sub", "sup"]);

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".tsx") ? [join(dir, entry.name)] : [],
  );

/** Every lowercase JSX opening tag in `source`, `{…}` attribute values skipped whole (an arrow's `>` ends nothing). */
function openingTags(source) {
  const tags = [];
  for (const match of source.matchAll(/<([a-z][a-z0-9]*)\b/g)) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push({ name: match[1], text: source.slice(match.index, end + 1), line: source.slice(0, match.index).split("\n").length });
  }
  return tags;
}

/** Where a plain element carries aria-label or aria-labelledby with no role, as "file:line <tag>". */
export function namedWithoutRole(source, file = "") {
  return openingTags(source)
    .filter((tag) => UNNAMED.has(tag.name) && /\saria-label(ledby)?=/.test(tag.text) && !/\srole=/.test(tag.text))
    .map((tag) => `${file}:${tag.line} <${tag.name}>`);
}

test("the check finds a label on a plain element, and leaves a role's label and a component's alone", () => {
  assert.deepEqual(namedWithoutRole(`<li>\n  <b aria-label={x || "connects to"}>→</b>\n</li>`), [":2 <b>"]);
  assert.deepEqual(namedWithoutRole(`<pre tabIndex={0} aria-label="SHA-256">`), [":1 <pre>"]);
  assert.deepEqual(namedWithoutRole(`<div onKeyDown={(e) => e.key > "a"} aria-labelledby="t">`), [":1 <div>"]);
  assert.deepEqual(namedWithoutRole(`<pre role="region" aria-label="SHA-256" tabIndex={0}>`), []);
  assert.deepEqual(namedWithoutRole(`<span className="avail-yes" role="img" aria-label={ok}>✓</span>`), []);
  assert.deepEqual(namedWithoutRole(`<nav aria-label="Main"><Tag aria-label={name} /></nav>`), []);
});

test("no page of the site puts a name on an element whose role takes none", () => {
  const found = ["app", "components"].flatMap((dir) =>
    files(join(site, dir)).flatMap((file) => namedWithoutRole(readFileSync(file, "utf8"), relative(site, file))),
  );
  assert.deepEqual(found, []);
});
