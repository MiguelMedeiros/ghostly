import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// In forced colors (Windows high contrast) the browser drops backgrounds and gradients and replaces every colour. A
// main button with no border of its own (`.btn--primary`: a gradient, `border: 0`) turns into plain text beside the
// bordered secondary one, and a current-page mark made of a translucent background and a colour looks like every other
// link. Each needs a mark of its own in a `@media (forced-colors: active)` block, in system colours.
const website = fileURLToPath(new URL("..", import.meta.url));
const css = (path) => readFileSync(website + path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const FORCED = /@media\s*\(\s*forced-colors:\s*active\s*\)\s*\{/g;

/** The declarations each selector gets inside the file's forced-colors blocks. */
function forced(path) {
  const text = css(path);
  const rules = new Map();
  for (const m of text.matchAll(FORCED)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; depth > 0; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
    for (const [, selectors, body] of text.slice(start, i - 1).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const selector of selectors.split(",")) {
        const key = selector.trim().replace(/\s+/g, " ");
        rules.set(key, (rules.get(key) ?? "") + body);
      }
    }
  }
  return rules;
}

test("the main button draws an edge in forced colors, in a system colour", () => {
  const body = forced("app/site.css").get(".btn--primary");
  assert.ok(body, ".btn--primary has a forced-colors rule");
  assert.match(body, /border:\s*1px solid ButtonText/);
});

for (const [path, selector] of [
  ["app/site.css", '.nav-links a[aria-current="page"]'],
  ["app/site.css", '.nav-sheet a[aria-current="page"]'],
  ["app/reader.css", '.reader-all a[aria-current="page"]'],
]) {
  test(`${selector} is underlined in forced colors`, () => {
    const body = forced(path).get(selector);
    assert.ok(body, `${selector} has a forced-colors rule`);
    assert.match(body, /text-decoration:\s*underline/);
  });
}

// The chosen one among siblings (a preset, a scenario, a stage, the installer guessed for this machine) was marked by a
// fill, a tint, a halo or a colour alone, all of which forced colors replace: each needs a mark that survives.
for (const [path, selector, mark] of [
  ["app/developers.css", '.preset[aria-checked="true"]', /forced-color-adjust:\s*none[\s\S]*background:\s*Highlight/],
  ["app/negotiation.css", '.ng-tab[aria-pressed="true"]', /forced-color-adjust:\s*none[\s\S]*background:\s*Highlight/],
  ["app/developers.css", '.stage-node[data-passed="true"] .stage-dot', /forced-color-adjust:\s*none[\s\S]*background:\s*CanvasText/],
  ["app/developers.css", '.stage-node[aria-checked="true"] .stage-dot', /outline:\s*2px solid CanvasText/],
  ["app/finale.css", '.fin-dl[aria-current="true"]', /text-decoration:\s*underline/],
]) {
  test(`${selector} keeps its mark in forced colors`, () => {
    const body = forced(path).get(selector);
    assert.ok(body, `${selector} has a forced-colors rule`);
    assert.match(body, mark);
  });
}
