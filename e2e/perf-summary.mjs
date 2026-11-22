#!/usr/bin/env node
// The time budgets a run of the @perf tests measured (e2e/support/perfBudget.ts), out of Playwright's JSON report:
// writes them to perf.json, one row per budget and attempt, and prints them as a Markdown table (the nightly
// E2E (perf) job's summary). One run's perf.json next to another's is the series a slow drift shows in.
//
//   node e2e/perf-summary.mjs <playwright json report> [perf.json]
import { readFileSync, writeFileSync } from "node:fs";

const [input, output = "perf.json"] = process.argv.slice(2);
if (!input) { console.error("usage: perf-summary.mjs <playwright json report> [perf.json]"); process.exit(2); }
const report = JSON.parse(readFileSync(input, "utf8"));

const budgets = [];
const walk = (suite, titles) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) for (const result of test.results) {
      for (const a of result.annotations ?? []) {
        if (a.type !== "perf") continue;
        budgets.push({ test: [...titles, spec.title].join(" › "), ...JSON.parse(a.description), retry: result.retry, status: result.status });
      }
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
};
for (const suite of report.suites ?? []) walk(suite, [suite.title]);

const run = { sha: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, at: new Date().toISOString(), budgets };
writeFileSync(output, `${JSON.stringify(run, null, 1)}\n`);

console.log(`### Time budgets (${budgets.length})\n`);
console.log("| Budget | Measured | Below | | Test |");
console.log("|---|---:|---:|---|---|");
for (const b of budgets) {
  const round = (n) => Math.round(n * 100) / 100;
  const mark = b.value < b.below ? "✅" : "❌";
  console.log(`| ${b.name}${b.retry ? ` (retry ${b.retry})` : ""} | ${round(b.value)} ${b.unit} | ${round(b.below)} | ${mark} | ${b.test} |`);
}
