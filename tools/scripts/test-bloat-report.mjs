// The weekly test-bloat report (node tools/scripts/test-bloat.mjs), out of the CI artifacts already uploaded:
//   packages-test-reports-<shard>  Vitest JSON of the packages shards (ci.yml, kept 14 days)
//   e2e-results                    Playwright JSON of E2E (e2e.yml, kept 14 days)
//   playwright-report-matrix       the nightly E2E (full) matrix's results.json (kept 14 days)
//   e2e-perf-<run>                 the nightly @perf budgets' perf.json (kept 90 days)
// It only reads GitHub (GET requests, artifact zips unpacked in a temp folder), and it is capped so it can't empty the
// token's hourly quota (see "reading GitHub" below): at most --max-calls (200) API calls a run, a stop once a response
// says fewer than 1000 requests are left, and a cache of what it already read. The parsers and the sections below take
// file contents and return plain data, so tools/scripts/test/testBloat.test.ts runs them, and the reader against a fake
// fetch, offline.
// Exit: 0 with the report, a partial one included (each section reading stopped in says what it read); 1 when it
// refuses to start (no token, or the token has under 1000 requests left this hour); 2 for bad arguments.
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.GITHUB_REPOSITORY || "MiguelMedeiros/ghostly";
const ROOT = join(import.meta.dirname, "../..");
const DAY = 86_400_000;
/** A unit case or an e2e test this slow (ms) counts as slow in "never failed and slow". */
export const SLOW = { unit: 1000, e2e: 20_000 };
/** A matrix artifact bigger than this (traces of a bad night) is not downloaded. */
const MAX_MATRIX_BYTES = 30 << 20;
/** At most this many api.github.com requests a run (`--max-calls`). */
export const MAX_CALLS = 200;
/** It starts only with this many requests left in the token's hour, and stops reading once a response says fewer. */
export const MIN_REMAINING = 1000;
export const USAGE = "usage: node tools/scripts/test-bloat.mjs [--since <days>d] [--out <report.md>] [--json | --summary] [--cache <dir>] [--max-calls <n>] | --weak [--json]";

/** The report's options, or null when the arguments are not ones it takes. */
export function parseArgs(argv) {
  const opts = { since: 7, out: null, json: false, summary: false, cache: null, maxCalls: MAX_CALLS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--summary") opts.summary = true;
    else if (argv[i] === "--since" && /^[1-9]\d*d$/.test(argv[i + 1] ?? "")) opts.since = Number.parseInt(argv[++i], 10);
    else if (argv[i] === "--out" && argv[i + 1] && !argv[i + 1].startsWith("--")) opts.out = argv[++i];
    else if (argv[i] === "--cache" && argv[i + 1] && !argv[i + 1].startsWith("--")) opts.cache = argv[++i];
    else if (argv[i] === "--max-calls" && /^[1-9]\d*$/.test(argv[i + 1] ?? "")) opts.maxCalls = Number(argv[++i]);
    else return null;
  }
  return opts.json && opts.summary ? null : opts;
}

// ---------- parsers (file contents in, plain data out) ----------
/** A repository path out of a runner's absolute one (/home/runner/work/ghostly/ghostly/packages/core/test/a.test.ts). */
export const repoPath = (name) => name.replace(/^.*?\/(?=(?:packages|apps|tools|e2e)\/)/, "");
const packageOf = (path) => path.split("/").slice(0, 2).join("/");

/** A Vitest JSON report: each file with its package, seconds and cases. */
export function parseVitest(text) {
  return (JSON.parse(text).testResults ?? []).map((r) => {
    const path = repoPath(r.name);
    const cases = (r.assertionResults ?? []).map((c) => ({ key: `${path} › ${c.fullName ?? c.title}`, status: c.status, ms: c.duration ?? 0 }));
    return { path, pkg: packageOf(path), status: r.status, seconds: r.startTime && r.endTime ? (r.endTime - r.startTime) / 1000 : 0, cases };
  });
}

/** A Playwright JSON report: each test of each project, with its tags, outcome (expected, unexpected, flaky, skipped) and the time of all its tries. */
export function parsePlaywright(text) {
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) {
      const title = [...titles, spec.title].join(" › ");
      tests.push({ path: `e2e/${spec.file}`, title, key: `e2e/${spec.file} › ${title} [${t.projectName}]`, tags: spec.tags ?? [], status: t.status, ms: (t.results ?? []).reduce((sum, r) => sum + (r.duration ?? 0), 0) });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const suite of JSON.parse(text).suites ?? []) walk(suite, []);
  return tests;
}

/** The nightly matrix's results.json (e2e/matrix/reporter.ts): how many scenarios passed, failed and were skipped. */
export function parseMatrix(text) {
  const rows = JSON.parse(text).rows ?? [];
  const passed = rows.filter((r) => r.status === "passed").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  return { passed, failed: rows.length - passed - skipped, skipped, total: rows.length };
}

/** A nightly perf.json (e2e/perf-summary.mjs): how many time budgets were met. */
export function parsePerf(text) {
  const budgets = JSON.parse(text).budgets ?? [];
  return { met: budgets.filter((b) => b.value < b.below).length, total: budgets.length };
}

/** A unit test file's `// covers:` features (as tools/scripts/test-map.mjs reads them) and its test titles. */
export function unitCovers(text) {
  const features = [...text.matchAll(/^[ \t]*(?:\/\/+|\*)[ \t]*covers:[ \t]*(.*)$/gm)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean));
  const titles = [...text.matchAll(/\b(?:it|test)(?:\.\w+)*\(\s*(["'`])((?:(?!\1)[^\\]|\\.)+)\1/g)].map((m) => m[2]);
  return { features, titles };
}

// ---------- the sections ----------
/** An e2e run's tests as files, so they count beside the Vitest files. */
export const e2eFiles = (tests) => Object.values(tests.reduce((by, t) => {
  const f = (by[t.path] ??= { path: t.path, pkg: "e2e", seconds: 0, cases: [] });
  f.seconds += t.ms / 1000;
  f.cases.push(t);
  return by;
}, {}));

/** Files, cases and test minutes (the files' times added up) per package. */
export function totals(files) {
  const by = {};
  for (const f of files) {
    const t = (by[f.pkg] ??= { files: 0, cases: 0, minutes: 0 });
    t.files++;
    t.cases += f.cases.length;
    t.minutes += f.seconds / 60;
  }
  return by;
}

/** Each package now and its change since then (null: no report that old). */
export function growth(now, then) {
  const a = totals(now), b = then && totals(then);
  return Object.keys({ ...a, ...b }).sort().map((pkg) => {
    const n = a[pkg] ?? { files: 0, cases: 0, minutes: 0 }, o = b?.[pkg] ?? { files: 0, cases: 0, minutes: 0 };
    return { pkg, ...n, dFiles: b ? n.files - o.files : null, dCases: b ? n.cases - o.cases : null, dMinutes: b ? n.minutes - o.minutes : null };
  });
}

export const slowest = (files, n = 20) => [...files].sort((a, b) => b.seconds - a.seconds).slice(0, n).map(({ path, pkg, seconds }) => ({ path, pkg, seconds }));

/** The slow cases of the newest run that never failed in any report read (failed: the keys that ever failed), slowest first. */
export const neverFailedSlow = (cases, failed, slowMs) => cases.filter((c) => c.ms >= slowMs && !failed.has(c.key)).sort((a, b) => b.ms - a.ms).map(({ key, ms }) => ({ key, ms }));

/** The e2e tests that passed only on a retry (Playwright's "flaky"), with how many of the runs they did so in. */
export function flakes(runs) {
  const count = new Map();
  for (const tests of runs) for (const t of tests) if (t.status === "flaky") count.set(t.key, (count.get(t.key) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key, times]) => ({ key, times }));
}

const STOP = new Set(["the", "and", "its", "with", "when", "that", "from", "for", "not", "one", "after", "before", "into", "they", "them", "this", "are", "has", "can"]);
const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
/** How alike two test names are: the share of their words (3+ letters, a few small ones left out) they have in common. */
export function similarity(a, b) {
  const A = words(a), B = words(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return A.size && B.size ? both / (A.size + B.size - both) : 0;
}

/** Unit tests and e2e tests on the same feature (`// covers:` and `@feature:`) whose names match this much or more. */
export function pairs(units, e2e, min = 0.5) {
  const byFeature = new Map();
  for (const u of units) for (const f of u.features) for (const title of u.titles) (byFeature.get(f) ?? byFeature.set(f, []).get(f)).push({ path: u.path, title });
  const found = new Map();
  for (const t of e2e) {
    for (const tag of t.tags) {
      for (const u of byFeature.get(tag.replace(/^@?feature:/, "")) ?? []) {
        const score = similarity(u.title, t.title);
        const key = `${u.path} › ${u.title}|${t.path} › ${t.title}`;
        if (score >= min && !found.has(key)) found.set(key, { feature: tag.replace(/^@?feature:/, ""), unit: `${u.path} › ${u.title}`, e2e: `${t.path} › ${t.title}`, score: Math.round(score * 100) / 100 });
      }
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score || (a.unit < b.unit ? -1 : 1));
}

/** The mock-only list of `--weak --json`, counted. */
export function mockOnly(weak) {
  const byFile = {};
  for (const t of weak) byFile[t.path] = (byFile[t.path] ?? 0) + 1;
  const byReason = Object.fromEntries(["calls", "exists", "none"].map((r) => [r, weak.filter((t) => t.reason === r).length]));
  return { total: weak.length, files: Object.keys(byFile).length, byReason, top: Object.entries(byFile).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20).map(([path, tests]) => ({ path, tests })) };
}

// ---------- output ----------
const signed = (n, digits = 0) => {
  if (n === null) return "";
  const r = Number(n.toFixed(digits));
  return `${r >= 0 ? "+" : ""}${r.toFixed(digits)}`;
};
const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ").replaceAll("\n", " ")} |`)].join("\n") : "_none_");
const noData = (x) => (x?.noData ? `no data: ${x.noData}` : null);
const sum = (rows, unit) => rows.filter((r) => (r.pkg === "e2e") !== unit).reduce((s, r) => ({ files: s.files + r.files, cases: s.cases + r.cases, minutes: s.minutes + r.minutes, dFiles: s.dFiles + (r.dFiles ?? 0), dCases: s.dCases + (r.dCases ?? 0), dMinutes: s.dMinutes + (r.dMinutes ?? 0) }), { files: 0, cases: 0, minutes: 0, dFiles: 0, dCases: 0, dMinutes: 0 });

/** How many GitHub calls a run made (what `github()` counted), in a few words. */
const callsText = (c) => (c ? ` (${c.calls} GitHub API calls of at most ${c.max}, ${c.blobs} artifact downloads from the blob host, ${c.hits} artifacts from the cache${c.failures ? `, ${c.failures} FAILED: the sections below miss what those would have read` : ""})` : "");

/** The report as Markdown. */
export function markdown(d) {
  const w = d.window;
  const score = (s) => noData(s) ?? table(["Night", "Result", "Run"], s.map((n) => [n.at.slice(0, 10), n.text, n.run]));
  const run = (r) => (r ? `run ${r.id} (${r.at.slice(0, 10)})` : "no run");
  // What reading stopped short of, under the sections built from it.
  const cut = (...parts) => parts.map((p) => d.partial?.[p]).filter(Boolean).flatMap((note) => [note, ""]);
  return [
    `# Test bloat, ${d.generated.slice(0, 10)} (the last ${d.since} days)`,
    "",
    `Read from ${REPO}'s CI artifacts in ${d.seconds} s${callsText(d.calls)}: the packages reports of dev ${run(w.unitNow)}, against dev ${run(w.unitThen)}; E2E ${run(w.e2eNow)} against ${run(w.e2eThen)} (the newest at least ${d.since} days old); ${w.failedShards} failed packages shards of ${w.failedRuns} failed CI runs; ${w.e2eRuns} E2E runs. Only test:packages and E2E upload their reports: test:app (ui, matrix, scripts) has no data (a Vitest JSON artifact from the frontend-tests job would carry it).`,
    "",
    ...(d.calls?.stop ? [`**Partial:** reading stopped early (${d.calls.stop}). Each section it cut says what it read.`, ""] : []),
    "## Slowest test files",
    "",
    ...cut("unit", "e2e"),
    noData(d.slowest.unit) ?? table(["Unit file", "Seconds"], d.slowest.unit.map((f) => [f.path, f.seconds.toFixed(1)])),
    "",
    noData(d.slowest.e2e) ?? table(["E2E spec", "Seconds (all its tests)"], d.slowest.e2e.map((f) => [f.path, f.seconds.toFixed(0)])),
    "",
    `## Growth per package (against the newest reports at least ${d.since} days old, named above)`,
    "",
    ...cut("unit", "e2e"),
    table(["Package", "Files", "Δ", "Cases", "Δ", "Test minutes", "Δ"], d.growth.map((r) => [r.pkg, r.files, signed(r.dFiles), r.cases, signed(r.dCases), r.minutes.toFixed(1), signed(r.dMinutes, 1)])),
    "",
    "## Slow and never failed",
    "",
    `The reports cover ${w.days} days (these artifacts are kept 14 days), not 90. Unit: never failed in the failed packages shards since ${w.start}; e2e: never failed or retried in the ${w.e2eRuns} E2E runs. Slow: ${SLOW.unit / 1000} s for a unit case, ${SLOW.e2e / 1000} s for an e2e test.`,
    "",
    ...cut("unit", "history", "e2e", "historyE2e"),
    noData(d.neverFailed.unit) ?? `${d.neverFailed.unit.length} unit cases, the 20 slowest:\n\n${table(["Unit case", "ms"], d.neverFailed.unit.slice(0, 20).map((c) => [c.key, Math.round(c.ms)]))}`,
    "",
    noData(d.neverFailed.e2e) ?? `${d.neverFailed.e2e.length} e2e tests, the 20 slowest:\n\n${table(["E2E test", "s"], d.neverFailed.e2e.slice(0, 20).map((c) => [c.key, Math.round(c.ms / 1000)]))}`,
    "",
    "## Mock-only tests",
    "",
    noData(d.mockOnly) ?? `${d.mockOnly.total} tests in ${d.mockOnly.files} files (\`node tools/scripts/test-bloat.mjs --weak\`): ${d.mockOnly.byReason.calls} only check a mock was called, ${d.mockOnly.byReason.exists} only that something exists, ${d.mockOnly.byReason.none} assert nothing.\n\n${table(["File", "Tests"], d.mockOnly.top.map((f) => [f.path, f.tests]))}`,
    "",
    "## Unit and e2e on the same feature, with matching names",
    "",
    ...cut("e2e"),
    noData(d.pairs) ?? `${d.pairs.total} pairs.\n\n${table(["Feature", "Unit", "E2E", "Match"], d.pairs.top.map((p) => [p.feature, p.unit, p.e2e, p.score]))}`,
    "",
    "## Flakes of the week",
    "",
    ...cut("e2e"),
    noData(d.flakes.e2e) ?? `E2E tests that passed only on retry, in ${d.flakes.runs} runs:\n\n${table(["E2E test", "Runs"], d.flakes.e2e.slice(0, 30).map((f) => [f.key, f.times]))}`,
    "",
    `Unit: ${noData(d.flakes.unit) ?? ""}`,
    "",
    "## Nightly and loop scores",
    "",
    ...cut("nightly"),
    "Nightly E2E (full) matrix:", "", score(d.scores.matrix), "", "Nightly @perf budgets:", "", score(d.scores.perf), "", `One's e2e loop: ${noData(d.scores.loop)}`,
    "",
  ].join("\n");
}

/** The five lines the weekly routine posts, from the report's JSON. */
export function summary(d) {
  const u = sum(d.growth, true), e = sum(d.growth, false);
  const part = (t) => `${t.files} files (${signed(t.dFiles)}), ${t.cases} cases (${signed(t.dCases)}), ${t.minutes.toFixed(0)} min (${signed(t.dMinutes, 0)})`;
  const last = (s) => noData(s) ?? (s.length ? `${s[0].text} (${s[0].at.slice(0, 10)})` : "none");
  const list = (x) => noData(x) ?? x.length;
  return [
    `Test bloat ${d.generated.slice(0, 10)}, last ${d.since} days: unit ${part(u)}; e2e ${part(e)}${d.calls?.stop ? `; partial (${d.calls.stop}), see the report` : ""}`,
    `Slowest unit file: ${d.slowest.unit?.[0] ? `${d.slowest.unit[0].path} ${d.slowest.unit[0].seconds.toFixed(0)} s` : "no data"}; slow and never failed in ${d.window.days} days: ${list(d.neverFailed.unit)} unit cases, ${list(d.neverFailed.e2e)} e2e tests`,
    `Mock-only: ${d.mockOnly.noData ? noData(d.mockOnly) : `${d.mockOnly.total} tests in ${d.mockOnly.files} files (${d.mockOnly.byReason.calls} mock calls only, ${d.mockOnly.byReason.exists} exists only, ${d.mockOnly.byReason.none} no assertion)`}`,
    `Unit/e2e pairs with matching names: ${d.pairs.noData ? noData(d.pairs) : d.pairs.total}; e2e passed only on retry: ${d.flakes.e2e.noData ? noData(d.flakes.e2e) : `${d.flakes.e2e.length} tests in ${d.flakes.runs} runs`}`,
    `Nightly matrix: ${last(d.scores.matrix)}; perf budgets: ${last(d.scores.perf)}; One loop: ${noData(d.scores.loop)}`,
  ].join("\n");
}

// ---------- reading GitHub (GET only, capped, cached) ----------
// Three limits keep a run from emptying the token's hour, which the fleet's other work shares:
//   - a budget: at most --max-calls (200) requests to api.github.com, each counted, redirects that stay on
//     api.github.com included. The artifact zips they redirect to come from another host (no token sent there, not
//     the REST quota) and are counted apart as blob downloads.
//   - a rate guard: it starts only with MIN_REMAINING (1000) requests left, and stops reading once any response's
//     x-ratelimit-remaining says fewer.
//   - a cache (--cache, default $XDG_CACHE_HOME/ghostly-test-bloat or ~/.cache/ghostly-test-bloat): an artifact's
//     parsed reports by artifact id (artifacts don't change, so a hit is never fetched again), a finished run's
//     lookups by run id, and each listing, read again only down to the newest item already cached. Entries older
//     than the 14 days CI keeps the artifacts are pruned.
// When the budget or the guard stops it, the report is written from what was read (and what the cache holds), and
// each section reading stopped in says so. The reads go most valuable first, so a short budget still gives the
// headline: the newest dev run's packages shards (and the growth baseline's), then the week's e2e-results, then the
// nightly scores, then the 14-day failure history (the failed CI runs' shards, then the older e2e-results).
const API = "https://api.github.com";
const RETENTION = 14 * DAY;
/** A run's lookups are cached once it is this old: by then it has finished and uploaded all it will. */
const SETTLED = 12 * 3_600_000;

/** Where the cache lives when --cache doesn't say. */
export const defaultCache = (env = process.env) => join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ghostly-test-bloat");

/** A call refused because the budget is spent or the rate guard tripped. */
class Stopped extends Error {}

async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]).catch(() => null); }
  }));
  return out;
}

/**
 * GETs on api.github.com under the budget and the rate guard. `used` counts the calls (per part of the report), the
 * blob downloads, the failures and the cache hits, and says why reading stopped, if it did.
 */
export function github({ token, fetch: send = globalThis.fetch, maxCalls = MAX_CALLS, minRemaining = MIN_REMAINING }) {
  const used = { max: maxCalls, calls: 0, blobs: 0, downloads: 0, hits: 0, failures: 0, remaining: null, stop: null, parts: {} };
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  let part = "start";
  const call = async (url) => {
    if (!used.stop && used.calls >= maxCalls) used.stop = `budget of ${maxCalls} calls reached`;
    if (used.stop) throw new Stopped(used.stop);
    used.calls++;
    used.parts[part] = (used.parts[part] ?? 0) + 1;
    const res = await send(url, { headers, redirect: "manual" });
    const left = res.headers.get("x-ratelimit-remaining");
    if (left !== null && left !== "") {
      used.remaining = Number(left);
      if (used.remaining < minRemaining) used.stop ??= `x-ratelimit-remaining fell to ${left}, under ${minRemaining}`;
    }
    return res;
  };
  const get = async (path) => {
    let url = `${API}/${path}`;
    let res = await call(url);
    for (let hop = 0; res.status >= 300 && res.status < 400 && res.headers.get("location") && hop < 5; hop++) {
      url = new URL(res.headers.get("location"), url).href;
      if (new URL(url).host === "api.github.com") res = await call(url);
      else { used.blobs++; res = await send(url, { redirect: "manual" }); }
    }
    if (!res.ok) { used.failures++; throw new Error(`GET ${path}: ${res.status}`); }
    return res;
  };
  return { get, json: async (path) => (await get(path)).json(), used, part: (name) => { part = name; } };
}

/**
 * The cache folder: artifacts/<id>.json (an artifact's parsed reports), runs/<id>.json (a finished run's lookups),
 * lists/<name>.json (listings). A file's mtime is its artifact's or run's creation, so pruning is a stat per file.
 */
export function openCache(dir, now) {
  for (const sub of ["artifacts", "runs", "lists"]) mkdirSync(join(dir, sub), { recursive: true });
  for (const sub of ["artifacts", "runs"]) {
    for (const f of readdirSync(join(dir, sub))) if (now - statSync(join(dir, sub, f)).mtimeMs > RETENTION) rmSync(join(dir, sub, f), { force: true });
  }
  let n = 0;
  return {
    read: (path) => { try { return JSON.parse(readFileSync(join(dir, path), "utf8")); } catch { return null; } },
    write: (path, value, createdAt) => {
      const file = join(dir, path), tmp = `${file}.${process.pid}.${n++}.tmp`;
      writeFileSync(tmp, JSON.stringify(value));
      renameSync(tmp, file);
      if (createdAt) utimesSync(file, new Date(now), new Date(createdAt));
    },
  };
}

/** The fields of a listed artifact or run that the report reads. */
const slim = (x) => ({
  id: x.id, name: x.name, created_at: x.created_at, expired: x.expired, size_in_bytes: x.size_in_bytes, html_url: x.html_url,
  workflow_run: x.workflow_run && { id: x.workflow_run.id, head_branch: x.workflow_run.head_branch, head_repository_id: x.workflow_run.head_repository_id, repository_id: x.workflow_run.repository_id },
});
const newestFirst = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at);

/**
 * A listing GitHub returns newest first, read a page at a time when asked. Once a page reaches an item already cached
 * and the cache held the whole listing before (`complete`), it stops: the rest is in the cache. Until then, `items()`
 * holds only what was read this run, so a search for the newest match can't skip newer items not yet read.
 */
function listing(gh, cache, now, name, path, key) {
  const file = `lists/${name}.json`;
  const kept = (x) => now - Date.parse(x.created_at) <= RETENTION;
  const saved = cache.read(file) ?? { complete: false, items: [] };
  const old = new Map(saved.items.filter(kept).map((x) => [x.id, x]));
  const fresh = new Map();
  let page = 0, joined = false, done = false, cut = false;
  const items = () => [...new Map([...(joined || done || cut ? old : []), ...fresh]).values()].sort(newestFirst);
  const save = () => cache.write(file, { complete: done, items: items().filter(kept) });
  const self = {
    total: null,
    items,
    finished: () => done || cut,
    /** True when reading stopped (the budget, the guard, a failure) before the listing's end. */
    cut: () => cut,
    async more() {
      if (done || cut) return;
      let body;
      try { body = await gh.json(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${++page}`); } catch {
        cut = true;
        if (fresh.size) save();
        return;
      }
      const got = body[key] ?? [];
      self.total = body.total_count ?? self.total;
      if (got.some((x) => old.has(x.id))) joined = true;
      for (const x of got) fresh.set(x.id, slim(x));
      if (got.length < 100 || !got.every(kept) || (joined && saved.complete) || page >= 50) done = true;
      save();
    },
    async all() { while (!self.finished()) await self.more(); return items(); },
  };
  return self;
}

/** Each artifact kind: which of its files to read, and how. */
const KINDS = {
  vitest: [/\.json$/, (files) => files.flatMap(parseVitest)],
  playwright: [/e2e-results\.json$/, (files) => files.flatMap(parsePlaywright)],
  matrix: [/matrix-summary\/results\.json$/, (files) => files.map(parseMatrix)[0] ?? null],
  perf: [/perf\.json$/, (files) => files.map(parsePerf)[0] ?? null],
};

/** The contents of a zip's plain files whose path matches `pattern` (unzipped in a temp folder, removed again). */
function unzipFiles(zip, pattern) {
  const dir = mkdtempSync(join(tmpdir(), "test-bloat-"));
  try {
    writeFileSync(join(dir, "a.zip"), zip);
    spawnSync("unzip", ["-qo", join(dir, "a.zip"), "-d", join(dir, "out")]);
    // lstat: a link inside a zip is never followed, only plain files are read.
    const walk = (d) => readdirSync(d).flatMap((f) => { const s = lstatSync(join(d, f)); return s.isDirectory() ? walk(join(d, f)) : s.isFile() ? [join(d, f)] : []; });
    return walk(join(dir, "out")).filter((f) => pattern.test(f)).map((f) => readFileSync(f, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `--weak --json`'s list, run beside the downloads. */
const weakList = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(ROOT, "tools/scripts/test-bloat.mjs"), "--weak", "--json"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("close", (code) => resolve(code === 0 ? JSON.parse(out) : null));
});

/** The unit test files that name their features (`// covers:`), with their test titles. */
const unitFiles = () => spawnSync("git", ["ls-files", "*.test.ts", "*.test.tsx", ":!e2e"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean)
  .map((path) => ({ path, ...unitCovers(readFileSync(join(ROOT, path), "utf8")) })).filter((x) => x.features.length);

/**
 * The report's data, read from GitHub under the budget, the guard and the cache, or `{ refused }` when the token has
 * too few requests left to start. `deps` replaces what touches the world: fetch, unzip, now, the weak list, the unit
 * files (the tests pass fakes for all of them).
 */
export async function collect(opts, deps) {
  const began = Date.now(), now = deps.now ?? began, cutoff = now - opts.since * DAY;
  const gh = github({ token: deps.token, fetch: deps.fetch, maxCalls: opts.maxCalls ?? MAX_CALLS });
  const { used } = gh;
  const unzip = deps.unzip ?? unzipFiles;
  const left = await gh.json("rate_limit").then((r) => r.resources?.core?.remaining ?? null, () => null);
  if (left === null) return { refused: "could not read the token's rate limit", calls: used };
  if (left < MIN_REMAINING || used.stop) return { refused: `the token has ${left} GitHub requests left this hour, and test-bloat starts only with ${MIN_REMAINING} or more`, calls: used };
  used.remaining = left;
  const cache = openCache(opts.cache ?? defaultCache(), now);
  const weak = (deps.weak ?? weakList)();

  /** An artifact's parsed reports, from the cache or downloaded once: `{ data }`, or a throw when it was not read. */
  const read = async (a, kind) => {
    const file = `artifacts/${a.id}.json`, hit = cache.read(file);
    if (hit?.kind === kind) { used.hits++; return { data: hit.data }; }
    // Only this repository's own runs: a fork's pull request runs a workflow of its choosing and uploads what it likes.
    const from = a.workflow_run;
    if (from && from.head_repository_id !== from.repository_id) return { data: null };
    const res = await gh.get(`repos/${REPO}/actions/artifacts/${a.id}/zip`);
    const [pattern, parse] = KINDS[kind];
    const data = parse(unzip(Buffer.from(await res.arrayBuffer()), pattern));
    used.downloads++;
    cache.write(file, { kind, data }, a.created_at);
    return { data };
  };
  /** A run's lookup (its artifacts, its failed shards), cached once the run has settled. */
  const lookup = async (id, at, field, fetchIt) => {
    const file = `runs/${id}.json`, entry = cache.read(file);
    if (entry && field in entry) return entry[field];
    const value = await fetchIt();
    if (now - Date.parse(at) > SETTLED) cache.write(file, { ...cache.read(file), [field]: value }, at);
    return value;
  };
  const runArtifacts = (id, at) => lookup(id, at, "artifacts", async () => (await gh.json(`repos/${REPO}/actions/runs/${id}/artifacts?per_page=100`)).artifacts.map(slim));
  const failedShards = (id, at) => lookup(id, at, "failedShards", async () => (await gh.json(`repos/${REPO}/actions/runs/${id}/jobs?filter=latest&per_page=100`)).jobs
    .filter((j) => j.conclusion === "failure" && /^Frontend tests \(packages \d+\//.test(j.name)).map((j) => /packages (\d+)\//.exec(j.name)[1]));
  const partial = {};
  /** Notes a section reading stopped in: `read` of `of` (null: the listing itself was cut, so the total is unknown). */
  const mark = (section, read, of, what) => {
    if (used.stop && (of === null || read < of)) partial[section] = `partial: ${used.stop}; read ${read} of ${of ?? "the"} ${what}`;
  };
  const after = (a, t) => Date.parse(a.created_at) >= t;

  // 1. The newest dev run's packages shards, and the growth baseline's (the newest dev run at least --since old).
  gh.part("unit");
  const packages = listing(gh, cache, now, "packages-test-reports-1", `repos/${REPO}/actions/artifacts?name=packages-test-reports-1`, "artifacts");
  const devRun = async (before) => {
    let first;
    while (!(first = packages.items().find((a) => !a.expired && a.workflow_run?.head_branch === "dev" && Date.parse(a.created_at) <= before)) && !packages.finished()) await packages.more();
    if (!first) return null;
    const run = { id: first.workflow_run.id, at: first.created_at };
    const shards = (await runArtifacts(run.id, first.created_at).catch(() => null))?.filter((a) => a.name.startsWith("packages-test-reports-") && !a.expired);
    const got = shards ? await pool(shards, 4, (a) => read(a, "vitest")) : [];
    const files = got.flatMap((g) => g?.data ?? []);
    return { run, files: files.length ? files : null, whole: !!shards && got.every(Boolean) };
  };
  const devNow = await devRun(now), devThen = await devRun(cutoff);
  const devRuns = [devNow, devThen];
  mark("unit", devRuns.filter((r) => r?.whole).length, packages.cut() ? null : devRuns.filter(Boolean).length, "dev runs' packages reports");

  // 2. The week's e2e-results, newest first, and the newest one at least --since old (the growth baseline).
  gh.part("e2e");
  const e2eList = listing(gh, cache, now, "e2e-results", `repos/${REPO}/actions/artifacts?name=e2e-results`, "artifacts");
  const e2eKept = (await e2eList.all()).filter((a) => !a.expired);
  const e2eFirst = [...new Set([e2eKept[0], e2eKept.find((a) => Date.parse(a.created_at) <= cutoff), ...e2eKept.filter((a) => after(a, cutoff))].filter(Boolean))];
  const e2eRead = (list) => pool(list, 16, async (a) => ({ id: a.workflow_run.id, at: Date.parse(a.created_at), tests: (await read(a, "playwright")).data ?? [] }));
  const e2eWeek = await e2eRead(e2eFirst);
  mark("e2e", e2eWeek.filter(Boolean).length, e2eList.cut() ? null : e2eFirst.length, "e2e-results runs of the week");

  // 3. The nightly matrix and @perf scores.
  gh.part("nightly");
  const matrixList = listing(gh, cache, now, "playwright-report-matrix", `repos/${REPO}/actions/artifacts?name=playwright-report-matrix`, "artifacts");
  const nights = (await matrixList.all()).filter((a) => !a.expired && after(a, cutoff));
  const matrix = await pool(nights, 4, async (a) => {
    const run = `https://github.com/${REPO}/actions/runs/${a.workflow_run.id}`;
    if (a.size_in_bytes > MAX_MATRIX_BYTES) return { at: a.created_at, text: `not read (${Math.round(a.size_in_bytes / 2 ** 20)} MB)`, run };
    const m = (await read(a, "matrix")).data;
    return { at: a.created_at, text: m && `${m.passed}/${m.total} passed, ${m.failed} failed, ${m.skipped} skipped`, run };
  });
  const perfList = listing(gh, cache, now, "e2e-perf-runs", `repos/${REPO}/actions/workflows/e2e-perf.yml/runs`, "workflow_runs");
  const perfRuns = (await perfList.all()).filter((r) => after(r, cutoff));
  const perf = await pool(perfRuns, 4, async (run) => {
    const [a] = (await runArtifacts(run.id, run.created_at)).filter((x) => x.name.startsWith("e2e-perf-") && !x.expired);
    const p = a ? (await read(a, "perf")).data : null;
    return { at: run.created_at, text: p && `${p.met}/${p.total} budgets met`, run: run.html_url };
  });
  mark("nightly", [...matrix, ...perf].filter(Boolean).length, matrixList.cut() || perfList.cut() ? null : nights.length + perfRuns.length, "nightly runs");

  // 4. The 14-day failure history: every failed packages shard of the failed CI runs that kept reports, then the
  //    older e2e-results (they only feed "slow and never failed").
  gh.part("history");
  const kept = (await packages.all()).filter((a) => !a.expired);
  const start = Math.max(now - 90 * DAY, Math.min(now, ...kept.map((a) => Date.parse(a.created_at))));
  const withReports = new Set(kept.map((a) => a.workflow_run?.id));
  const failedList = listing(gh, cache, now, "ci-failed-runs", `repos/${REPO}/actions/workflows/ci.yml/runs?status=failure`, "workflow_runs");
  const failedRuns = (await failedList.all()).filter((r) => withReports.has(r.id) && after(r, start));
  const history = await pool(failedRuns, 8, async (run) => {
    const shards = await failedShards(run.id, run.created_at);
    const artifacts = shards.length ? await runArtifacts(run.id, run.created_at) : [];
    const got = await Promise.all(shards.map((s) => artifacts.find((a) => a.name === `packages-test-reports-${s}`)).filter(Boolean).map((a) => read(a, "vitest")));
    return { shards: shards.length, files: got.flatMap((g) => g.data ?? []) };
  });
  mark("history", history.filter(Boolean).length, packages.cut() || failedList.cut() ? null : failedRuns.length, "failed CI runs (each one's failed packages shards)");
  const e2eRest = e2eKept.filter((a) => !e2eFirst.includes(a));
  const e2eOlder = await e2eRead(e2eRest);
  mark("historyE2e", e2eOlder.filter(Boolean).length, e2eList.cut() ? null : e2eRest.length, "older e2e-results runs");

  const failed = new Set(history.filter(Boolean).flatMap((h) => h.files).flatMap((f) => f.cases).filter((c) => c.status === "failed").map((c) => c.key));
  const runs = [...e2eWeek, ...e2eOlder].filter((r) => r?.tests.length).sort((a, b) => b.at - a.at);
  const e2eFailed = new Set(runs.flatMap((r) => r.tests).filter((t) => t.status === "unexpected" || t.status === "flaky").map((t) => t.key));
  const [eNow, eThen] = [runs[0], runs.find((r) => r.at <= cutoff)];
  const ref = (r) => (r ? { id: r.id, at: new Date(r.at).toISOString() } : null);
  const week = runs.filter((r) => r.at >= cutoff).map((r) => r.tests);
  const unitNow = devNow?.files, unitThen = devThen?.files, e2eNow = eNow?.tests, e2eThen = eThen?.tests;

  const units = (deps.units ?? unitFiles)();
  const weakTests = await weak;
  const allPairs = e2eNow ? pairs(units, e2eNow) : null;
  const none = (artifact) => ({ noData: artifact });
  const files = (vitestFiles, tests) => [...(vitestFiles ?? []), ...(tests ? e2eFiles(tests) : [])];
  return {
    generated: new Date(now).toISOString(), repo: REPO, since: opts.since, seconds: Math.round((Date.now() - began) / 1000),
    window: { unitNow: devNow?.run ?? null, unitThen: devThen?.run ?? null, e2eNow: ref(eNow), e2eThen: ref(eThen), start: new Date(start).toISOString().slice(0, 10), days: Math.round((now - start) / DAY), failedRuns: failedRuns.length, failedShards: history.reduce((n, h) => n + (h?.shards ?? 0), 0), e2eRuns: runs.length },
    slowest: { unit: unitNow ? slowest(unitNow) : none("packages-test-reports-* of a dev run"), e2e: e2eNow ? slowest(e2eFiles(e2eNow)) : none("e2e-results") },
    growth: growth(files(unitNow, e2eNow), unitThen || e2eThen ? files(unitThen, e2eThen) : null),
    neverFailed: { unit: unitNow ? neverFailedSlow(unitNow.flatMap((f) => f.cases), failed, SLOW.unit) : none("packages-test-reports-*"), e2e: e2eNow ? neverFailedSlow(e2eNow, e2eFailed, SLOW.e2e) : none("e2e-results") },
    mockOnly: weakTests ? mockOnly(weakTests) : none("`test-bloat.mjs --weak --json` failed"),
    pairs: allPairs ? { total: allPairs.length, top: allPairs.slice(0, 30) } : none("e2e-results (the e2e side's names and @feature tags)"),
    flakes: { e2e: runs.length ? flakes(week) : none("e2e-results"), runs: week.length, unit: none("packages-test-reports-* are Vitest JSON with no retries (Vitest runs none); a re-run attempt's report would carry them") },
    scores: {
      matrix: matrix.some((m) => m?.text) ? matrix.filter((m) => m?.text) : none("playwright-report-matrix (results.json) of an E2E (full) night"),
      perf: perf.some((p) => p?.text) ? perf.filter((p) => p?.text) : none("e2e-perf-<run> (perf.json): no E2E (perf) run uploaded one in the window"),
      loop: none("One's e2e loop uploads nothing to GitHub (a loop-results artifact would carry it)"),
    },
    calls: used,
    partial,
  };
}

export async function main(argv, deps = {}) {
  const opts = parseArgs(argv);
  if (!opts) { console.error(USAGE); return 2; }
  const token = deps.token ?? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || spawnSync("gh", ["auth", "token"], { encoding: "utf8" }).stdout?.trim());
  if (!token) { console.error("test-bloat: no GITHUB_TOKEN, and `gh auth token` printed none"); return 1; }
  const data = await collect(opts, { ...deps, token });
  if (data.refused) { console.error(`test-bloat: ${data.refused}: run it later, or with another read-only token in GITHUB_TOKEN`); return 1; }
  const text = opts.json ? `${JSON.stringify(data, null, 1)}\n` : opts.summary ? `${summary(data)}\n` : markdown(data);
  if (opts.out) writeFileSync(opts.out, text);
  else process.stdout.write(text);
  const c = data.calls;
  console.error(`test-bloat: ${data.seconds} s, ${c.calls} GitHub API calls of at most ${c.max} (${Object.entries(c.parts).map(([p, n]) => `${p} ${n}`).join(", ")}), ${c.blobs} blob downloads, ${c.hits} artifacts from the cache, ${c.failures} failed; x-ratelimit-remaining ${c.remaining}`);
  if (c.stop) console.error(`test-bloat: stopped reading early (${c.stop}): the report is partial, and each section it cut says what it read`);
  return 0;
}
