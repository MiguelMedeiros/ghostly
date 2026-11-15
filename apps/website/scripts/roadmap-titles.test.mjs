import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A roadmap candidate's title sits in a grid (app/roadmap.css). An auto track takes the title's longest unbreakable
// run, so with larger text on a 375 px phone "Voice/video/screenshare" ran past the screen's edge, over its status.
// The browser check is e2e/roadmap-titles-phone.spec.ts.
const website = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(website + "app/roadmap.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = [...css.matchAll(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
  assert.ok(found.length > 0, `${selector} has a rule`);
  return found.join(";");
};

test("a roadmap candidate's head has a column that never sizes to its title", () => {
  assert.match(rule(".rm-cand-head"), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("a roadmap candidate's title breaks where it must", () => {
  assert.match(rule(".rm-cand-title"), /overflow-wrap:\s*anywhere/);
});
