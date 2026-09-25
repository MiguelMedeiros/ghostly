// Runs one CI shard of the browser checks: `node e2e/shard.mjs <shard> <of> [playwright args]`.
//
// Playwright's --shard cuts the test list into runs of equal counts, in file order. Here one file
// (scene-overlap.spec.ts) is a third of the tests and most of the time (its film viewports take 25 s each,
// the springs settling at every step), so equal counts gave one shard three times the work of another.
// This splits by time instead: every test the config lists goes to exactly one shard, heaviest first to the
// least loaded, by the seconds CI took for it (e2e/durations.json; a test not in it counts as a typical one).
// A stale durations.json only unbalances the shards, it never drops a test. The shard's tests go to
// Playwright as a --test-list, and are checked to be exactly what Playwright then selects.
//
// After a spec is added or gets slower: run the whole suite with a JSON report and record its times:
//   npx playwright test -c e2e/playwright.config.ts --reporter=json > report.json
//   node e2e/shard.mjs --record report.json
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = dirname(here);
const config = "e2e/playwright.config.ts";
const durationsFile = join(here, "durations.json");

/** Every test of a JSON report as its --test-list line (`[project] › file › describe › title`), with its runs. */
function tests(report) {
  const out = [];
  const walk = (suite, path) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const titles = [...path, spec.title];
        if (titles.some((t) => t.includes("›") || t.includes(">"))) throw new Error(`a test title with › or > cannot be listed: ${titles.join(" / ")}`);
        out.push({ id: [`[${test.projectName}]`, spec.file, ...titles].join(" › "), results: test.results ?? [] });
      }
    }
    // An anonymous describe is no part of a test's title path.
    for (const child of suite.suites ?? []) walk(child, child.title ? [...path, child.title] : path);
  };
  for (const file of report.suites) walk(file, []);
  return out;
}

function playwright(args, options = {}) {
  return spawnSync("npx", ["playwright", "test", "-c", config, ...args], { cwd: site, encoding: "utf8", maxBuffer: 64 << 20, ...options });
}

function listed(extra = []) {
  const run = playwright(["--list", "--reporter=json", ...extra]);
  if (run.status !== 0) throw new Error(`playwright --list failed:\n${run.stderr}`);
  return tests(JSON.parse(run.stdout)).map((t) => t.id);
}

/** Heaviest first to the least loaded shard; ties by id and by shard number, so every shard computes the same split. */
function split(ids, seconds, of) {
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

const [first, second, ...rest] = process.argv.slice(2);

if (first === "--record") {
  const report = JSON.parse(readFileSync(second, "utf8"));
  const seconds = {};
  for (const t of tests(report)) {
    const runs = t.results.filter((r) => r.status === "passed");
    if (runs.length) seconds[t.id] = Math.round(runs.reduce((sum, r) => sum + r.duration, 0) / runs.length / 100) / 10;
  }
  const sorted = Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(durationsFile, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`Recorded ${Object.keys(sorted).length} tests in e2e/durations.json.`);
  process.exit(0);
}

const shard = Number(first);
const of = Number(second);
if (!Number.isInteger(shard) || !Number.isInteger(of) || shard < 1 || shard > of) {
  console.error("usage: node e2e/shard.mjs <shard> <of> [playwright args]   (1-based, e.g. 2 4)");
  process.exit(2);
}

const all = listed();
if (new Set(all).size !== all.length) throw new Error("two tests share a --test-list line");
const seconds = JSON.parse(readFileSync(durationsFile, "utf8"));
const shards = split(all, seconds, of);
const mine = shards[shard - 1];
console.log(`Shard ${shard}/${of}: ${mine.ids.length} of ${all.length} tests, about ${Math.round(mine.load)} s of test time (shards: ${shards.map((s) => Math.round(s.load)).join(", ")} s).`);
if (!mine.ids.length) process.exit(0);

const list = join(mkdtempSync(join(tmpdir(), "website-shard-")), "tests.txt");
writeFileSync(list, mine.ids.join("\n") + "\n");
const selected = listed(["--test-list", list]);
const want = [...mine.ids].sort().join("\n");
if ([...selected].sort().join("\n") !== want) {
  console.error(`--test-list selected other tests than this shard's:\n  want ${mine.ids.length}, got ${selected.length}`);
  process.exit(1);
}

const run = playwright(["--test-list", list, ...rest], { stdio: "inherit" });
process.exit(run.status ?? 1);
