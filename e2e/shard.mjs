// Runs one of e2e.yml's shards: `node e2e/shard.mjs <shard> <of> [playwright args]`, from the repository root.
//
// Playwright's --shard cuts the test list into runs of equal counts, in file order. The long multi-peer stories sit
// side by side (devices-*, dht-*, group-*), so equal counts gave shard 2 51 to 62 test-minutes against 32 to 42 for
// the others, and every run waited on it (2026-11-02). This splits by time instead, as the site's browser checks do
// (apps/website/e2e/shard.mjs), but by whole spec files: a serial spec, and every extension file (its project is not
// fully parallel), must stay on one runner. Heaviest first to the least loaded shard, by the seconds CI took for each
// file (e2e/durations.json; a file not in it counts as a typical one). A stale durations.json only unbalances the
// shards, it never drops a test. The shard's files go to Playwright as a --test-list, and are checked to be exactly
// what Playwright then selects. The Playwright args (a --grep-invert, a --project) apply to the list and the run.
//
// After a spec is added or gets slower, record the times of a green e2e.yml run (its report job keeps them):
//   gh run download <run id> -n e2e-results
//   node e2e/shard.mjs --record e2e-results.json [more runs' e2e-results.json, averaged]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const config = "e2e/playwright.config.ts";
const durationsFile = join(here, "durations.json");

/** Every test of a JSON report, with its file's --test-list line (`[project] › file`), which selects the whole file. */
function tests(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) out.push({ file: `[${test.projectName}] › ${spec.file}`, results: test.results ?? [] });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const file of report.suites) walk(file);
  return out;
}

/**
 * Each file's seconds, the sum of its tests' first passed run (a failed try and its timeout say nothing of the
 * file's time; a file with no passed or skipped test is left out), averaged over the reports that ran it.
 * @param {any[]} reports Playwright JSON reports
 * @returns {Record<string, number>}
 */
export function fileSeconds(reports) {
  const runs = new Map();
  for (const report of reports) {
    const sums = new Map();
    for (const t of tests(report)) {
      const passed = t.results.find((r) => r.status === "passed");
      if (passed) sums.set(t.file, (sums.get(t.file) ?? 0) + passed.duration / 1000);
      // A test skipped on CI (no service for it there) takes no time.
      else if (t.results.length && t.results.every((r) => r.status === "skipped")) sums.set(t.file, sums.get(t.file) ?? 0);
    }
    for (const [file, seconds] of sums) runs.set(file, [...(runs.get(file) ?? []), seconds]);
  }
  return Object.fromEntries(
    [...runs]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, s]) => [file, Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10]),
  );
}

/**
 * Heaviest first to the least loaded shard; ties by id and by shard number, so every shard computes the same split.
 * @param {string[]} ids the files' --test-list lines
 * @param {Record<string, number>} seconds
 * @param {number} of
 * @returns {{ load: number, ids: string[] }[]}
 */
export function split(ids, seconds, of) {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (id) => seconds[id] ?? typical;
  const shards = Array.from({ length: of }, () => ({ load: 0, ids: [] }));
  for (const id of [...ids].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((best, s) => (s.load < best.load ? s : best));
    lightest.load += weight(id);
    lightest.ids.push(id);
  }
  return shards;
}

function playwright(args, options = {}) {
  return spawnSync("npx", ["playwright", "test", "-c", config, ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, ...options });
}

/** The tests Playwright selects, one line each (`[project] › file › line`), for comparing two lists. */
function listed(extra) {
  const run = playwright(["--list", "--reporter=json", ...extra]);
  if (run.status !== 0) throw new Error(`playwright --list failed:\n${run.stderr}`);
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) out.push(`[${test.projectName}] › ${spec.file} › ${spec.line}:${spec.column}`);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const file of JSON.parse(run.stdout).suites) walk(file);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [first, second, ...rest] = process.argv.slice(2);

  if (first === "--record") {
    const reports = [second, ...rest].map((path) => JSON.parse(readFileSync(path, "utf8")));
    const seconds = fileSeconds(reports);
    writeFileSync(durationsFile, JSON.stringify(seconds, null, 2) + "\n");
    console.log(`Recorded ${Object.keys(seconds).length} files in e2e/durations.json.`);
    process.exit(0);
  }

  const shard = Number(first);
  const of = Number(second);
  if (!Number.isInteger(shard) || !Number.isInteger(of) || shard < 1 || shard > of) {
    console.error("usage: node e2e/shard.mjs <shard> <of> [playwright args]   (1-based, e.g. 2 4)");
    process.exit(2);
  }

  const all = listed(rest);
  const files = [...new Set(all.map((line) => line.split(" › ").slice(0, 2).join(" › ")))];
  const seconds = JSON.parse(readFileSync(durationsFile, "utf8"));
  const shards = split(files, seconds, of);
  const mine = shards[shard - 1];
  const want = all.filter((line) => mine.ids.includes(line.split(" › ").slice(0, 2).join(" › "))).sort();
  console.log(
    `Shard ${shard}/${of}: ${mine.ids.length} of ${files.length} files, ${want.length} of ${all.length} tests, about ${Math.round(mine.load / 60)} min of test time (shards: ${shards.map((s) => Math.round(s.load / 60)).join(", ")} min).`,
  );
  if (!mine.ids.length) process.exit(0);

  const list = join(mkdtempSync(join(tmpdir(), "e2e-shard-")), "tests.txt");
  writeFileSync(list, mine.ids.join("\n") + "\n");
  const selected = listed(["--test-list", list, ...rest]).sort();
  if (selected.join("\n") !== want.join("\n")) {
    console.error(`--test-list selected other tests than this shard's:\n  want ${want.length}, got ${selected.length}`);
    process.exit(1);
  }

  const run = playwright(["--test-list", list, ...rest], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
