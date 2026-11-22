import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The variable names an object literal assigned in `source` after `start` names, up to its closing brace. */
function keysAfter(source: string, start: RegExp) {
  const at = source.search(start);
  expect(at, `${start} not found`).toBeGreaterThanOrEqual(0);
  const from = source.indexOf("{", at);
  let depth = 0;
  let end = from;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}" && --depth === 0) break;
  }
  return [...source.slice(from, end).matchAll(/\b([A-Z][A-Z0-9_]+):/g)].map((m) => m[1]).sort();
}

describe("test-affected.mjs's web build", () => {
  // `--port` builds the web app itself instead of through Playwright's webServer. It had no services host, so a
  // contact's shared app never opened and every services spec timed out at "open-service".
  it("is given every variable Playwright's own webServer build is given", () => {
    const config = readFileSync(join(ROOT, "e2e/playwright.config.ts"), "utf8");
    const script = readFileSync(join(ROOT, "tools/scripts/test-affected.mjs"), "utf8");
    const suite = keysAfter(config, /webServer:/);
    expect(suite).toContain("VITE_SERVICES_HOST");
    expect(keysAfter(script, /const suiteEnv =/)).toEqual(suite);
  });
});
