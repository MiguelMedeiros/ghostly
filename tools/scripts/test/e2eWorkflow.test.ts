import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * e2e.yml's web and extension suites, which release.yml waits for before the draft release and the web image. On one
 * runner they took 66-81 minutes (v1.5.0 to v1.7.3) while the release's builds ended in 13-18: they run in shards, and
 * a report job merges the shards' blob reports into one HTML report.
 */
const root = resolve(import.meta.dirname, "../../..");
const text = readFileSync(resolve(root, ".github/workflows/e2e.yml"), "utf8");
const config = readFileSync(resolve(root, "e2e/playwright.config.ts"), "utf8");
const job = (name: string) => text.match(new RegExp(`^ {2}${name}:\n((?: {4}.*\n|\n)+)`, "m"))?.[1] ?? "";

describe("e2e.yml runs the web and extension suites in shards", () => {
  const e2e = job("e2e");
  const shards = (e2e.match(/^ {8}shard: \[([\d, ]+)\]$/m)?.[1] ?? "").split(",").map((s) => Number(s.trim()));
  const total = shards.length;

  it("on parallel runners, one shard each, a red shard not cancelling the others", () => {
    expect(total).toBeGreaterThan(1);
    expect(shards).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(e2e).toMatch(/^ {6}fail-fast: false$/m);
    expect(e2e).toMatch(new RegExp(`^ {4}name: End-to-end \\(\\$\\{\\{ matrix\\.shard \\}\\}/${total}\\)$`, "m"));
  });

  it("every test step on its own shard of the same total, the release's and the deployed web app's", () => {
    const runs = [...e2e.matchAll(/^ {8}run: (.*(?:test:e2e|playwright test|e2e\/shard\.mjs).*)$/gm)].map((m) => m[1]);
    expect(runs).toHaveLength(2);
    // Split by recorded time (e2e/shard.mjs), not by Playwright's --shard: equal counts in file order gave shard 2
    // every devices, dht and group story, 25 to 34 minutes against 15 to 22 for the others (2026-11-02).
    for (const run of runs) {
      expect(run).toContain(`node e2e/shard.mjs \${{ matrix.shard }} ${total}`);
      expect(run).not.toContain("--shard");
    }
  });

  it("the release's step builds the extension first, as npm run test:e2e did", () => {
    expect(e2e).toMatch(/^ {8}run: npm run build:extension && node e2e\/shard\.mjs /m);
  });

  it("with a shorter timeout than the 90 minutes the whole suite needed on one runner", () => {
    expect(Number(e2e.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1])).toBeLessThanOrEqual(45);
  });

  it("each shard uploads its blob report, which the config writes on CI", () => {
    const onCI = config.match(/^ {2}reporter: process\.env\.CI\n {4}\? (.*)$/m)?.[1] ?? "";
    expect(onCI).toContain('["blob", { outputDir: "../blob-report" }]');
    expect(e2e).toMatch(/^ {10}name: e2e-blob-\$\{\{ matrix\.shard \}\}\n {10}path: blob-report$/m);
  });

  it("and the report job merges every shard's, red or green, into the playwright-report artifact", () => {
    const report = job("report");
    expect(report).toMatch(/^ {4}needs: e2e$/m);
    expect(report).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
    expect(report).toMatch(/^ {10}pattern: e2e-blob-\*\n {10}path: all-blob-reports\n {10}merge-multiple: true$/m);
    expect(report).toContain("npx playwright merge-reports -c e2e/playwright.config.ts all-blob-reports");
    expect(report).toMatch(/^ {10}name: playwright-report\n {10}path: playwright-report$/m);
  });

  it("and keeps every test's time as JSON, which e2e/shard.mjs --record reads", () => {
    const report = job("report");
    expect(report).toMatch(/^ {10}PLAYWRIGHT_JSON_OUTPUT_NAME: e2e-results\.json\n {8}run: npx playwright merge-reports --reporter json all-blob-reports$/m);
    expect(report).toMatch(/^ {10}name: e2e-results\n {10}path: e2e-results\.json$/m);
  });
});
