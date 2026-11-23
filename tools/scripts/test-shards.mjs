#!/usr/bin/env node
// Runs one CI shard of `npm run test:packages`: `node tools/scripts/test-shards.mjs <shard> <of> [--report-dir <dir>]`,
// or with --app one of `npm run test:app` (its Vitests: the UI's, the matrix's and the scripts'), split the same way.
// test:app took 12.5 minutes on one runner, the UI's 700 files 11 of them, and set the length of a ready run.
//
// One runner took 6.5 minutes for the packages' unit tests, one package after another (core 86 s, browser 104 s,
// cli 178 s). Here they split into shards of about the same time, each on its own runner. The unit is a package:
// its files run in parallel inside one Vitest, and each part of a package cut in two pays a start of Vitest (and the
// package's globalSetup), so only a package too heavy for one shard is cut, by its files (see split). A file in ALONE
// is a unit of its own that runs first on its shard, in a Vitest of its own with nothing beside it: the CLI's
// two-peer story (twoPeers.test.ts, about 2 minutes of designed waits in one sequence of tests) must not share its
// runner. Other units run after it on that shard, so its runner does not idle while the others work.
// Heaviest first to the least loaded shard, by the seconds CI took per file (tools/scripts/test-durations.json; a file not
// in it counts as a typical one). A stale durations file only unbalances the shards, it never drops a test: every
// file Vitest lists for a package goes to exactly one shard, and a shard that runs part of a package checks that
// Vitest selects exactly that part.
//
//   node tools/scripts/test-shards.mjs --plan 4 [--app]   # print the 4 shards and check every file is in exactly one
//   node tools/scripts/test-shards.mjs --integration 1 1  # the integration tests, twoPeers first and alone
//   node tools/scripts/test-shards.mjs --record a.json …  # tools/scripts/test-durations.json from Vitest JSON reports
//
// CI's shards upload their JSON reports (artifacts "packages-test-reports-<shard>" and "app-test-reports-<shard>"):
// download them all and --record them after adding a slow test file; reports of several runs record each file's median.
// --plan and shard 1 warn when over a tenth of the files have no time, and with --report-dir each shard warns, after
// its run, of a file that took far more than its record (see slowWarnings).
//
// The package tests that start real peers, daemons or a DHT (tools/scripts/integration-tests.json, about 40% of the
// packages' time and most of their flakes) are left out of the shards (GHOSTLY_INTEGRATION=0, tools/vitest.shared.ts):
// with --integration this runs only those, on one runner, as CI's Integration tests job (--integration 1 1).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const durationsFile = join(root, "tools/scripts/test-durations.json");

/** Files that run on a shard of their own (repository paths), first on it: today in the integration run. */
export const ALONE = ["packages/cli/test/twoPeers.test.ts"];

/**
 * Vitest's workers on a CI runner (4 cores, a worker per core but one): a package's files share the runner with each
 * other, an ALONE file holds it for its whole time, so it weighs this many times its seconds. Measured on CI: a part
 * of a package took 0.3-0.5 s of the job per second of its files, twoPeers 1 s per second.
 */
export const WORKERS = 3;

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

/**
 * The Vitests `npm run test:app` runs, in its order, from the repository root: each of its `npm run <script>` is
 * `vitest run -c <config>`.
 */
export function appSuites() {
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const names = scripts["test:app"].split(" && ").map((part) => /^npm run ([\w:-]+)$/.exec(part)?.[1]);
  if (names.some((name) => !name)) throw new Error(`test:app is "${scripts["test:app"]}": tools/scripts/test-shards.mjs only knows "npm run <script> && ..."`);
  return names.map((name) => {
    const config = /^vitest run -c (\S+)$/.exec(scripts[name] ?? "")?.[1];
    // The shards run `vitest run -c <config>` themselves, with file filters: a script that tests another way needs a change here.
    if (!config) throw new Error(`${name} is "${scripts[name]}", not "vitest run -c <config>"`);
    return { name, dir: ".", config };
  });
}

/** A Vitest in a suite's folder, with its config when it names one: with the integration files only in the integration run. */
function vitest({ dir, config, integration = false }, [command, ...args], options = {}) {
  const env = { ...process.env, GHOSTLY_INTEGRATION: integration ? "1" : "0" };
  return spawnSync("npx", ["--no-install", "vitest", command, ...(config ? ["-c", config] : []), ...args], { cwd: join(root, dir), encoding: "utf8", maxBuffer: 64 << 20, env, ...options });
}

/** tools/scripts/integration-tests.json's files (repository paths). */
export const integrationFiles = () => JSON.parse(readFileSync(join(root, "tools/scripts/integration-tests.json"), "utf8")).map((entry) => entry.file);

/**
 * The integration files no unit runs and tools/scripts/quarantine.json does not hold: renamed or removed, so the
 * integration run would pass without them.
 * @param {{ files: string[] }[]} units
 * @param {string[]} list
 * @param {string[]} quarantined
 */
export function integrationLeft(units, list, quarantined) {
  return list.filter((file) => !quarantined.includes(file) && !units.some((u) => u.files.includes(file)));
}

/** The test files Vitest selects in a suite (repository paths, sorted), for these filters (all when none). */
function listed(suite, filters = []) {
  // `--json <path>`: a bare --json before a filter would take the filter as the path to write to.
  const out = join(mkdtempSync(join(tmpdir(), "test-shards-")), "list.json");
  const run = vitest(suite, ["list", ...filters, "--filesOnly", `--json=${out}`]);
  if (run.status !== 0) throw new Error(`vitest list in ${suite.dir}${suite.config ? ` -c ${suite.config}` : ""} failed:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(readFileSync(out, "utf8")).map((t) => relative(root, t.file)).sort();
}

/**
 * Units (a package's files, or one ALONE file) to shards. ALONE units first, one per shard, each as its shard's first
 * unit; then heaviest first to the least loaded shard, which runs them after. A package heavier than the fair share
 * cannot fit in one: its files go one by one, heaviest first, and the files of it that land on the same shard run as
 * one part of it (@ghostly/browser was over a third of all the time, and its shard alone set CI's length). Ties go by
 * name, by file and by shard number, so every shard computes the same split.
 * @param {{ id: string, dir: string, files: string[], alone: boolean, whole?: boolean }[]} units
 * @param {Record<string, number>} seconds
 */
export function split(units, seconds, of) {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (u) => u.files.reduce((sum, f) => sum + (seconds[f] ?? typical), 0) * (u.alone ? WORKERS : 1);
  const alone = units.filter((u) => u.alone);
  if (alone.length > of) throw new Error(`${alone.length} files run alone: that needs at least ${alone.length} shards`);
  const shards = Array.from({ length: of }, () => ({ load: 0, units: [] }));
  const order = (a, b) => weight(b) - weight(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.files[0] < b.files[0] ? -1 : 1);
  for (const [i, unit] of [...alone].sort(order).entries()) Object.assign(shards[i], { load: weight(unit), units: [unit] });
  const rest = units.filter((u) => !u.alone && u.files.length);
  const share = units.reduce((sum, u) => sum + weight(u), 0) / of;
  const pieces = rest.flatMap((u) => (weight(u) > share ? u.files.map((f) => ({ ...u, files: [f], of: u })) : [u]));
  for (const piece of pieces.sort(order)) {
    const lightest = shards.reduce((best, s) => (s.load < best.load ? s : best));
    lightest.load += weight(piece);
    const part = piece.of && lightest.units.find((u) => u.of === piece.of);
    if (part) part.files.push(...piece.files);
    else lightest.units.push(piece);
  }
  // A cut package's part runs by its files, unless all of them landed on one shard.
  for (const shard of shards) {
    shard.units = shard.units.map(({ of: from, ...unit }) => (from ? { ...unit, files: unit.files.sort(), whole: unit.files.length === from.files.length && from.whole } : unit));
  }
  return shards;
}

/**
 * The ALONE files no unit runs and tools/scripts/quarantine.json does not hold (`quarantined`, its files): renamed or
 * removed. A quarantined file is out of every Vitest's list (the nightly runs it), so the shards plan without it.
 * @param {{ files: string[], alone: boolean }[]} units
 * @param {string[]} quarantined
 */
export function unlistedAlone(units, quarantined) {
  return ALONE.filter((file) => !quarantined.includes(file) && !units.some((u) => u.alone && u.files[0] === file));
}

/**
 * Every suite's files as units: the suite, less its ALONE files, and each ALONE file (a package's: test:app has none).
 * `integration`: the packages' integration files only, each package's run by its files.
 */
function units(app, integration = false) {
  const list = integrationFiles();
  const out = [];
  for (const { name, dir, config } of app ? appSuites() : packages()) {
    if (integration && !list.some((f) => f.startsWith(`${dir}/`))) continue;
    const files = listed({ dir, config, integration }).filter((f) => !integration || list.includes(f));
    const alone = files.filter((f) => ALONE.includes(f));
    out.push({ id: name, dir, config, integration, files: files.filter((f) => !alone.includes(f)), alone: false, whole: !integration && !alone.length });
    for (const file of alone) out.push({ id: file, dir, config, integration, files: [file], alone: true, whole: false });
  }
  if (app) return out;
  const quarantined = JSON.parse(readFileSync(join(root, "tools/scripts/quarantine.json"), "utf8")).map((entry) => entry.file);
  if (integration) for (const file of integrationLeft(out, list, quarantined)) throw new Error(`tools/scripts/integration-tests.json names ${file}, which no package's Vitest lists`);
  for (const file of unlistedAlone(out, [...quarantined, ...(integration ? [] : list)])) throw new Error(`ALONE names ${file}, which no package's Vitest lists`);
  return out;
}

/**
 * A warning when more than a tenth of the test files have no recorded time (each counts as a typical file, so the
 * shards drift apart as slow new files pile up), or null. As a GitHub annotation, it shows on the CI run.
 * @param {{ files: string[] }[]} units
 * @param {Record<string, number>} seconds
 * @param {"packages" | "app" | "integration"} suite
 * @param {number} [of] the run's shards
 */
export function staleWarning(units, seconds, suite = "packages", of) {
  const files = units.flatMap((u) => u.files);
  const missing = files.filter((f) => !(f in seconds)).sort();
  if (missing.length * 10 <= files.length) return null;
  const named = missing.slice(0, 10).join(", ") + (missing.length > 10 ? ` and ${missing.length - 10} more` : "");
  const { effect, artifacts, them } = timesFor(suite, of);
  return `::warning::${missing.length} of the ${files.length} test files have no time in tools/scripts/test-durations.json (${named}), so ${effect}: download the ${artifacts} of a green run and node tools/scripts/test-shards.mjs --record ${them}.`;
}

/**
 * What a run's recorded times are for, and the CI artifacts its reports upload as. Shards split by them; the
 * integration tests on one runner (--integration 1 1) only order their packages by them, and upload one artifact,
 * "integration-test-reports" (its shards, "integration-test-reports-<shard>").
 * @param {"packages" | "app" | "integration"} suite
 * @param {number} [of] the run's shards
 */
function timesFor(suite, of) {
  if (suite === "integration" && of === 1) return { effect: "the integration run orders its packages by out-of-date times", artifacts: "integration-test-reports artifact", them: "its reports" };
  return { effect: `the ${suite} shards are uneven`, artifacts: `${suite}-test-reports-* artifacts`, them: "them" };
}

/**
 * A file's seconds in Vitest JSON reports, by repository path: the passed files only, as --record keeps them. A file
 * in reports of several runs gets its median time: one slow runner does not make it the heaviest file of its shard.
 */
export function reportTimes(reportFiles) {
  const runs = {};
  for (const file of reportFiles) {
    for (const result of JSON.parse(readFileSync(file, "utf8")).testResults) {
      if (result.status !== "passed" || !result.endTime) continue;
      // A report from CI names the runner's checkout: the file is the longest end of its path that is here.
      const parts = result.name.split("/");
      const path = parts.map((_, i) => parts.slice(i).join("/")).find((p) => p && existsSync(join(root, p)));
      if (path) (runs[path] ??= []).push(result.endTime - result.startTime);
    }
  }
  const median = (ms) => {
    const sorted = ms.sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  return Object.fromEntries(Object.entries(runs).map(([path, ms]) => [path, Math.round(median(ms) / 100) / 10]));
}

/** Seconds a file may take before its run asks for a --record: with no record, or this much over twice its record. */
export const SLOW = 30;

/**
 * Warnings for the files of a shard's reports that the split weighed far too light: one with no recorded time that
 * took over SLOW seconds (it counted as a typical file, under a second), or one that took over twice its record and
 * SLOW seconds more. A few such files unbalance the shards long before a tenth of them miss a time (staleWarning), so
 * this names them on the run of the PR that adds them, when their author can --record them.
 * @param {string[]} reportFiles
 * @param {Record<string, number>} seconds
 * @param {"packages" | "app" | "integration"} suite
 * @param {number} [of] the run's shards
 */
export function slowWarnings(reportFiles, seconds, suite = "packages", of) {
  const { effect, artifacts } = timesFor(suite, of);
  return Object.entries(reportTimes(reportFiles))
    .filter(([file, took]) => (file in seconds ? took > 2 * seconds[file] && took > seconds[file] + SLOW : took > SLOW))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, took]) => `::warning file=${file}::${file} took ${took} s, but tools/scripts/test-durations.json ${file in seconds ? `has ${seconds[file]} s for it` : "has no time for it (it counts as a typical file)"}, so ${effect}: --record this run's ${artifacts} (node tools/scripts/test-shards.mjs --record).`);
}

const describe = (shards) => shards.map((s, i) => `  ${i + 1}: about ${Math.round(s.load)} s of test time: ${s.units.map((u) => (u.alone ? u.id : `${u.id} (${u.files.length} file${u.files.length === 1 ? "" : "s"})`)).join(", ") || "nothing"}`).join("\n");

function main(args) {
  const app = args.includes("--app");
  const integration = args.includes("--integration");
  if (app && integration) return usage();
  const suite = app ? "app" : integration ? "integration" : "packages";
  const command = app ? "npm run test:app" : integration ? "the integration tests" : "npm run test:packages";
  const [first, ...rest] = args.filter((a) => a !== "--app" && a !== "--integration");
  const seconds = () => JSON.parse(readFileSync(durationsFile, "utf8"));

  if (first === "--record") {
    const recorded = reportTimes(rest);
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
    const all = units(app, integration);
    const shards = split(all, seconds(), of);
    console.log(`${of} shards of ${command}:\n${describe(shards)}`);
    const stale = staleWarning(all, seconds(), suite, of);
    if (stale) console.log(stale);
    const every = all.flatMap((u) => u.files).sort();
    const assigned = shards.flatMap((s) => s.units.flatMap((u) => u.files)).sort();
    if (every.join("\n") !== assigned.join("\n") || new Set(every).size !== every.length) {
      console.error(`The shards hold ${assigned.length} files, the ${app ? "suites" : "packages"} ${every.length}: some file is missing or twice.`);
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

  const all = units(app, integration);
  const shards = split(all, seconds(), of);
  const mine = shards[shard - 1];
  console.log(`Shard ${shard}/${of} of ${command}. All shards:\n${describe(shards)}`);
  const stale = staleWarning(all, seconds(), suite, of);
  // One annotation per run, not one per shard.
  if (stale && shard === 1) console.log(stale);
  let failed = 0;
  const written = [];
  for (const unit of mine.units) {
    // A whole package runs as `npm test` runs it; part of one runs by its files, which Vitest must select exactly.
    const filters = unit.whole ? [] : unit.files.map((f) => join(root, f));
    if (!unit.whole) {
      const selected = listed(unit, filters);
      if (selected.join("\n") !== [...unit.files].sort().join("\n")) {
        console.error(`::error::Vitest selects other files than this shard's in ${unit.config ?? unit.dir}: want ${unit.files.length}, got ${selected.length}`);
        failed++;
        continue;
      }
    }
    // An artifact's paths take no ":", so test:ui's report is ui.json.
    const tag = unit.alone ? unit.id.split("/").pop().replace(/\.test\.tsx?$/, "") : unit.id.replace(/^@ghostly\//, "").replace(/^test:/, "");
    const report = reportDir && join(reportDir, `${tag}.json`);
    const reports = report ? ["--reporter=default", "--reporter=json", `--outputFile.json=${report}`] : [];
    console.log(`\n=== ${unit.id} in ${unit.config ?? unit.dir}${unit.whole ? "" : ` (${unit.files.length} files)`}`);
    const started = Date.now();
    const run = vitest(unit, ["run", ...filters, ...reports], { stdio: "inherit" });
    console.log(`=== ${unit.id}: ${run.status === 0 ? "passed" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)} s`);
    if (run.status !== 0) failed++;
    if (report && existsSync(report)) written.push(report);
  }
  // Each file runs on one shard, so each slow one is named once.
  for (const warning of slowWarnings(written, seconds(), suite, of)) console.log(warning);
  return failed ? 1 : 0;
}

function usage() {
  console.error("usage: node tools/scripts/test-shards.mjs [--app | --integration] <shard> <of> [--report-dir <dir>] | --plan <of> [--app | --integration] | --record <report.json>...");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
