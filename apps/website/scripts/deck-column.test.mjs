import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The home page's decks (components/app/deck/deck.css) are 100cqw wide and bleed out of their column by a margin in %
// of it. WebKit (Safari, iPhone, iPad) sizes an auto grid column from that width, so the % is the deck's own width,
// the margin is 0 and the deck sits a gutter right of centre. The site's grid gives it a column that never sizes to
// content. Measured in WebKitGTK: 16 px off at 375 and 820 without it, 0 with it.
const website = fileURLToPath(new URL("..", import.meta.url));
const css = (path) => readFileSync(website + path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("the deck bleeds out of its column by a margin in % of it", () => {
  assert.match(css("components/app/deck/deck.css"), /\.deck\{[^}]*margin-inline:calc\(\(var\(--bleed\) - 100%\) \/ -2\)/);
});

test("the site's deck grid has a column that never sizes to the deck", () => {
  const rules = [...css("app/space.css").matchAll(/(?:^|\})\s*\.sp-deck\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const grid = rules.find((body) => /display:\s*grid/.test(body));
  assert.ok(grid, ".sp-deck is a grid");
  assert.match(grid, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
