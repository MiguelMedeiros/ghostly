// Flaky tests out of the gate for at most 7 days, each with its open flake issue (docs/TESTING.md, "Quarantine").
//
//   node tools/scripts/quarantine.mjs          # the check CI runs: every quarantine is dated, at most 7 days ahead,
//                                              # and (with GHOSTLY_FLAKE_TOKEN) its issue is open and kind:flake
//   node tools/scripts/quarantine.mjs --run    # the nightly: runs the quarantined unit test files
//
// An end-to-end test is quarantined in its spec: the tag "@quarantine" and, above it, `// quarantine: #<issue> until
// <YYYY-MM-DD>`. A unit test file is quarantined in quarantine.json, next to this script: { file, config, issue, until },
// paths from the repository root. The Playwright and Vitest configs leave both out unless GHOSTLY_QUARANTINE=1.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const LIST = "tools/scripts/quarantine.json";
const MAX_DAYS = 7;
const MARK = /\/\/\s*quarantine:\s*#(\d+)\s+until\s+(\S+)/;
// The tag as a whole word of a string: a tag, or a word of a test's or a describe's title. The gate's filter
// (e2e/support/quarantine.ts) drops that same word from titles and tags joined by spaces, so this counts every test it
// drops. A longer tag (@quarantine-later, @quarantine:x) is neither dropped nor counted.
const TAG = /(?<=^|[\s"'`])@quarantine(?=$|[\s"'`])/;
const NEAR = 5;

const plusDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && plusDays(day, 0) === day;

/**
 * One line per quarantine that may not stay: a date past or more than 7 days after `today`, or (when `issues` is
 * given, number to { open, flake }) an issue that is closed, not kind:flake, or not found.
 */
export function checkEntries(entries, { today, issues }) {
  const errors = [];
  const last = plusDays(today, MAX_DAYS);
  for (const { where, issue, until } of entries) {
    if (!isDay(until)) errors.push(`${where}: the quarantine for #${issue} says until "${until}", not a date (YYYY-MM-DD)`);
    else if (until < today) errors.push(`${where}: the quarantine for #${issue} ended on ${until}: fix the test and take it out, or move the date (${MAX_DAYS} days at most)`);
    else if (until > last) errors.push(`${where}: the quarantine for #${issue} lasts until ${until}, more than ${MAX_DAYS} days from today (${last} at most)`);
    if (!issues) continue;
    const state = issues.get(issue);
    if (!state) errors.push(`${where}: the quarantine's issue #${issue} was not found`);
    else if (!state.open) errors.push(`${where}: the quarantine's issue #${issue} is closed: take the test out of quarantine`);
    else if (!state.flake) errors.push(`${where}: the quarantine's issue #${issue} is not labelled kind:flake`);
  }
  return errors;
}

/** A spec's quarantined tests: each "@quarantine" tag with the `// quarantine:` line at most 5 lines above it. */
export function specMarks(file, text) {
  const lines = text.split("\n");
  const entries = [];
  const errors = [];
  const used = new Set();
  lines.forEach((line, i) => {
    if (!TAG.test(line)) return;
    let at = -1;
    for (let j = i; j >= Math.max(0, i - NEAR); j--) if (MARK.test(lines[j])) { at = j; break; }
    if (at < 0) return errors.push(`${file}:${i + 1}: @quarantine without a \`// quarantine: #<issue> until <YYYY-MM-DD>\` line above it`);
    used.add(at);
    const [, issue, until] = MARK.exec(lines[at]);
    entries.push({ where: `${file}:${i + 1}`, issue: Number(issue), until });
  });
  lines.forEach((line, i) => {
    if (MARK.test(line) && !used.has(i)) errors.push(`${file}:${i + 1}: a quarantine line with no @quarantine test under it`);
  });
  return { entries, errors };
}

/** quarantine.json's unit test files, checked to be there (`exists` takes a path from the repository root). */
export function fileEntries(list, exists) {
  const entries = [];
  const errors = [];
  for (const item of list) {
    const { file, config, issue, until } = item ?? {};
    if (typeof file !== "string" || typeof config !== "string" || !Number.isInteger(issue) || typeof until !== "string") {
      errors.push(`${LIST}: an entry needs file, config, issue (a number) and until`);
      continue;
    }
    for (const path of [file, config]) if (!exists(path)) errors.push(`${LIST}: ${path} is not a file`);
    entries.push({ where: file, issue, until });
  }
  return { entries, errors };
}

const readList = () => JSON.parse(readFileSync(join(root, LIST), "utf8"));

/** The e2e's TypeScript files, helpers included (a tag kept in a helper's constant reaches its tests), all but the filter. */
export function e2eSources(dir = "e2e") {
  return readdirSync(join(root, dir), { recursive: true })
    .map((name) => `${dir}/${String(name).replaceAll("\\", "/")}`)
    .filter((path) => path.endsWith(".ts") && !path.includes("node_modules/") && path !== `${dir}/support/quarantine.ts`);
}

/** Each issue's state, from the issues repository (GHOSTLY_FLAKE_REPO) with GHOSTLY_FLAKE_TOKEN. */
async function issueStates(numbers, token, repo) {
  const states = new Map();
  for (const n of new Set(numbers)) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${n}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}#${n}`);
    const issue = await res.json();
    states.set(n, { open: issue.state === "open", flake: issue.labels.some((label) => label.name === "kind:flake") });
  }
  return states;
}

async function check() {
  const unit = fileEntries(readList(), (path) => existsSync(join(root, path)));
  const e2e = e2eSources().map((file) => specMarks(file, readFileSync(join(root, file), "utf8")));
  const entries = [...unit.entries, ...e2e.flatMap((m) => m.entries)];
  const token = process.env.GHOSTLY_FLAKE_TOKEN;
  const repo = process.env.GHOSTLY_FLAKE_REPO || "MiguelMedeiros/ghostly-agents";
  if (entries.length && !token) console.log("::notice::quarantine: GHOSTLY_FLAKE_TOKEN is not set, so the issues are not checked");
  const issues = entries.length && token ? await issueStates(entries.map((e) => e.issue), token, repo) : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const errors = [...unit.errors, ...e2e.flatMap((m) => m.errors), ...checkEntries(entries, { today, issues })];
  for (const error of errors) console.log(`::error::${error}`);
  console.log(`${entries.length} quarantined test${entries.length === 1 ? "" : "s"}, ${errors.length} problem${errors.length === 1 ? "" : "s"}`);
  return errors.length ? 1 : 0;
}

/** The nightly: each quarantined unit test file, run by its own config from its folder, as npm test runs it. */
function run() {
  let failed = 0;
  for (const { file, config } of readList()) {
    console.log(`\n${file} (${config})`);
    const result = spawnSync("npx", ["--no-install", "vitest", "run", "-c", basename(config), join(root, file)], {
      cwd: join(root, dirname(config)),
      stdio: "inherit",
      env: { ...process.env, GHOSTLY_QUARANTINE: "1" },
    });
    if (result.status !== 0) failed++;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = process.argv.includes("--run") ? run() : await check();
}
