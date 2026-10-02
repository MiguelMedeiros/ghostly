#!/usr/bin/env node
// Runs one CI shard of `npm run test:packages`: `node tools/scripts/test-shards.mjs <shard> <of> [--report-dir <dir>]`.
//
// One runner took 6.5 minutes for the packages' unit tests, one package after another (core 86 s, browser 104 s,
// cli 178 s). Here they split into shards of about the same time, each on its own runner. The unit is a package:
// its files run in parallel inside one Vitest, and cutting a package in two pays its imports twice. A file in ALONE
// is a unit of its own that no other unit joins: the CLI's two-peer story (twoPeers.test.ts, about 3 minutes of
// designed waits in one sequence of tests) sets the floor, so nothing else waits behind it or loads its runner.
// Heaviest first to the least loaded shard, by the seconds CI took per file (tools/scripts/test-durations.json; a file not
// in it counts as a typical one). A stale durations file only unbalances the shards, it never drops a test: every
// file Vitest lists for a package goes to exactly one shard, and a shard that runs part of a package checks that
// Vitest selects exactly that part.
//
//   node tools/scripts/test-shards.mjs --plan 4           # print the 4 shards and check every file is in exactly one
//   node tools/scripts/test-shards.mjs --record a.json …  # tools/scripts/test-durations.json from Vitest JSON reports
//
// CI's packages shards upload their JSON reports (artifact "packages-test-reports-<shard>"): download them all and
// --record them after adding a slow test file.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const durationsFile = join(root, "tools/scripts/test-durations.json");

/** Files that run on a shard of their own (repository paths). */
export const ALONE = ["packages/cli/test/twoPeers.test.ts"];

/** The workspaces `npm run test:packages` tests, in its order, with their folders. */
export function packages() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const script = pkg.scripts["test:packages"];
  // Any scope: `@ghostly/core`, or `@ghostlytools/cli`, the name the CLI has on npm.
  const match = /^npm run test((?: -w @?[\w/-]+)+)$/.exec(script);
  if (!match) throw new Error(`test:packages is "${script}": tools/scripts/test-shards.mjs only knows "npm run test -w <workspace> ..."`);
  const names = match[1].trim().split(/\s+/).filter((w) => w !== "-w");
  const folders = new Map();
  for (const pattern of pkg.workspaces) {
    const dirs = pattern.endsWith("/*") ? readdirSync(join(root, pattern.slice(0, -2))).map((d) => `${pattern.slice(0, -2)}/${d}`) : [pattern];
    for (const dir of dirs) {
      const file = join(root, dir, "package.json");
      if (existsSync(file)) folders.set(JSON.parse(readFileSync(file, "utf8")).name, dir);
    }
  }
  return names.map((name) => {
    const dir = folders.get(name);
    if (!dir) throw new Error(`no workspace named ${name}`);
    const test = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).scripts?.test;
    // The shards run `vitest run` themselves, with file filters: a package that tests another way needs a change here.
    if (test !== "vitest run") throw new Error(`${name}'s test script is "${test}", not "vitest run"`);
    return { name, dir };
  });
}

function vitest(dir, args, options = {}) {
  return spawnSync("npx", ["--no-install", "vitest", ...args], { cwd: join(root, dir), encoding: "utf8", maxBuffer: 64 << 20, ...options });
}

/** The test files Vitest selects in a package (repository paths, sorted), for these filters (all when none). */
function listed(dir, filters = []) {
  // `--json <path>`: a bare --json before a filter would take the filter as the path to write to.
  const out = join(mkdtempSync(join(tmpdir(), "test-shards-")), "list.json");
  const run = vitest(dir, ["list", ...filters, "--filesOnly", `--json=${out}`]);
  if (run.status !== 0) throw new Error(`vitest list in ${dir} failed:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(readFileSync(out, "utf8")).map((t) => relative(root, t.file)).sort();
}

/**
 * Units (a package's files, or one ALONE file) to shards. ALONE units first, one per shard, which nothing else
 * joins; then heaviest first to the least loaded of the others. Ties go by name and by shard number, so every
 * shard computes the same split.
 * @param {{ id: string, dir: string, files: string[], alone: boolean }[]} units
 * @param {Record<string, number>} seconds
 */
export function split(units, seconds, of) {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (u) => u.files.reduce((sum, f) => sum + (seconds[f] ?? typical), 0);
  const alone = units.filter((u) => u.alone);
  if (alone.length >= of) throw new Error(`${alone.length} files run alone: that needs more than ${of} shards`);
  const shards = Array.from({ length: of }, () => ({ load: 0, units: [], alone: false }));
  const order = (a, b) => weight(b) - weight(a) || (a.id < b.id ? -1 : 1);
  for (const [i, unit] of [...alone].sort(order).entries()) Object.assign(shards[i], { load: weight(unit), units: [unit], alone: true });
  for (const unit of units.filter((u) => !u.alone && u.files.length).sort(order)) {
    const lightest = shards.filter((s) => !s.alone).reduce((best, s) => (s.load < best.load ? s : best));
    lightest.load += weight(unit);
    lightest.units.push(unit);
  }
  return shards;
}

/** Every package's files as units: the package, less its ALONE files, and each ALONE file. */
function units() {
  const out = [];
  for (const { name, dir } of packages()) {
    const files = listed(dir);
    const alone = files.filter((f) => ALONE.includes(f));
    out.push({ id: name, dir, files: files.filter((f) => !alone.includes(f)), alone: false, whole: !alone.length });
    for (const file of alone) out.push({ id: file, dir, files: [file], alone: true, whole: false });
  }
  for (const file of ALONE) if (!out.some((u) => u.alone && u.files[0] === file)) throw new Error(`ALONE names ${file}, which no package's Vitest lists`);
  return out;
}

const describe = (shards) => shards.map((s, i) => `  ${i + 1}: about ${Math.round(s.load)} s of test time: ${s.units.map((u) => (u.alone ? u.id : `${u.id} (${u.files.length} file${u.files.length === 1 ? "" : "s"})`)).join(", ") || "nothing"}`).join("\n");

function main(argv) {
  const [first, ...rest] = argv;
  const seconds = () => JSON.parse(readFileSync(durationsFile, "utf8"));

  if (first === "--record") {
    const recorded = {};
    for (const file of rest) {
      for (const result of JSON.parse(readFileSync(file, "utf8")).testResults) {
        if (result.status !== "passed" || !result.endTime) continue;
        // A report from CI names the runner's checkout: the file is the longest end of its path that is here.
        const parts = result.name.split("/");
        const path = parts.map((_, i) => parts.slice(i).join("/")).find((p) => p && existsSync(join(root, p)));
        if (path) recorded[path] = Math.round((result.endTime - result.startTime) / 100) / 10;
      }
    }
    // Files recorded now replace their old times; a file no longer there is dropped.
    const merged = { ...seconds(), ...recorded };
    const sorted = Object.fromEntries(Object.entries(merged).filter(([f]) => existsSync(join(root, f))).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(durationsFile, JSON.stringify(sorted, null, 2) + "\n");
    console.log(`Recorded ${Object.keys(recorded).length} files; tools/scripts/test-durations.json has ${Object.keys(sorted).length}.`);
    return 0;
  }

  if (first === "--plan") {
    const of = Number(rest[0]);
    if (!Number.isInteger(of) || of < 1) return usage();
    const all = units();
    const shards = split(all, seconds(), of);
    console.log(`${of} shards:\n${describe(shards)}`);
    const every = all.flatMap((u) => u.files).sort();
    const assigned = shards.flatMap((s) => s.units.flatMap((u) => u.files)).sort();
    if (every.join("\n") !== assigned.join("\n") || new Set(every).size !== every.length) {
      console.error(`The shards hold ${assigned.length} files, the packages ${every.length}: some file is missing or twice.`);
      return 1;
    }
    console.log(`Every one of the ${every.length} test files is in exactly one shard.`);
    return 0;
  }

  const shard = Number(first);
  const of = Number(rest[0]);
  if (!Number.isInteger(shard) || !Number.isInteger(of) || shard < 1 || shard > of) return usage();
  const reportIndex = rest.indexOf("--report-dir");
  const reportDir = reportIndex >= 0 ? resolve(rest[reportIndex + 1]) : null;
  if (reportDir) mkdirSync(reportDir, { recursive: true });

  const shards = split(units(), seconds(), of);
  const mine = shards[shard - 1];
  console.log(`Shard ${shard}/${of} of npm run test:packages. All shards:\n${describe(shards)}`);
  let failed = 0;
  for (const unit of mine.units) {
    // A whole package runs as `npm test` runs it; part of one runs by its files, which Vitest must select exactly.
    const filters = unit.whole ? [] : unit.files.map((f) => join(root, f));
    if (!unit.whole) {
      const selected = listed(unit.dir, filters);
      if (selected.join("\n") !== [...unit.files].sort().join("\n")) {
        console.error(`::error::Vitest selects other files than this shard's in ${unit.dir}: want ${unit.files.length}, got ${selected.length}`);
        failed++;
        continue;
      }
    }
    const tag = unit.alone ? unit.id.split("/").pop().replace(/\.test\.tsx?$/, "") : unit.id.replace(/^@ghostly\//, "");
    const reports = reportDir ? ["--reporter=default", "--reporter=json", `--outputFile.json=${join(reportDir, `${tag}.json`)}`] : [];
    console.log(`\n=== ${unit.id} in ${unit.dir}${unit.whole ? "" : ` (${unit.files.length} files)`}`);
    const started = Date.now();
    const run = vitest(unit.dir, ["run", ...filters, ...reports], { stdio: "inherit" });
    console.log(`=== ${unit.id}: ${run.status === 0 ? "passed" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)} s`);
    if (run.status !== 0) failed++;
  }
  return failed ? 1 : 0;
}

function usage() {
  console.error("usage: node tools/scripts/test-shards.mjs <shard> <of> [--report-dir <dir>] | --plan <of> | --record <report.json>...");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
