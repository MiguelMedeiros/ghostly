import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// `ghostly listen --webhook <url>` warns when the URL has a path or a query: a running listen's arguments show in ps to
// every account on the machine, so such a URL (a bridge's token) goes in GHOSTLY_WEBHOOK (packages/cli/src/main.ts).
// The site's own examples must not be the ones the CLI warns about.
const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const PAGES = ["apps/website/content/agentsThreat.ts", "apps/website/content/agents.ts", "apps/website/content/cli.ts", "apps/website/content/developers.ts", "apps/website/scripts/llms.mjs"];

test("the CLI still warns about a --webhook URL with a path or a query", () => {
  assert.match(read("packages/cli/src/main.ts"), /url\.search \|\| url\.pathname !== "\/"\)\) process\.stderr\.write\("ghostly: --webhook's URL shows in ps/);
});

test("no site example gives --webhook a URL the CLI warns about", () => {
  for (const page of PAGES) {
    for (const [, href] of read(page).matchAll(/--webhook\s+(https?:\/\/[^"'`\s]+)/g)) {
      const url = new URL(href);
      assert.ok(!url.search && url.pathname === "/", `${page}: --webhook ${href} has a path or a query; give it in GHOSTLY_WEBHOOK`);
    }
  }
});
