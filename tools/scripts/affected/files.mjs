// What tools/scripts/test-affected.mjs reads from the disk for the plan's import graph (select.mjs stays pure).
//
// Imports cross every folder and workspace: a browser test reaches native/transports/hyperdht/redial.mjs through
// endpoint.mjs, a UI test reaches apps/web/appsTestFlag.ts through apps/web/runnerPolicy.ts, and the Iroh tests load
// @ghostly/iroh-web by name. So the graph takes every TypeScript/JavaScript file git knows, not a list of folders a
// new chain can pass outside of, and the workspaces' package.json files for the names.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp, workspaceExports } from "./select.mjs";

const CODE = /\.[cm]?[jt]sx?$/;

/** The files git knows under `root`: tracked ones, and new ones not ignored (a file not yet added is in the change). */
export function knownFiles(root) {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files: ${r.stderr.trim()}`);
  return [...new Set(r.stdout.split("\0").filter(Boolean))];
}

/**
 * path → text of every TypeScript/JavaScript file among `paths` that is on disk (a deleted one has no imports).
 * @returns {Record<string, string>}
 */
export function codeFiles(root, paths = knownFiles(root)) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const path of paths) {
    if (!CODE.test(path)) continue;
    const full = join(root, path);
    if (existsSync(full) && statSync(full).isFile()) out[path] = readFileSync(full, "utf8");
  }
  return out;
}

/** The workspaces' exports (select.mjs workspaceExports), from the package.json files the root's "workspaces" name. */
export function workspacePackages(root, paths = knownFiles(root)) {
  const globs = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? []).map((w) => globToRegExp(`${w}/package.json`));
  /** @type {Record<string, string>} */
  const manifests = {};
  for (const path of paths) {
    if (globs.some((re) => re.test(path)) && existsSync(join(root, path))) manifests[path] = readFileSync(join(root, path), "utf8");
  }
  return workspaceExports(manifests);
}
