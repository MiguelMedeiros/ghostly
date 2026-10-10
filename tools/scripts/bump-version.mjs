#!/usr/bin/env node
/**
 * One version, many places. This sets all of them:
 *
 *   node tools/scripts/bump-version.mjs 0.3.0
 *
 * - the root package.json, every workspace's (the root "workspaces" field), and package-lock.json
 * - the extension manifest and the Tauri config
 * - both crates and Cargo.lock
 * - the website's release constant (download links are built from it)
 * - the download tables in docs/INSTALLATION.md
 * - CHANGELOG.md: the files in docs/changelog/unreleased/ go into "## Unreleased" (and are deleted), which becomes
 *   "## <version>" under a new, empty "## Unreleased". A file with `release: <major.minor>` newer than the version
 *   (`release: 1.2` in a 1.1.x bump) stays for that release.
 *
 * It refuses a version that must not ship a feature flag that is on (RELEASE_GUARDS in changes.mjs): Apps
 * (APPS_ENABLED) ship from 1.2.0, so a 1.1.x bump stops while the flag is true. And the other way: a bump to 1.2.0 or
 * later stops while the flag is still false and Apps entries held for 1.2 would go out. The flag is on from the 1.2
 * cut (docs/RELEASING.md), so a 1.1.x patch is cut from `main`.
 *
 *   node tools/scripts/bump-version.mjs --check [<version>]   only the flag check, for the package.json version by
 *                                                             default (the release workflow runs it on the tag)
 *
 * A package with a version of its own (apps/website/, native/transports/hyperdht, infra/services/*, packages/sdk/examples/*) is not a workspace.
 * See docs/RELEASING.md for the rest of a release.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { CHANGES, RELEASE_GUARDS, heldFor, readFragments, releaseChangelog, repositoryVersion, splitFragments, versionBefore } from "./changes.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every workspace folder the root package.json names ("packages/*" is each folder in packages/ with a package.json). */
export function workspaces(root = ROOT) {
  const patterns = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];
  return patterns
    .flatMap((pattern) => {
      if (!pattern.endsWith("/*")) return [pattern];
      const parent = pattern.slice(0, -2);
      return readdirSync(join(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`);
    })
    .filter((folder) => existsSync(join(root, folder, "package.json")))
    .sort();
}

/** The JSON files whose "version" is the app's: the root package.json, every workspace's, the manifest, the Tauri config. */
export function versionedJson(root = ROOT) {
  return [
    "package.json",
    ...workspaces(root).map((folder) => `${folder}/package.json`),
    "apps/extension/public/manifest.json",
    "apps/desktop/tauri.conf.json",
  ];
}

export { RELEASE_GUARDS };

/** A flag's value in its file: "true", "false", or why it cannot be read (one `export const <flag> = ...;` line). */
function flagValue(root, file, flag) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    return { problem: `${file}: missing, so ${flag} cannot be checked` };
  }
  // Whole lines only, so a comment that quotes the declaration is not read as the flag.
  const values = [...text.matchAll(new RegExp(`^export const ${flag}\\b[^=\\n]*=\\s*(true|false)\\s*;`, "gm"))].map((m) => m[1]);
  if (values.length !== 1) {
    return { problem: `${file}: ${values.length ? `${values.length} lines` : "no line"} "export const ${flag} = true|false;", so it cannot be checked` };
  }
  return { value: values[0] };
}

/**
 * Why a bump to `next` must stop, one line per guard (none: it may go on). Before a guard's `from`, its flag must be
 * false. From `from` on, with `fragments` given, the entries held for its release go out, so the flag must be true.
 */
export function guardProblems(root, next, guards = RELEASE_GUARDS, fragments = []) {
  const problems = [];
  for (const guard of guards) {
    const { file, flag, from } = guard;
    if (!flag) continue;
    const early = versionBefore(next, from);
    const announced = early ? [] : fragments.filter((f) => f.release && !heldFor(f.release, next) && guard.entry?.(f));
    if (!early && !announced.length) continue;
    const { value, problem } = flagValue(root, file, flag);
    if (problem) problems.push(`${problem} for ${next}`);
    else if (early && value === "true") problems.push(`${file}: ${flag} is true, and it ships from ${from} only. Set it back to false for ${next}.`);
    else if (!early && value === "false") {
      problems.push(
        `${file}: ${flag} is false, but ${next} would announce ${announced.map((f) => f.name).join(", ")}. ` +
          `Flip it first, or move these entries to a later release.`,
      );
    }
  }
  return problems;
}

function bump(root, next) {
  const previous = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

  // Everything that can refuse the bump runs before the first file changes, so a refusal leaves no half-bumped tree:
  // the flags, the entries, and the new changelog.
  const fragments = readFragments(root);
  const guarded = guardProblems(root, next, RELEASE_GUARDS, fragments);
  if (guarded.length) {
    for (const problem of guarded) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  const broken = fragments.flatMap((f) => f.problems);
  if (broken.length) {
    console.error(`✗ ${CHANGES}/: ${broken.join("; ")}`);
    process.exit(1);
  }
  const { released, held } = splitFragments(fragments, next);
  let changelog;
  try {
    changelog = releaseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"), released, next);
  } catch (error) {
    console.error(`✗ CHANGELOG.md: ${error.message}`);
    process.exit(1);
  }

  function edit(file, replace) {
    const path = join(root, file);
    const before = readFileSync(path, "utf8");
    const after = replace(before);
    if (after === before) {
      console.error(`✗ ${file}: nothing to change. Is it already at ${next}, or did its format change?`);
      process.exit(1);
    }
    writeFileSync(path, after);
    console.log(`✓ ${file}`);
  }

  const jsonVersion = (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`);
  for (const file of versionedJson(root)) edit(file, jsonVersion);

  const crateVersion = (text) => text.replace(/^version = "[^"]+"/m, `version = "${next}"`);
  edit("apps/desktop/Cargo.toml", crateVersion);
  edit("Cargo.lock", (text) => text.replace(/(name = "ghostly"\nversion = ")[^"]+(")/g, `$1${next}$2`));

  edit("apps/website/lib/release.ts", (text) => text.replace(/(export const VERSION = ")[^"]+(")/, `$1${next}$2`));
  edit("docs/INSTALLATION.md", (text) =>
    text
      .replace(/releases\/download\/v\d+\.\d+\.\d+\//g, `releases/download/v${next}/`)
      .replace(/Ghostly_\d+\.\d+\.\d+_/g, `Ghostly_${next}_`)
      .replace(/ghostly-browser-extension-\d+\.\d+\.\d+\.zip/g, `ghostly-browser-extension-${next}.zip`),
  );
  edit("CHANGELOG.md", () => changelog);
  for (const { name } of released) rmSync(join(root, name));
  if (released.length) console.log(`✓ ${CHANGES}/: ${released.length} entries moved into CHANGELOG.md`);
  if (held.length) console.log(`✓ ${CHANGES}/: ${held.length} held for a later release (${held.map((f) => `${f.name}: ${f.release}`).join(", ")})`);

  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
  console.log(`✓ package-lock.json\n\n${previous} → ${next}. Next: docs/RELEASING.md`);
}

// Run as a script, not imported (a path through a symlink, like macOS's /var, counts too).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv[2] === "--check";
  const next = check ? (process.argv[3] ?? repositoryVersion(ROOT)) : process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
    console.error("usage: node tools/scripts/bump-version.mjs <major.minor.patch> | --check [<major.minor.patch>]");
    process.exit(1);
  }
  if (check) {
    const problems = guardProblems(ROOT, next);
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length) process.exit(1);
    console.log(`✓ ${next}: no flag on before its release (${RELEASE_GUARDS.flatMap((g) => g.flag ?? []).join(", ")})`);
  } else bump(ROOT, next);
}
