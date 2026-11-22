// guards: #6840
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// `ghostly listen --webhook <url>` warns when the URL has a path or a query: a running listen's arguments show in ps to
// every account on the machine, so such a URL (a bridge's token) goes in GHOSTLY_WEBHOOK (packages/cli/src/main.ts).
// The site's own examples must not be the ones the CLI warns about. (Not read from main.ts here: the website gate would
// then run on most CLI changes.)
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PAGES = ["content/agentsThreat.ts", "content/agents.ts", "content/cli.ts", "content/developers.ts", "scripts/llms.mjs"];

test("no site example gives --webhook a URL the CLI warns about", () => {
  for (const page of PAGES) {
    for (const [, href] of read(page).matchAll(/--webhook\s+(https?:\/\/[^"'`\s]+)/g)) {
      const url = new URL(href);
      assert.ok(!url.search && url.pathname === "/", `${page}: --webhook ${href} has a path or a query; give it in GHOSTLY_WEBHOOK`);
    }
  }
});
