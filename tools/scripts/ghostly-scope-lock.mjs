import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every `@ghostly/*` package in package-lock.json is one of the repository's workspaces, linked (`"link": true`), and
 * no entry is a tarball of the `@ghostly` scope from a registry. The workspaces are named `@ghostly/*` and depend on
 * each other with `"*"`, but the npm scope `@ghostly` belongs to another account: an install that misses a workspace
 * (a folder moved out of `workspaces`, a lock regenerated somewhere else) takes whatever that account publishes, at
 * any version, and the lock records it as an ordinary package. This fails the build on such a lock, one line per entry.
 *
 * The scripts' tests run it on the repository's own lock (tools/scripts/test/ghostlyScopeLock.test.ts): `npm run
 * test:scripts` in CI's frontend tests, and a draft's affected tests, which run everything when the lock changes
 * (affected/select.mjs, EVERYTHING). It needs no dependency.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/** The package an entry's path installs (`a/node_modules/@ghostly/core` -> `@ghostly/core`), or null for a folder. */
const nameAt = (path) => {
  const at = path.lastIndexOf("node_modules/");
  return at < 0 ? null : path.slice(at + "node_modules/".length);
};

/** A `resolved` that names the scope as a registry path (`/@ghostly/`, or `%40ghostly%2f` escaped): not `@ghostlytools`. */
const SCOPE_URL = /(?:@|%40)ghostly(?:\/|%2f)/i;

/** One line per lockfile entry that brings an `@ghostly/*` package from anywhere but a workspace. Empty when none. */
export function ghostlyScopeProblems(lock) {
  const all = lock?.packages;
  if (!all) return ["package-lock.json has no \"packages\" (lockfileVersion 2 or later expected)"];
  const out = [];
  for (const [path, entry] of Object.entries(all)) {
    const name = nameAt(path);
    if (name?.startsWith("@ghostly/")) {
      if (entry.link !== true) {
        out.push(`package-lock.json: ${path} is not a workspace link (resolved from ${entry.resolved ?? "nowhere"}): the npm scope @ghostly is not ours`);
        continue;
      }
      if (!all[entry.resolved]) {
        out.push(`package-lock.json: ${path} links to ${entry.resolved ?? "nothing"}, which is no package in the lock`);
        continue;
      }
    }
    if (entry.link !== true && SCOPE_URL.test(entry.resolved ?? "")) {
      out.push(`package-lock.json: ${path} is resolved from ${entry.resolved}: the npm scope @ghostly is not ours`);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = ghostlyScopeProblems(JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")));
  for (const line of problems) console.error(line);
  if (problems.length) process.exit(1);
  console.log("package-lock.json: every @ghostly/* package is a workspace link");
}
