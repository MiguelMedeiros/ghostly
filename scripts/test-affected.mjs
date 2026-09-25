#!/usr/bin/env node
// Run only the checks a change can affect, with few workers, so parallel sessions do not starve each other.
// CI runs everything on every push; this is what to run locally before pushing.
//
//   npm run test:affected                        # vs origin/dev: unit, lint, typecheck, Rust; e2e only with a port
//   npm run test:affected -- --port 50310        # also build the web app, serve it on 50310, run the e2e picked
//   E2E_WEB_URL=http://localhost:50310 npm run test:affected   # e2e against a build you serve yourself
//   npm run test:affected -- --list              # print what would run, run nothing
//   npm run test:affected -- --base HEAD~3       # diff against another base
//   npm run test:affected -- --files a.ts b.tsx  # these files instead of the diff
//   npm run test:affected -- --no-e2e --no-rust  # leave those out
//
// JOBS (default 2): vitest workers, cargo test threads. E2E_WORKERS (default 2): Playwright workers.
// What is picked and why: scripts/affected/select.mjs. The e2e mapping is e2e/features.json "paths".
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { plan as makePlan } from "./affected/select.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (flag("--help") || flag("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const JOBS = Math.max(1, Number(process.env.JOBS) || 2);
const E2E_WORKERS = Math.max(1, Number(process.env.E2E_WORKERS) || 2);
const base = option("--base") ?? "origin/dev";
const list = flag("--list");
const noE2e = flag("--no-e2e");
const noRust = flag("--no-rust");
const port = option("--port") ?? process.env.E2E_WEB_PORT;
const webUrl = process.env.E2E_WEB_URL;

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
};

// ---------- what changed ----------
let mergeBase = null;
function changedFiles() {
  const i = argv.indexOf("--files");
  if (i >= 0) {
    const files = [];
    for (const a of argv.slice(i + 1)) { if (a.startsWith("--")) break; files.push(a); }
    return { from: `--files (${files.length})`, files };
  }
  mergeBase = git("merge-base", base, "HEAD").trim();
  // Committed since the base, staged, unstaged and untracked: what the push would carry once it is committed.
  const tracked = git("diff", "--name-only", "--no-renames", mergeBase).split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return { from: `${base} (merge base ${mergeBase.slice(0, 8)}) + working tree`, files: [...tracked, ...untracked] };
}
const IGNORED = [/^notes-local\//, /(^|\/)tsconfig\.tsbuildinfo$/];
const { from, files: rawFiles } = changedFiles();
const changed = [...new Set(rawFiles.map((f) => f.trim()).filter(Boolean))]
  .filter((p) => !IGNORED.some((re) => re.test(p)))
  .sort()
  .map((path) => ({ path, exists: existsSync(join(ROOT, path)), scriptsOnly: scriptsOnly(path) }));

/** A package.json whose "scripts" alone changed since the merge base (with --files there is no base: false). */
function scriptsOnly(path) {
  if (!mergeBase || !/(^|\/)package\.json$/.test(path) || !existsSync(join(ROOT, path))) return false;
  try {
    const strip = (text) => JSON.stringify({ ...JSON.parse(text), scripts: undefined });
    return strip(git("show", `${mergeBase}:${path}`)) === strip(readFileSync(join(ROOT, path), "utf8"));
  } catch {
    return false;
  }
}

/** path → text of every TypeScript/JavaScript file under these directories. */
function sources(...dirs) {
  const out = {};
  const walk = (dir) => {
    if (!existsSync(join(ROOT, dir))) return;
    for (const name of readdirSync(join(ROOT, dir))) {
      if (["node_modules", "dist", "dist-e2e", "coverage"].includes(name)) continue;
      const path = `${dir}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(name)) out[path.split(sep).join("/")] = readFileSync(join(ROOT, path), "utf8");
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}
const inventory = JSON.parse(readFileSync(join(ROOT, "e2e/features.json"), "utf8"));
const coreTouched = changed.some((c) => c.path.startsWith("packages/core/src/"));
const codeFiles = coreTouched ? sources("packages", "src", "extension/src", "extension/test", "web/src") : undefined;
const p = makePlan({ changed, inventory, e2eFiles: sources("e2e"), codeFiles });

// ---------- the plan, printed ----------
const short = (xs, n = 8) => (xs.length <= n ? xs.join(", ") : `${xs.slice(0, n).join(", ")} … (+${xs.length - n})`);
console.log(`test:affected — ${changed.length} changed file(s) from ${from}`);
for (const c of changed.slice(0, 40)) console.log(`  ${c.exists ? " " : "-"} ${c.path}`);
if (changed.length > 40) console.log(`  … and ${changed.length - 40} more`);
for (const s of p.scriptsOnly) console.log(`\nnote: only the "scripts" of ${s} changed: nothing here tests a script, so run the ones you changed yourself`);
console.log(`\nworkers: vitest ${JOBS} (JOBS), playwright ${E2E_WORKERS} (E2E_WORKERS)\n`);

console.log("unit (vitest)");
for (const u of p.unit) console.log(`  ${u.mode.padEnd(7)} ${u.name.padEnd(9)} ${u.reason}`);
console.log("lint (eslint)");
console.log(`  ${p.lint.mode.padEnd(7)} ${p.lint.reason}${p.lint.files ? `: ${short(p.lint.files)}` : ""}`);
console.log("typecheck (tsc)");
for (const t of p.typecheck) console.log(`  ${t.mode.padEnd(7)} ${t.name.padEnd(18)} ${t.reason}`);
console.log("rust (cargo)");
for (const r of p.rust) console.log(`  ${(noRust && r.mode === "run" ? "off" : r.mode).padEnd(7)} ${r.name.padEnd(9)} ${noRust && r.mode === "run" ? "--no-rust" : r.reason}`);
console.log("e2e (playwright)");
const e2eSelected = p.e2e.mode === "whole" ? p.e2e.specs : [...p.e2e.wholeSpecs ?? [], ...p.e2e.taggedSpecs ?? []];
if (p.e2e.mode === "whole") {
  console.log(`  whole   every web and extension spec (${p.e2e.specs.length}), because:`);
  for (const r of p.e2e.reasons) console.log(`            ${r}`);
} else if (p.e2e.mode === "skip") {
  console.log(`  skip    ${p.e2e.reasons.join("; ")}`);
} else {
  for (const r of p.e2e.reasons) console.log(`            ${r}`);
  if (p.e2e.wholeSpecs.length) console.log(`  whole   ${p.e2e.wholeSpecs.length} spec(s): ${short(p.e2e.wholeSpecs, 20)}`);
  if (p.e2e.taggedSpecs.length) console.log(`  tagged  ${p.e2e.features.length} feature(s) in ${p.e2e.taggedSpecs.length} spec(s): ${short(p.e2e.taggedSpecs, 20)}`);
  if (p.e2e.features.length) console.log(`            features: ${short(p.e2e.features, 30)}`);
  if (p.e2e.featuresWithoutE2e.length) console.log(`            no e2e test tagged for: ${short(p.e2e.featuresWithoutE2e, 12)}`);
}
if (p.e2e.none?.length) console.log(`            reaches no spec: ${short(p.e2e.none)}`);
if (p.e2e.desktop?.length) console.log(`  note    Desktop (e2e/desktop) is touched by ${short(p.e2e.desktop, 4)}: it runs on Linux only (npm run tauri -- build --debug --no-bundle && npm run test:e2e:desktop); CI's E2E workflow runs it`);
const e2eWanted = !noE2e && p.e2e.mode !== "skip" && e2eSelected.length > 0;
const e2eTarget = webUrl ? `E2E_WEB_URL=${webUrl}` : port ? `a fresh build served on port ${port}` : null;
if (noE2e && p.e2e.mode !== "skip") console.log("  off     --no-e2e");
else if (e2eWanted && !e2eTarget) console.log("  off     no --port <n> (or E2E_WEB_PORT / E2E_WEB_URL) given: pass one from your session's port range to run these");
else if (e2eWanted) console.log(`  target  ${e2eTarget}`);

if (list) process.exit(0);

// ---------- running ----------
const results = [];
function run(label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n▶ ${label}\n  $ ${[cmd, ...args].map((a) => (/[\s|()?*]/.test(a) ? JSON.stringify(a) : a)).join(" ")}${opts.cwd && opts.cwd !== ROOT ? `   (in ${opts.cwd.slice(ROOT.length + 1)})` : ""}`);
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, stdio: "inherit", env: { ...process.env, ...opts.env } });
    child.on("close", (code) => {
      const seconds = (Date.now() - start) / 1000;
      results.push({ label, ok: code === 0, seconds });
      resolve(code === 0);
    });
  });
}
const skipped = [];
const started = Date.now();

// unit
for (const u of p.unit) {
  if (u.mode === "skip") { skipped.push(`unit ${u.name}: ${u.reason}`); continue; }
  const cwd = join(ROOT, u.cwd);
  const common = [...u.args, `--maxWorkers=${JOBS}`, "--passWithNoTests"];
  if (u.mode === "whole") await run(`unit ${u.name} (whole: ${u.reason})`, "npx", ["vitest", "run", ...common], { cwd });
  else await run(`unit ${u.name} (related)`, "npx", ["vitest", "related", ...u.files.map((f) => join(ROOT, f)), "--run", ...common], { cwd });
}

// lint
if (p.lint.mode === "whole") await run(`lint (whole: ${p.lint.reason})`, "npm", ["run", "lint"]);
else if (p.lint.mode === "files") await run("lint (changed files)", "npx", ["eslint", "--no-warn-ignored", ...p.lint.files]);
else skipped.push(`lint: ${p.lint.reason}`);

// typecheck: one tsc at a time; each is a single process
for (const t of p.typecheck) {
  if (t.mode === "skip") { skipped.push(`typecheck ${t.name}: ${t.reason}`); continue; }
  await run(`typecheck ${t.name}`, t.cmd[0], t.cmd.slice(1));
}

// Rust
for (const r of p.rust) {
  if (r.mode === "skip") { skipped.push(`rust ${r.name}: ${r.reason}`); continue; }
  if (noRust) { skipped.push(`rust ${r.name}: --no-rust`); continue; }
  const cargoJobs = String(Math.max(2, JOBS * 2));
  if (r.name === "src-tauri") {
    mkdirSync(join(ROOT, "src-tauri/native-runtime"), { recursive: true });
    await run("rust src-tauri fmt", "cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]);
    await run("rust src-tauri clippy", "cargo", ["clippy", "-j", cargoJobs, "--manifest-path", "src-tauri/Cargo.toml", "--", "-D", "warnings"]);
    await run("rust src-tauri test", "cargo", ["test", "-j", cargoJobs, "--manifest-path", "src-tauri/Cargo.toml", "--", `--test-threads=${JOBS}`]);
    await run("rust native-transports test", "cargo", ["test", "-j", cargoJobs, "--manifest-path", "native-transports/Cargo.toml", "--", `--test-threads=${JOBS}`]);
  } else {
    await run("rust cli fmt", "cargo", ["fmt", "--manifest-path", "cli/Cargo.toml", "--", "--check"]);
    await run("rust cli clippy", "cargo", ["clippy", "-j", cargoJobs, "--manifest-path", "cli/Cargo.toml", "--", "-D", "warnings"]);
    await run("rust cli test", "cargo", ["test", "-j", cargoJobs, "--manifest-path", "cli/Cargo.toml", "--", `--test-threads=${JOBS}`]);
  }
}

// e2e
if (!e2eWanted || !e2eTarget) {
  if (p.e2e.mode === "skip") skipped.push(`e2e: ${p.e2e.reasons.join("; ")}`);
  else skipped.push(`e2e: ${noE2e ? "--no-e2e" : "no --port / E2E_WEB_URL given"} (${e2eSelected.length} spec(s) would run)`);
} else {
  await runE2e();
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function runE2e() {
  const needsExt = e2eSelected.some((s) => s.startsWith("e2e/extension/"));
  let url = webUrl;
  let preview = null;
  // The suite's build: the local OIDC issuer and the SDK example's adapters (see e2e/playwright.config.ts).
  const issuer = /OIDC_TEST_ISSUER\s*=.*?"([^"]+)"/.exec(readFileSync(join(ROOT, "e2e/support/oidcIssuer.ts"), "utf8"))?.[1];
  const suiteEnv = { VITE_OIDC_TEST_ISSUER: process.env.E2E_OIDC_ISSUER ?? issuer, GHOSTLY_PLUGINS: "examples/sdk-adapter/src/index.ts" };
  // Extension specs pair with the web app too (interop), so a build is served whatever was picked.
  if (!url) {
    // Something already answering there is another session's build: testing it would test the wrong app.
    if (await fetch(`http://localhost:${port}`).then(() => true, () => false)) {
      results.push({ label: `e2e: port ${port} is taken by another server; pick a free one in your range`, ok: false, seconds: 0 });
      return;
    }
    if (!(await run("e2e: build the web app", "npm", ["run", "build:web"], { env: suiteEnv }))) return;
    url = `http://localhost:${port}`;
    console.log(`\n▶ e2e: serve web/dist on ${url}`);
    preview = spawn("npx", ["vite", "preview", "web", "--port", String(port), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], detached: true });
    if (!(await waitFor(url, 60_000))) {
      results.push({ label: `e2e: serve on port ${port}`, ok: false, seconds: 60 });
      try { process.kill(-preview.pid); } catch { /* gone */ }
      return;
    }
  }
  const stop = () => { if (preview) { try { process.kill(-preview.pid); } catch { /* gone */ } preview = null; } };
  process.on("SIGINT", () => { stop(); process.exit(130); });
  try {
    if (needsExt && !(await run("e2e: build the extension", "npm", ["run", "build:extension"]))) return;
    const env = { E2E_WEB_URL: url, E2E_WORKERS: String(E2E_WORKERS) };
    const pw = ["playwright", "test", "-c", "e2e/playwright.config.ts", `--workers=${E2E_WORKERS}`];
    if (p.e2e.mode === "whole") {
      await run(`e2e: every web and extension spec (${p.e2e.specs.length})`, "npx", [...pw, "--project=web", "--project=extension"], { env });
    } else {
      if (p.e2e.wholeSpecs.length) await run(`e2e: ${p.e2e.wholeSpecs.length} changed or helper-reached spec(s)`, "npx", [...pw, ...p.e2e.wholeSpecs], { env });
      if (p.e2e.taggedSpecs.length) await run(`e2e: tests tagged with ${p.e2e.features.length} affected feature(s)`, "npx", [...pw, ...p.e2e.taggedSpecs, "--grep", p.e2e.grep], { env });
    }
  } finally {
    stop();
  }
}

// ---------- the summary ----------
const mins = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(1)}s`);
console.log(`\n── test:affected summary (${mins((Date.now() - started) / 1000)}) ──`);
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label}  ${mins(r.seconds)}`);
for (const s of skipped) console.log(`  · skipped ${s}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} step(s) failed. CI runs the full suite on every push.` : "\nAll affected checks passed. CI runs the full suite on every push.");
process.exit(failed.length ? 1 : 0);
