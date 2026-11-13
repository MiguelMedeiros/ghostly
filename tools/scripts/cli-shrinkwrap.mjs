import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI's npm-shrinkwrap.json, cut from the repository's package-lock.json: the packages the CLI's production
 * dependencies reach in that lockfile, at the versions, tarballs and integrity hashes the release was built and tested
 * with, laid out under the CLI. npm installs a published package's shrinkwrap as written (a global install too), so
 * `npm install -g @ghostlytools/cli@X` gets X's tree instead of whatever the registry's ranges resolve to that day,
 * and the root's `overrides` (which npm never applies to a published package) come along as the versions they chose.
 *
 * `npm shrinkwrap` does not work inside a workspace (it writes the root's lockfile), and re-resolving in a scratch
 * folder would pick new versions; so this walks the lockfile itself with Node's own lookup (a package's
 * `node_modules`, then each folder above it), keeps each package where the root's tree has it when it can, nests it
 * where the CLI's own copy of a name takes the top, and checks that the moved tree resolves every dependency to the
 * very package the lockfile resolves it to. What it cannot ship (a workspace link, a local or git package, a package
 * with no place left) stops it with the reason: the publish fails rather than ship a tree nobody tested. It needs no
 * dependency (npm's Arborist is not one of the repository's).
 *
 * The publish workflow (.github/workflows/npm-publish.yml, build-cli) runs `node tools/scripts/cli-shrinkwrap.mjs`
 * after `npm ci` and before `npm pack`; the file is in the CLI's `files` and ignored by git.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const WORKSPACE = "packages/cli";
/** What the lockfile says about how a package was reached in the root's tree: recomputed for the CLI's own tree. */
const TREE_FLAGS = ["dev", "devOptional", "optional", "peer", "extraneous"];

/** The folders Node looks in for `name`, from the package at `from` (a lockfile path, "" for the root), nearest first. */
function lookups(from, name) {
  const out = [];
  const parts = from ? from.split("/") : [];
  for (let n = parts.length; n >= 0; n--) {
    if (n > 0 && parts[n - 1] === "node_modules") continue;
    // A scope's own folder (node_modules/@scope): Node looks there too, but npm never puts a package in it.
    if (n > 1 && parts[n - 2] === "node_modules" && parts[n - 1].startsWith("@")) continue;
    const dir = parts.slice(0, n).join("/");
    out.push(dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`);
  }
  return out;
}

const resolveIn = (paths, from, name) => lookups(from, name).find((path) => paths.has(path)) ?? null;

/** Each dependency of a lockfile entry, and whether its absence is allowed (optional, or an optional peer). */
function edges(entry) {
  const out = [];
  for (const name of Object.keys(entry.dependencies ?? {})) out.push({ name, optional: false });
  for (const name of Object.keys(entry.optionalDependencies ?? {})) out.push({ name, optional: true });
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (entry.dependencies?.[name] || entry.optionalDependencies?.[name]) continue;
    out.push({ name, optional: Boolean(entry.peerDependenciesMeta?.[name]?.optional) });
  }
  return out;
}

/**
 * The folder for `name` (the lockfile's package `want`) needed by the package at `at` in `tree` (new path -> lockfile
 * path; `paths` are the lockfile's): the lockfile's own folder, or as high up as Node's lookup from `at` reaches, below
 * any other package of that name, and never where it would change what a package already placed resolves `name` to.
 */
function slotFor(tree, all, paths, at, name, want) {
  let best = null;
  for (const slot of lookups(at, name)) {
    if (tree.has(slot)) break;
    const shadows = [...tree].some(([q, lockPath]) => {
      if (!edges(all[lockPath]).some((edge) => edge.name === name)) return false;
      const now = resolveIn(tree, q, name);
      if (!now || tree.get(now) !== resolveIn(paths, lockPath, name)) return false;
      const order = lookups(q, name);
      const index = order.indexOf(slot);
      return index >= 0 && index < order.indexOf(now);
    });
    if (shadows) break;
    best = slot;
    // Where the root's tree has it, when that works here too.
    if (slot === want) break;
  }
  if (!best) throw new Error(`no place under the CLI for ${want} (${name}, needed by ${tree.get(at) || "the CLI"})`);
  return best;
}

/**
 * The shrinkwrap for `workspace` (default packages/cli) from a parsed lockfile (version 2 or 3). Throws when the tree
 * cannot be moved as is.
 */
export function cliShrinkwrap(lock, workspace = WORKSPACE) {
  const all = lock.packages;
  if (!all || lock.lockfileVersion < 2) throw new Error("package-lock.json: lockfileVersion 2 or later expected");
  const self = all[workspace];
  if (!self) throw new Error(`package-lock.json has no ${workspace}`);
  const paths = new Set(Object.keys(all));

  // The packages reached without an optional step on the way (each must resolve), then every package reached.
  const walk = (withOptional) => {
    const seen = new Set();
    const queue = [workspace];
    while (queue.length) {
      const from = queue.shift();
      for (const edge of edges(all[from])) {
        if (edge.optional && !withOptional) continue;
        const to = resolveIn(paths, from, edge.name);
        if (!to) {
          if (edge.optional || withOptional) continue;
          throw new Error(`${from} needs ${edge.name}, which package-lock.json does not resolve`);
        }
        if (all[to].link) throw new Error(`${to} is a workspace link (${all[to].resolved}): the CLI bundles workspace packages, it cannot depend on one`);
        if (seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    return seen;
  };
  const required = walk(false);
  const reached = walk(true);

  for (const from of reached) {
    const entry = all[from];
    if (entry.inBundle) throw new Error(`${from}: bundled inside another package, which this script does not move`);
    if (!/^https:\/\//.test(entry.resolved ?? "")) throw new Error(`${from}: resolved from ${entry.resolved ?? "nowhere"}, not a registry tarball`);
    if (!entry.integrity) throw new Error(`${from}: no integrity hash in package-lock.json`);
  }

  // Lay them out under the CLI, then place what is still missing the way npm hoists: each as high up as it can go,
  // shallow ones first. A package the root hoists at another version than the CLI's own copy of it ends up nested
  // under the packages that use it.
  const tree = new Map([["", workspace]]);
  // First where the root's tree has them: the CLI's own copies, then the root's hoisted ones that nothing shadows.
  for (const from of reached) if (from.startsWith(`${workspace}/node_modules/`) && !from.includes("/node_modules/", workspace.length + 14)) tree.set(from.slice(workspace.length + 1), from);
  for (const from of reached) if (!from.includes("/node_modules/") && !tree.has(from)) tree.set(from, from);
  const queue = [...tree.keys()];
  while (queue.length) {
    const at = queue.shift();
    const from = tree.get(at);
    for (const edge of edges(all[from])) {
      const want = resolveIn(paths, from, edge.name);
      if (!want) continue;
      const got = resolveIn(tree, at, edge.name);
      if (got && tree.get(got) === want) continue;
      const slot = slotFor(tree, all, paths, at, edge.name, want);
      tree.set(slot, want);
      queue.push(slot);
    }
  }

  // The moved tree must resolve every edge to the package the lockfile resolved it to.
  for (const [at, from] of tree) {
    for (const edge of edges(all[from])) {
      const want = resolveIn(paths, from, edge.name);
      if (!want) continue;
      const got = resolveIn(tree, at, edge.name);
      if (!got || tree.get(got) !== want) throw new Error(`${from} -> ${edge.name}: ${want} in package-lock.json, ${got ? tree.get(got) : "nothing"} under the CLI`);
    }
  }

  const packages = {};
  for (const [at, from] of tree) {
    if (!at) continue;
    packages[at] = Object.fromEntries(Object.entries(all[from]).filter(([key]) => !TREE_FLAGS.includes(key)));
    if (!required.has(from)) packages[at].optional = true;
  }

  const root = Object.fromEntries(
    ["name", "version", "license", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin", "engines"]
      .filter((key) => self[key] !== undefined)
      .map((key) => [key, self[key]]),
  );
  const ordered = Object.keys(packages).sort((a, b) => a.localeCompare(b, "en"));
  return {
    name: self.name,
    version: self.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": root, ...Object.fromEntries(ordered.map((key) => [key, packages[key]])) },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, WORKSPACE, "package.json"), "utf8"));
  const shrinkwrap = cliShrinkwrap(lock);
  if (shrinkwrap.version !== manifest.version) throw new Error(`package-lock.json has ${WORKSPACE} at ${shrinkwrap.version}, its package.json says ${manifest.version}`);
  const out = join(ROOT, WORKSPACE, "npm-shrinkwrap.json");
  writeFileSync(out, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  console.log(`${out}: ${Object.keys(shrinkwrap.packages).length - 1} packages`);
}
