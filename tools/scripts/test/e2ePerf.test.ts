import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The e2e tests whose pass hangs on milliseconds or frame times are tagged @perf: shared runners failed them at random,
 * so every run leaves them out (the release's E2E, E2E (full), One's loop, which runs `npm run e2e:full`) but the nightly
 * E2E (perf) job, which keeps what each budget measured.
 */
const root = resolve(import.meta.dirname, "../../..");
const SPECS = ["chat-list-long-perf", "chat-open-perf", "composer-typing-perf", "tasks-board"].map((s) => `e2e/web/${s}.spec.ts`);

/** The titles Playwright would run, with E2E_PERF on or off. */
const listed = (perf: boolean, ...args: string[]) => {
  const env = { ...process.env, E2E_PERF: perf ? "1" : "" };
  const out = execFileSync("npx", ["playwright", "test", "-c", "e2e/playwright.config.ts", "--project=web", "--list", ...args, ...SPECS], { cwd: root, env, encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes(" › ")).map((line) => line.split(" › ").at(-1)!.trim());
};

describe("the @perf tests", () => {
  it("run only with E2E_PERF, their functional twins always", () => {
    const perf = listed(true, "--grep", "@perf");
    const usual = listed(false);
    expect(perf).toEqual(expect.arrayContaining([
      "a list of 300 chats switches Light/Dark cheaply",
      "a long chat opens without costing in proportion to its length",
      "a keystroke in a long chat costs what it does in a short one",
      "a column of 500 tasks scrolls with a frame's CPU per frame",
    ]));
    expect(usual.filter((title) => perf.includes(title))).toEqual([]);
    expect(usual).toEqual(expect.arrayContaining([
      "a list of 300 chats keeps every row in the page and scrolls with no React commit",
      "a long chat opens at its bottom with only its last rows in the page",
      "typing in a long chat draws no message rows and grows the field a line at a time",
      "a bot's tasks from two chats on one board: columns by status, live updates, a card opens its chat",
    ]));
    // A --grep-invert on the command line, as the release's E2E gives, does not bring them back.
    expect(listed(false, "--grep-invert", "@release-skip|@network").filter((title) => perf.includes(title))).toEqual([]);
  }, 60_000);

  it("run nightly on their own, one worker, their budgets in the summary and an artifact", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/e2e-perf.yml"), "utf8");
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: /m);
    expect(workflow).toMatch(/^ {10}E2E_PERF: "1"$/m);
    expect(workflow).toMatch(/run: npx playwright test -c e2e\/playwright\.config\.ts --project=web --grep @perf --workers=1 /);
    expect(workflow).toMatch(/run: node e2e\/perf-summary\.mjs perf-results\.json perf\.json >> "\$GITHUB_STEP_SUMMARY"/);
    expect(workflow).toMatch(/^ {12}perf\.json$/m);
  });

  it("each budget's value goes to perf.json and the summary's table, every attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-summary-"));
    const budget = (name: string, value: number, below: number) => ({ type: "perf", description: JSON.stringify({ name, value, below, unit: "ms" }) });
    const report = { suites: [{ title: "web/chat-open-perf.spec.ts", specs: [{ title: "a long chat opens", tests: [{ results: [
      { retry: 0, status: "failed", annotations: [budget("paint", 420.25, 400), { type: "other", description: "x" }] },
      { retry: 1, status: "passed", annotations: [budget("paint", 180, 400)] },
    ] }] }] }] };
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    const table = execFileSync("node", ["e2e/perf-summary.mjs", join(dir, "report.json"), join(dir, "perf.json")], { cwd: root, encoding: "utf8" });
    const run = JSON.parse(readFileSync(join(dir, "perf.json"), "utf8"));
    expect(run.budgets).toEqual([
      { test: "web/chat-open-perf.spec.ts › a long chat opens", name: "paint", value: 420.25, below: 400, unit: "ms", retry: 0, status: "failed" },
      { test: "web/chat-open-perf.spec.ts › a long chat opens", name: "paint", value: 180, below: 400, unit: "ms", retry: 1, status: "passed" },
    ]);
    expect(table).toContain("| paint | 420.25 ms | 400 | ❌ | web/chat-open-perf.spec.ts › a long chat opens |");
    expect(table).toContain("| paint (retry 1) | 180 ms | 400 | ✅ |");
  });
});
