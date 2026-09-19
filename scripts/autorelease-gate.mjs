#!/usr/bin/env node
/**
 * Decides whether a security branch pushed by the security routine may be
 * merged and released without a person looking at it. Runs from `main` in
 * security-autorelease.yml and only reads the branch through the GitHub API:
 * nothing from the branch is executed here.
 *
 * Env: GH_TOKEN, GITHUB_REPOSITORY, BRANCH, HEAD_SHA, MODE ("all" | "deps"),
 *      GITHUB_OUTPUT (set by Actions).
 *
 * Refuses when the branch:
 * - moved since CI ran, or is not on top of the current main
 * - touches CI, release, the scanner, this gate or the advisory allowlist
 * - adds a dependency (only versions of existing ones may change)
 * - changes more than MAX_LINES lines outside lock files
 * - in "deps" mode, touches anything but manifests, lock files and release notes
 * - does not bump the version by exactly one patch, with a changelog entry
 * - comes less than MIN_HOURS after the previous automatic release
 * - did not pass the Security workflow on the same commit
 */
import { appendFileSync } from "node:fs";

const MAX_LINES = 600;
const MIN_HOURS = 20;
const PROTECTED = [/^\.github\//, /^scripts\/(security-scan|autorelease-gate)\.mjs$/, /^SECURITY\.md$/];
const LOCKFILES = new Set(["package-lock.json", "website/package-lock.json", "Cargo.lock"]);
const VERSION_FILES = new Set([
  "package.json",
  "web/package.json",
  "extension/package.json",
  "extension/public/manifest.json",
  "packages/core/package.json",
  "packages/browser/package.json",
  "packages/react/package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "cli/Cargo.toml",
  "website/lib/release.ts",
  "docs/INSTALLATION.md",
  "CHANGELOG.md",
]);
const DEPS_ONLY = (file) =>
  LOCKFILES.has(file) || VERSION_FILES.has(file) || /(^|\/)package\.json$/.test(file) || /(^|\/)Cargo\.toml$/.test(file) || /(^|\/)Dockerfile$/.test(file) || file === "docs/SECURITY-REVIEW.md";

const { GH_TOKEN, GITHUB_REPOSITORY: repo, BRANCH: branch, HEAD_SHA: sha, MODE = "all" } = process.env;
const api = async (path, accept = "application/vnd.github+json") => {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept, "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return accept.endsWith("raw") ? response.text() : response.json();
};
const raw = (path, ref) => api(`/contents/${path}?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw");
const refuse = (why) => {
  console.error(`✗ ${why}`);
  process.exit(1);
};

if (!/^claude\/security-auto-[A-Za-z0-9._-]+$/.test(branch ?? "")) refuse(`not a security branch: ${branch}`);
if (!["all", "deps"].includes(MODE)) refuse(`automatic releases are off (SECURITY_AUTORELEASE=${MODE})`);

const head = await api(`/branches/${encodeURIComponent(branch)}`);
if (head.commit.sha !== sha) refuse("the branch moved after CI ran");

const compare = await api(`/compare/main...${sha}`);
if (compare.behind_by !== 0) refuse(`not on top of main (behind by ${compare.behind_by})`);
if (compare.files.length >= 300) refuse("too many files changed");

const files = compare.files.map((f) => f.filename);
for (const f of compare.files) {
  if (PROTECTED.some((re) => re.test(f.filename)) || (f.previous_filename && PROTECTED.some((re) => re.test(f.previous_filename)))) {
    refuse(`touches a protected path: ${f.filename}`);
  }
}
if (MODE === "deps") {
  const other = files.filter((f) => !DEPS_ONLY(f));
  if (other.length) refuse(`deps mode, but code changed: ${other.join(", ")}`);
}
const lines = compare.files.filter((f) => !LOCKFILES.has(f.filename)).reduce((n, f) => n + f.additions + f.deletions, 0);
if (lines > MAX_LINES) refuse(`${lines} changed lines outside lock files (max ${MAX_LINES})`);

// Only versions may change in lock files: a new name is a new dependency someone should look at.
const npmNames = (text) =>
  new Set(Object.keys(JSON.parse(text).packages ?? {}).filter((p) => p.includes("node_modules/")).map((p) => p.slice(p.lastIndexOf("node_modules/") + 13)));
const cargoNames = (text) => new Set([...text.matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1]));
for (const lock of files.filter((f) => LOCKFILES.has(f))) {
  const names = lock === "Cargo.lock" ? cargoNames : npmNames;
  const before = names(await raw(lock, "main"));
  const added = [...names(await raw(lock, sha))].filter((n) => !before.has(n));
  if (added.length) refuse(`${lock} adds dependencies: ${added.join(", ")}`);
}

const version = (text) => JSON.parse(text).version;
const current = version(await raw("package.json", "main"));
const next = version(await raw("package.json", sha));
const [major, minor, patch] = current.split(".").map(Number);
if (next !== `${major}.${minor}.${patch + 1}`) refuse(`version must go from ${current} to ${major}.${minor}.${patch + 1}, found ${next}`);
const changelog = await raw("CHANGELOG.md", sha);
if (!new RegExp(`^## ${next.replace(/\./g, "\\.")}\\s*$`, "m").test(changelog)) refuse(`CHANGELOG.md has no "## ${next}" section`);
try {
  await api(`/git/ref/tags/v${next}`);
  refuse(`tag v${next} exists already`);
} catch (error) {
  if (!String(error).includes("HTTP 404")) throw error;
}

const releases = await api("/releases?per_page=20");
const lastAuto = releases.find((r) => r.body?.includes("<!-- security-autorelease -->"));
if (lastAuto && Date.now() - Date.parse(lastAuto.created_at) < MIN_HOURS * 3600e3) refuse(`last automatic release was less than ${MIN_HOURS} h ago`);

// The Security workflow runs on the same push; wait for it (up to 15 minutes).
for (let attempt = 0; ; attempt++) {
  const { workflow_runs: runs } = await api(`/actions/workflows/security.yml/runs?head_sha=${sha}&per_page=5`);
  const run = runs.find((r) => r.status === "completed") ?? runs[0];
  if (run?.status === "completed") {
    if (run.conclusion !== "success") refuse(`Security workflow: ${run.conclusion}`);
    break;
  }
  if (attempt === 30) refuse("Security workflow did not finish");
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}

const section = changelog.split(/^## /m).find((s) => s.startsWith(`${next}\n`) || s.startsWith(`${next}\r\n`)) ?? "";
const notes = section.split("\n").slice(1).join("\n").trim();
console.log(`✓ ${branch} @ ${sha.slice(0, 7)}: v${next}, ${files.length} files, ${lines} lines outside lock files, mode ${MODE}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${next}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `notes<<GHOSTLY_EOF\n${notes}\nGHOSTLY_EOF\n`);
}
