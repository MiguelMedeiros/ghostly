// The weekly test-bloat report (node tools/scripts/test-bloat.mjs), out of the CI artifacts already uploaded:
//   packages-test-reports-<shard>  Vitest JSON of the packages shards (ci.yml, kept 14 days)
//   e2e-results                    Playwright JSON of E2E (e2e.yml, kept 14 days)
//   playwright-report-matrix       the nightly E2E (full) matrix's results.json (kept 14 days)
//   e2e-perf-<run>                 the nightly @perf budgets' perf.json (kept 90 days)
// It only reads GitHub (GET requests, artifact zips unpacked in a temp folder). The parsers and the sections below
// take file contents and return plain data, so tools/scripts/test/testBloat.test.ts runs them offline.
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.GITHUB_REPOSITORY || "MiguelMedeiros/ghostly";
const ROOT = join(import.meta.dirname, "../..");
const DAY = 86_400_000;
/** A unit case or an e2e test this slow (ms) counts as slow in "never failed and slow". */
export const SLOW = { unit: 1000, e2e: 20_000 };
/** A matrix artifact bigger than this (traces of a bad night) is not downloaded. */
const MAX_MATRIX_BYTES = 30 << 20;
/**
 * GitHub requests a run may take: it made about 900 on 2026-11-15 (one per failed CI run's jobs, one per E2E run and
 * failed shard). It starts only with this many left in the token's hour, so it never empties a token others share:
 * run it with a read-only token of its own in GITHUB_TOKEN rather than a person's `gh` login.
 */
export const BUDGET = 1500;
export const USAGE = "usage: node tools/scripts/test-bloat.mjs [--since <days>d] [--out <report.md>] [--json | --summary] | --weak [--json]";

/** The report's options, or null when the arguments are not ones it takes. */
export function parseArgs(argv) {
  const opts = { since: 7, out: null, json: false, summary: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--summary") opts.summary = true;
    else if (argv[i] === "--since" && /^[1-9]\d*d$/.test(argv[i + 1] ?? "")) opts.since = Number.parseInt(argv[++i], 10);
    else if (argv[i] === "--out" && argv[i + 1] && !argv[i + 1].startsWith("--")) opts.out = argv[++i];
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

/** The report as Markdown. */
export function markdown(d) {
  const w = d.window;
  const score = (s) => noData(s) ?? table(["Night", "Result", "Run"], s.map((n) => [n.at.slice(0, 10), n.text, n.run]));
  const run = (r) => (r ? `run ${r.id} (${r.at.slice(0, 10)})` : "no run");
  return [
    `# Test bloat, ${d.generated.slice(0, 10)} (the last ${d.since} days)`,
    "",
    `Read from ${REPO}'s CI artifacts in ${d.seconds} s${d.requests ? ` (${d.requests.requests} requests${d.requests.failures ? `, ${d.requests.failures} FAILED: the sections below miss what those would have read` : ""})` : ""}: the packages reports of dev ${run(w.unitNow)}, against dev ${run(w.unitThen)}; E2E ${run(w.e2eNow)} against ${run(w.e2eThen)} (the newest at least ${d.since} days old); ${w.failedShards} failed packages shards of ${w.failedRuns} failed CI runs; ${w.e2eRuns} E2E runs. Only test:packages and E2E upload their reports: test:app (ui, matrix, scripts) has no data (a Vitest JSON artifact from the frontend-tests job would carry it).`,
    "",
    "## Slowest test files",
    "",
    noData(d.slowest.unit) ?? table(["Unit file", "Seconds"], d.slowest.unit.map((f) => [f.path, f.seconds.toFixed(1)])),
    "",
    noData(d.slowest.e2e) ?? table(["E2E spec", "Seconds (all its tests)"], d.slowest.e2e.map((f) => [f.path, f.seconds.toFixed(0)])),
    "",
    `## Growth per package (against the newest reports at least ${d.since} days old, named above)`,
    "",
    table(["Package", "Files", "Δ", "Cases", "Δ", "Test minutes", "Δ"], d.growth.map((r) => [r.pkg, r.files, signed(r.dFiles), r.cases, signed(r.dCases), r.minutes.toFixed(1), signed(r.dMinutes, 1)])),
    "",
    "## Slow and never failed",
    "",
    `The reports cover ${w.days} days (these artifacts are kept 14 days), not 90. Unit: never failed in the failed packages shards since ${w.start}; e2e: never failed or retried in the ${w.e2eRuns} E2E runs. Slow: ${SLOW.unit / 1000} s for a unit case, ${SLOW.e2e / 1000} s for an e2e test.`,
    "",
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
    noData(d.pairs) ?? `${d.pairs.total} pairs.\n\n${table(["Feature", "Unit", "E2E", "Match"], d.pairs.top.map((p) => [p.feature, p.unit, p.e2e, p.score]))}`,
    "",
    "## Flakes of the week",
    "",
    noData(d.flakes.e2e) ?? `E2E tests that passed only on retry, in ${d.flakes.runs} runs:\n\n${table(["E2E test", "Runs"], d.flakes.e2e.slice(0, 30).map((f) => [f.key, f.times]))}`,
    "",
    `Unit: ${noData(d.flakes.unit) ?? ""}`,
    "",
    "## Nightly and loop scores",
    "",
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
    `Test bloat ${d.generated.slice(0, 10)}, last ${d.since} days: unit ${part(u)}; e2e ${part(e)}`,
    `Slowest unit file: ${d.slowest.unit?.[0] ? `${d.slowest.unit[0].path} ${d.slowest.unit[0].seconds.toFixed(0)} s` : "no data"}; slow and never failed in ${d.window.days} days: ${list(d.neverFailed.unit)} unit cases, ${list(d.neverFailed.e2e)} e2e tests`,
    `Mock-only: ${d.mockOnly.noData ? noData(d.mockOnly) : `${d.mockOnly.total} tests in ${d.mockOnly.files} files (${d.mockOnly.byReason.calls} mock calls only, ${d.mockOnly.byReason.exists} exists only, ${d.mockOnly.byReason.none} no assertion)`}`,
    `Unit/e2e pairs with matching names: ${d.pairs.noData ? noData(d.pairs) : d.pairs.total}; e2e passed only on retry: ${d.flakes.e2e.noData ? noData(d.flakes.e2e) : `${d.flakes.e2e.length} tests in ${d.flakes.runs} runs`}`,
    `Nightly matrix: ${last(d.scores.matrix)}; perf budgets: ${last(d.scores.perf)}; One loop: ${noData(d.scores.loop)}`,
  ].join("\n");
}

// ---------- reading GitHub (GET only) ----------
async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]).catch(() => null); }
  }));
  return out;
}

function client(token, dir) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  let requests = 0, failures = 0;
  const get = async (url) => {
    requests++;
    const res = await fetch(url, { headers });
    if (!res.ok) { failures++; throw new Error(`GET ${url}: ${res.status}`); }
    return res;
  };
  const api = async (path) => (await get(`https://api.github.com/repos/${REPO}/${path}`)).json();
  /** Every item of a listing, its pages read 8 at a time. */
  const all = async (path, key, maxPages = 30) => {
    const first = await api(`${path}&per_page=100&page=1`);
    const pages = Math.min(maxPages, Math.ceil((first.total_count ?? 0) / 100));
    const rest = await pool(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 8, (p) => api(`${path}&per_page=100&page=${p}`));
    return [first, ...rest].flatMap((r) => r?.[key] ?? []);
  };
  /** An artifact's files named `name` (their contents), unzipped in the temp folder and removed again. */
  const files = async (artifact, name) => {
    // Only this repository's own runs: a fork's pull request runs a workflow of its choosing and uploads what it likes.
    const from = artifact.workflow_run;
    if (from && from.head_repository_id !== from.repository_id) return [];
    const res = await get(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifact.id}/zip`);
    const zip = join(dir, `${artifact.id}.zip`), out = join(dir, String(artifact.id));
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    spawnSync("unzip", ["-qo", zip, "-d", out]);
    // lstat: a link inside a zip is never followed, only plain files are read.
    const walk = (d) => readdirSync(d).flatMap((f) => { const s = lstatSync(join(d, f)); return s.isDirectory() ? walk(join(d, f)) : s.isFile() ? [join(d, f)] : []; });
    const found = walk(out).filter((f) => name.test(f)).map((f) => readFileSync(f, "utf8"));
    rmSync(out, { recursive: true, force: true });
    rmSync(zip, { force: true });
    return found;
  };
  /** The requests left this hour (GET /rate_limit costs none). */
  const left = async () => (await (await fetch("https://api.github.com/rate_limit", { headers })).json()).resources?.core?.remaining ?? 0;
  return { api, all, files, left, used: () => ({ requests, failures }) };
}

/** The packages reports of the newest dev run in `runs` (shard 1's artifacts) created at or before `before`. */
async function devRun({ api }, runs, before) {
  const first = runs.find((a) => a.workflow_run.head_branch === "dev" && Date.parse(a.created_at) <= before);
  if (!first) return null;
  const artifacts = (await api(`actions/runs/${first.workflow_run.id}/artifacts?per_page=100`)).artifacts.filter((a) => a.name.startsWith("packages-test-reports-") && !a.expired);
  return { run: { id: first.workflow_run.id, at: first.created_at }, artifacts };
}

/** `--weak --json`'s list, run beside the downloads. */
const weakList = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(ROOT, "tools/scripts/test-bloat.mjs"), "--weak", "--json"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("close", (code) => resolve(code === 0 ? JSON.parse(out) : null));
});

export async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) { console.error(USAGE); return 2; }
  const started = Date.now(), cutoff = started - opts.since * DAY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || spawnSync("gh", ["auth", "token"], { encoding: "utf8" }).stdout?.trim();
  if (!token) { console.error("test-bloat: no GITHUB_TOKEN, and `gh auth token` printed none"); return 1; }
  const dir = mkdtempSync(join(tmpdir(), "test-bloat-"));
  try {
    const gh = client(token, dir);
    const left = await gh.left();
    if (left < BUDGET) { console.error(`test-bloat: the token has ${left} GitHub requests left this hour and a report takes up to ${BUDGET}: run it later, or with another read-only token in GITHUB_TOKEN`); return 1; }
    const weak = weakList();
    const vitest = async (found) => (found ? (await pool(found.artifacts, 4, (a) => gh.files(a, /\.json$/))).flat().filter(Boolean).flatMap(parseVitest) : null);

    // Shard 1's artifacts name every run that kept packages reports: the two dev runs, the window, the failed runs.
    const packages = async () => {
      const kept = (await gh.all("actions/artifacts?name=packages-test-reports-1", "artifacts")).filter((a) => !a.expired).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const start = Math.max(started - 90 * DAY, Math.min(started, ...kept.map((a) => Date.parse(a.created_at))));
      const [devNow, devThen] = await Promise.all([devRun(gh, kept, started), devRun(gh, kept, cutoff)]);
      const [now, then] = await Promise.all([vitest(devNow), vitest(devThen)]);
      // Cases fail only in failed runs: read every failed packages shard of the failed CI runs that kept reports.
      const withReports = new Set(kept.map((a) => a.workflow_run.id));
      const failedRuns = (await gh.all(`actions/workflows/ci.yml/runs?status=failure&created=>=${new Date(start).toISOString().slice(0, 10)}`, "workflow_runs")).filter((r) => withReports.has(r.id));
      const shards = (await pool(failedRuns, 16, async (run) => (await gh.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs
        .filter((j) => j.conclusion === "failure" && /^Frontend tests \(packages \d+\//.test(j.name)).map((j) => ({ run: run.id, shard: /packages (\d+)\//.exec(j.name)[1] })))).flat().filter(Boolean);
      const failedFiles = (await pool(shards, 16, async ({ run, shard }) => {
        const [a] = (await gh.api(`actions/runs/${run}/artifacts?name=packages-test-reports-${shard}`)).artifacts;
        return a ? (await gh.files(a, /\.json$/)).flatMap(parseVitest) : [];
      })).flat().filter(Boolean);
      const failed = new Set(failedFiles.flatMap((f) => f.cases).filter((c) => c.status === "failed").map((c) => c.key));
      return { start, devNow, devThen, now, then, failedRuns: failedRuns.length, shards: shards.length, failed };
    };

    const e2e = async () => {
      const kept = (await gh.all("actions/artifacts?name=e2e-results", "artifacts", 5)).filter((a) => !a.expired);
      const runs = (await pool(kept, 16, async (a) => ({ id: a.workflow_run.id, at: Date.parse(a.created_at), tests: (await gh.files(a, /e2e-results\.json$/)).flatMap(parsePlaywright) }))).filter((r) => r?.tests.length).sort((a, b) => b.at - a.at);
      const failed = new Set(runs.flatMap((r) => r.tests).filter((t) => t.status === "unexpected" || t.status === "flaky").map((t) => t.key));
      const [first, old] = [runs[0], runs.find((r) => r.at <= cutoff)];
      const ref = (r) => r && { id: r.id, at: new Date(r.at).toISOString() };
      return { runs, now: first?.tests, then: old?.tests, nowRun: ref(first), thenRun: ref(old), failed, week: runs.filter((r) => r.at >= cutoff).map((r) => r.tests) };
    };

    const nightly = async () => {
      const nights = (await gh.all("actions/artifacts?name=playwright-report-matrix", "artifacts", 1)).filter((a) => !a.expired && Date.parse(a.created_at) >= cutoff);
      const matrix = (await pool(nights, 4, async (a) => {
        const run = `https://github.com/${REPO}/actions/runs/${a.workflow_run.id}`;
        if (a.size_in_bytes > MAX_MATRIX_BYTES) return { at: a.created_at, text: `not read (${Math.round(a.size_in_bytes / 2 ** 20)} MB)`, run };
        const [m] = (await gh.files(a, /matrix-summary\/results\.json$/)).map(parseMatrix);
        return m && { at: a.created_at, text: `${m.passed}/${m.total} passed, ${m.failed} failed, ${m.skipped} skipped`, run };
      })).filter(Boolean);
      const perfRuns = await gh.api(`actions/workflows/e2e-perf.yml/runs?created=>=${new Date(cutoff).toISOString().slice(0, 10)}&per_page=20`).catch(() => ({ workflow_runs: [] }));
      const perf = (await pool(perfRuns.workflow_runs, 4, async (run) => {
        const [a] = (await gh.api(`actions/runs/${run.id}/artifacts?per_page=10`)).artifacts.filter((x) => x.name.startsWith("e2e-perf-") && !x.expired);
        const [p] = a ? (await gh.files(a, /perf\.json$/)).map(parsePerf) : [];
        return p && { at: run.created_at, text: `${p.met}/${p.total} budgets met`, run: run.html_url };
      })).filter(Boolean);
      return { matrix, perf };
    };

    const [u, e, n] = await Promise.all([packages(), e2e(), nightly()]);
    const units = spawnSync("git", ["ls-files", "*.test.ts", "*.test.tsx", ":!e2e"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean)
      .map((path) => ({ path, ...unitCovers(readFileSync(join(ROOT, path), "utf8")) })).filter((x) => x.features.length);
    const weakTests = await weak;
    const allPairs = e.now ? pairs(units, e.now) : null;
    const none = (artifact) => ({ noData: artifact });
    const files = (vitestFiles, tests) => [...(vitestFiles ?? []), ...(tests ? e2eFiles(tests) : [])];
    const data = {
      generated: new Date(started).toISOString(), repo: REPO, since: opts.since, seconds: 0,
      window: { unitNow: u.devNow?.run ?? null, unitThen: u.devThen?.run ?? null, e2eNow: e.nowRun ?? null, e2eThen: e.thenRun ?? null, start: new Date(u.start).toISOString().slice(0, 10), days: Math.round((started - u.start) / DAY), failedRuns: u.failedRuns, failedShards: u.shards, e2eRuns: e.runs.length },
      slowest: { unit: u.now ? slowest(u.now) : none("packages-test-reports-* of a dev run"), e2e: e.now ? slowest(e2eFiles(e.now)) : none("e2e-results") },
      growth: growth(files(u.now, e.now), u.then || e.then ? files(u.then, e.then) : null),
      neverFailed: { unit: u.now ? neverFailedSlow(u.now.flatMap((f) => f.cases), u.failed, SLOW.unit) : none("packages-test-reports-*"), e2e: e.now ? neverFailedSlow(e.now, e.failed, SLOW.e2e) : none("e2e-results") },
      mockOnly: weakTests ? mockOnly(weakTests) : none("`test-bloat.mjs --weak --json` failed"),
      pairs: allPairs ? { total: allPairs.length, top: allPairs.slice(0, 30) } : none("e2e-results (the e2e side's names and @feature tags)"),
      flakes: { e2e: e.runs.length ? flakes(e.week) : none("e2e-results"), runs: e.week.length, unit: none("packages-test-reports-* are Vitest JSON with no retries (Vitest runs none); a re-run attempt's report would carry them") },
      scores: { matrix: n.matrix.length ? n.matrix : none("playwright-report-matrix (results.json) of an E2E (full) night"), perf: n.perf.length ? n.perf : none("e2e-perf-<run> (perf.json): no E2E (perf) run uploaded one in the window"), loop: none("One's e2e loop uploads nothing to GitHub (a loop-results artifact would carry it)") },
    };
    data.seconds = Math.round((Date.now() - started) / 1000);
    data.requests = gh.used();
    const text = opts.json ? `${JSON.stringify(data, null, 1)}\n` : opts.summary ? `${summary(data)}\n` : markdown(data);
    if (opts.out) writeFileSync(opts.out, text);
    else process.stdout.write(text);
    console.error(`test-bloat: ${data.seconds} s, ${data.requests.requests} GitHub requests (${data.requests.failures} failed)`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
