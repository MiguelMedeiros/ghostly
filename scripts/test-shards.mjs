#!/usr/bin/env node
// Runs one CI shard of `npm run test:packages`: `node scripts/test-shards.mjs <shard> <of> [--report-dir <dir>]`.
//
// One runner took 6.5 minutes for the packages' unit tests, one package after another (core 86 s, browser 104 s,
// cli 178 s). Here they split into shards of about the same time, each on its own runner. The unit is a package:
// its files run in parallel inside one Vitest, and cutting a package in two pays its imports twice. A file in ALONE
// is a unit of its own that no other unit joins: the CLI's two-peer story (twoPeers.test.ts, about 4 minutes of
// designed waits in one sequence of tests) would set the floor, so nothing else waits behind it or loads its runner.
// A file in PARTS is cut further, by test name, into parts that each have a shard of their own.
// Heaviest first to the least loaded shard, by the seconds CI took per file (scripts/test-durations.json; a file not
// in it counts as a typical one). A package counts for its longest file, or for its files' sum over PARALLEL when
// that is more: its files run side by side. A stale durations file only unbalances the shards, it never drops a
// test: every file Vitest lists for a package goes to exactly one shard, every test of a file in PARTS to at least
// one part, and a shard that runs part of a package or of a file checks that Vitest selects exactly that part.
//
//   node scripts/test-shards.mjs --plan 4           # print the 4 shards and check every file is in exactly one
//   node scripts/test-shards.mjs --record a.json …  # scripts/test-durations.json from Vitest JSON reports
//
// CI's packages shards upload their JSON reports (artifact "packages-test-reports-<shard>"): download them all and
// --record them after adding a slow test file.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const durationsFile = join(root, "scripts/test-durations.json");

/** Files that run on a shard of their own (repository paths). */
export const ALONE = ["packages/cli/test/twoPeers.test.ts"];

/**
 * Files in ALONE cut into parts by test name (Vitest's -t), each part on a shard of its own. Every part runs `setup`
 * (the tests all the others build on) and then its own tests, in the file's order; the last part is every test no
 * earlier part names, so a test added to the file runs there, and no test runs nowhere. A part must hold whatever
 * its tests read from the ones before them. A name here that the file no longer has fails the shard: rename it here.
 */
export const PARTS = {
  // Two daemons paired once; then chats (about 2 minutes), then groups (about 2 minutes). "react" reads the message
  // "typing" sends; "forward" and the one-shot use the groups made in the second part.
  "packages/cli/test/twoPeers.test.ts": {
    setup: ["set up profiles offline, as one-shots", "pair from an invite and go live"],
    parts: [
      [
        "a daemon that restarts is live with its contact again in seconds, stopped or killed (WISP 100, Back after a restart)",
        "move a chat to native HyperDHT when asked",
        "carry messages both ways, with events a bot can act on",
        "show the contact this side is typing, and its stream says when it started and stopped",
        "keep typing on with --for until the time is up, or a message ends it",
        "show the contact a bot is thinking, with its status, and then recording",
        "hold a chat off its direct link: the contact does not redial, text still goes over the DHT, chat connect ends it",
        "call by voice: auto-answer, audio both ways over the socket and `call pipe`, hang-up events",
        "the call-echo example answers, greets with its WAV, and echoes the caller a second later",
        "react to a message: the contact's stream says it, its history shows it, a new one replaces it, --remove takes it back",
        "update a status in place: send it, edit it three times, the contact sees the last text and each edit once",
        "send files: a small one taken at once, a large one only once accepted, saved byte for byte",
        "send a voice note from a file: its length and waveform measured here, the contact sees the bars",
        "prove an SSH key with ssh-keygen and show it to the contact, who checks it",
        "share a web app on this machine with the contact, who opens it on a port of its own",
        "answer from a hook: an echo bot on listen --exec",
      ],
      // The rest: the community group, forwarding into it, the private mesh group and its edits, the one-shot.
    ],
  },
};

/** How many of a package's files run at once, near enough: on CI's 4 cores a package takes about its sum over 2. */
export const PARALLEL = 2;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The -t pattern of part `index` (0-based) of a PARTS entry. Vitest matches it against the test's names joined by
 * spaces, after a prefix of its own: a test's own name is the end of that.
 */
export function partPattern({ setup, parts }, index) {
  if (index < parts.length) return ` (?:${[...setup, ...parts[index]].map(escape).join("|")})$`;
  return `^(?!.* (?:${parts.flat().map(escape).join("|")})$)`;
}

/** The workspaces `npm run test:packages` tests, in its order, with their folders. */
export function packages() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const script = pkg.scripts["test:packages"];
  const match = /^npm run test((?: -w @[\w/-]+)+)$/.exec(script);
  if (!match) throw new Error(`test:packages is "${script}": scripts/test-shards.mjs only knows "npm run test -w <workspace> ..."`);
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

/** The tests Vitest selects in one file for a -t pattern (all when none), each as its names joined by " > ". */
function listedTests(dir, file, pattern) {
  const out = join(mkdtempSync(join(tmpdir(), "test-shards-")), "list.json");
  const run = vitest(dir, ["list", join(root, file), ...(pattern ? ["-t", pattern] : []), `--json=${out}`]);
  if (run.status !== 0) throw new Error(`vitest list ${file} failed:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(readFileSync(out, "utf8")).map((t) => t.name);
}

/**
 * The tests each part of a PARTS file must run, from all its tests (names joined by " > "): part i its setup and its
 * own, the last one every test no earlier part names. Throws for a name the file does not have.
 */
export function partTests(all, { setup, parts }) {
  const named = (name) => (test) => test === name || test.endsWith(` > ${name}`);
  for (const name of [...setup, ...parts.flat()]) {
    if (!all.some(named(name))) throw new Error(`scripts/test-shards.mjs PARTS names a test the file no longer has: "${name}"`);
  }
  const own = (names) => all.filter((t) => names.some((n) => named(n)(t)));
  return [...parts.map((names) => own([...setup, ...names])), all.filter((t) => !parts.flat().some((n) => named(n)(t)))];
}

/**
 * Units (a package's files, one ALONE file, or a part of one) to shards. ALONE units first, one per shard, which
 * nothing else joins; then heaviest first to the least loaded of the others. Ties go by name and by shard number, so
 * every shard computes the same split.
 * @param {{ id: string, dir: string, files: string[], alone: boolean, share?: number }[]} units
 * @param {Record<string, number>} seconds
 */
export function split(units, seconds, of) {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 1;
  const times = (u) => u.files.map((f) => seconds[f] ?? typical);
  const sum = (u) => times(u).reduce((a, b) => a + b, 0);
  // An ALONE file runs its tests one after another (a part of it, its share of them); a package's files side by side.
  const weight = (u) => (u.alone ? sum(u) * (u.share ?? 1) : Math.max(0, ...times(u), sum(u) / PARALLEL));
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

/** Every package's files as units: the package, less its ALONE files, and each ALONE file or each of its PARTS. */
function units() {
  const out = [];
  for (const { name, dir } of packages()) {
    const files = listed(dir);
    const alone = files.filter((f) => ALONE.includes(f));
    out.push({ id: name, dir, files: files.filter((f) => !alone.includes(f)), alone: false, whole: !alone.length });
    for (const file of alone) {
      const cut = PARTS[file];
      if (!cut) {
        out.push({ id: file, dir, files: [file], alone: true, whole: false });
        continue;
      }
      const of = cut.parts.length + 1;
      for (let part = 1; part <= of; part++) out.push({ id: `${file} (part ${part}/${of})`, dir, files: [file], alone: true, whole: false, share: 1 / of, cut, part });
    }
  }
  for (const file of ALONE) if (!out.some((u) => u.alone && u.files[0] === file)) throw new Error(`ALONE names ${file}, which no package's Vitest lists`);
  for (const file of Object.keys(PARTS)) if (!ALONE.includes(file)) throw new Error(`PARTS names ${file}, which is not in ALONE`);
  return out;
}

/** The tests a part of a PARTS file must run, and whether Vitest selects exactly those for its -t pattern. */
function checkPart(unit) {
  const file = unit.files[0];
  const want = partTests(listedTests(unit.dir, file), unit.cut)[unit.part - 1];
  const got = listedTests(unit.dir, file, partPattern(unit.cut, unit.part - 1));
  return { want, ok: want.length > 0 && [...got].sort().join("\n") === [...want].sort().join("\n") };
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
        // A file in PARTS has a report per part: its time is theirs together.
        if (path) recorded[path] = Math.round((recorded[path] ?? 0) * 10 + (result.endTime - result.startTime) / 100) / 10;
      }
    }
    // Files recorded now replace their old times; a file no longer there is dropped.
    const merged = { ...seconds(), ...recorded };
    const sorted = Object.fromEntries(Object.entries(merged).filter(([f]) => existsSync(join(root, f))).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(durationsFile, JSON.stringify(sorted, null, 2) + "\n");
    console.log(`Recorded ${Object.keys(recorded).length} files; scripts/test-durations.json has ${Object.keys(sorted).length}.`);
    return 0;
  }

  if (first === "--plan") {
    const of = Number(rest[0]);
    if (!Number.isInteger(of) || of < 1) return usage();
    const all = units();
    const shards = split(all, seconds(), of);
    console.log(`${of} shards:\n${describe(shards)}`);
    // A file in PARTS counts once, and its parts together must run each of its tests.
    const whole = (list) => list.filter((u) => !u.cut || u.part === 1).flatMap((u) => u.files).sort();
    const every = whole(all);
    const assigned = whole(shards.flatMap((s) => s.units));
    if (every.join("\n") !== assigned.join("\n") || new Set(every).size !== every.length) {
      console.error(`The shards hold ${assigned.length} files, the packages ${every.length}: some file is missing or twice.`);
      return 1;
    }
    console.log(`Every one of the ${every.length} test files is in exactly one shard.`);
    for (const [file, cut] of Object.entries(PARTS)) {
      const dir = all.find((u) => u.files[0] === file).dir;
      const tests = listedTests(dir, file);
      const run = new Set();
      for (const unit of all.filter((u) => u.cut === cut)) {
        const { want, ok } = checkPart(unit);
        if (!ok) {
          console.error(`Vitest selects other tests than ${unit.id} should run (${want.length}).`);
          return 1;
        }
        for (const test of want) run.add(test);
      }
      if (run.size !== tests.length) {
        console.error(`The parts of ${file} run ${run.size} of its ${tests.length} tests.`);
        return 1;
      }
      console.log(`${file}: its ${cut.parts.length + 1} parts run all its ${tests.length} tests.`);
    }
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
    if (unit.cut) {
      let check;
      try {
        check = checkPart(unit);
      } catch (error) {
        check = { ok: false, want: [], why: error.message };
      }
      if (!check.ok) {
        console.error(`::error::${check.why ?? `Vitest selects other tests than ${unit.id} should run (${check.want.length})`}`);
        failed++;
        continue;
      }
      filters.push("-t", partPattern(unit.cut, unit.part - 1));
    }
    const tag = unit.alone ? unit.files[0].split("/").pop().replace(/\.test\.tsx?$/, "") + (unit.cut ? `-${unit.part}` : "") : unit.id.replace(/^@ghostly\//, "");
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
  console.error("usage: node scripts/test-shards.mjs <shard> <of> [--report-dir <dir>] | --plan <of> | --record <report.json>...");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
