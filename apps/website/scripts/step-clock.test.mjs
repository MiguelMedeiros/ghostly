import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// /developers' explainer clock (components/dev/stepClock.ts) writes `--t` each frame only on the shapes whose picture
// changes, from a list of the rules that read it and when each one changes. A rule that reads `--t` and is missing
// from that list would be left behind while a step plays.
const website = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(website + path, "utf8");

test("every rule of dev-steps.css that reads --t is one the clock knows", () => {
  const css = read("app/dev-steps.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const known = new Set([...read("components/dev/stepClock.ts").matchAll(/^\s*"((?:p?sx)-[\w-]+)":/gm)].map((m) => m[1]));
  assert.ok(known.size > 5, `the clock's list: ${[...known]}`);
  const readers = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , body]) => /var\(--t\)/.test(body));
  assert.ok(readers.length > 5, "rules that read --t");
  for (const [, selector] of readers) {
    const classes = [...selector.matchAll(/\.((?:p?sx)-[\w-]+)/g)].map((m) => m[1]);
    assert.ok(classes.some((c) => known.has(c)), `${selector.trim()} reads --t but the clock does not know it`);
  }
});
