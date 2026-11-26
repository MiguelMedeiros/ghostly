#!/usr/bin/env node
// `npm run typecheck`: every tsc program of TYPECHECKS (tools/scripts/affected/select.mjs, the list test:affected
// types a change against), up to --jobs at a time, the longest first. Each one's output is printed whole as it ends;
// the exit code is 1 when any failed.
//
// Each tsc is one thread. One after another they took 144 s of CI's lint job on a 4-core runner, eslint on one core
// beside them and two cores idle; three at a time the longest (the root tsconfig, ~2.3 GB at its peak) sets the
// length. The default is the cores but one, at most 3; --jobs 1 runs them in a row.
//
//   node tools/scripts/typecheck.mjs [--jobs <n>]
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TYPECHECKS } from "./affected/select.mjs";

const root = resolve(import.meta.dirname, "../..");

/**
 * Runs `checks` ({ name, cmd, seconds }), at most `jobs` at once, by `seconds` longest first, and resolves each
 * one's result in the order given. `log` gets each one's header and output once it ended.
 */
export function runChecks(checks, { jobs, cwd = root, log = console.log }) {
  const queue = [...checks].sort((a, b) => b.seconds - a.seconds);
  const results = new Map();
  const one = (check) => new Promise((done) => {
    const started = Date.now();
    let output = "";
    log(`▶ ${check.name} started`);
    const child = spawn(check.cmd[0], check.cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const end = (code, error) => {
      const seconds = (Date.now() - started) / 1000;
      const ok = code === 0;
      log(`${check.name}: ${ok ? "passed" : "failed"} in ${seconds.toFixed(1)} s ($ ${check.cmd.join(" ")})${output ? `\n${output.trimEnd()}` : ""}${error ? `\n${error.message}` : ""}`);
      results.set(check, { name: check.name, ok, seconds });
      done();
    };
    child.on("error", (error) => end(1, error));
    child.on("close", (code) => end(code));
  });
  const lane = async () => { for (let check = queue.shift(); check; check = queue.shift()) await one(check); };
  return Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, checks.length)) }, lane)).then(() => checks.map((c) => results.get(c)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const at = process.argv.indexOf("--jobs");
  const jobs = at < 0 ? Math.max(1, Math.min(3, availableParallelism() - 1)) : Number(process.argv[at + 1]);
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error("usage: node tools/scripts/typecheck.mjs [--jobs <n>], n a whole number of at least 1");
    process.exit(2);
  }
  const started = Date.now();
  const results = await runChecks(TYPECHECKS, { jobs });
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(`\ntypecheck: ${results.length - failed.length} of ${results.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s, ${jobs} at a time${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
