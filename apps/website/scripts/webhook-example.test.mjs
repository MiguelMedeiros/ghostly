// guards: #6840
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KEY_DOCS } from "./llms.mjs";

// `ghostly listen --webhook <url>` warns when the URL has a path or a query: a running listen's arguments show in ps to
// every account on the machine, so such a URL (a bridge's token) goes in GHOSTLY_WEBHOOK (packages/cli/src/main.ts).
// The site's own examples, and the repository's documents /llms-full.txt carries (KEY_DOCS, already in the website
// gate), must not be the ones the CLI warns about. (Not read from main.ts here: the website gate would then run on most
// CLI changes.)
const SITE = ["content/agentsThreat.ts", "content/agents.ts", "content/cli.ts", "content/developers.ts", "scripts/llms.mjs"];
const FILES = [...SITE.map((path) => new URL(`../${path}`, import.meta.url)), ...KEY_DOCS.map((path) => new URL(`../../../${path}`, import.meta.url))];

test("no site example gives --webhook a URL the CLI warns about", () => {
  for (const file of FILES) {
    // A text match, not new URL(): a placeholder such as `<port>/…` would make it throw instead of failing the check.
    for (const [example] of readFileSync(file, "utf8").matchAll(/--webhook\s+https?:\/\/[^/\s"'`]+[/?#][^\s"'`]*/g)) {
      assert.ok(/^--webhook\s+https?:\/\/[^/\s"'`?#]+\/?$/.test(example), `${file.pathname}: ${example} has a path or a query; give it in GHOSTLY_WEBHOOK`);
    }
  }
});
