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
 * - CHANGELOG.md: the files in docs/changelog/unreleased/ go into "## Unreleased" (and are deleted), which becomes "## <version>"
 *
 * A package with a version of its own (apps/website/, native/transports/hyperdht, infra/services/*, packages/sdk/examples/*) is not a workspace.
 * See docs/RELEASING.md for the rest of a release.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { assembleChangelog, readFragments } from "./changes.mjs";
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

function bump(root, next) {
  const previous = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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
  const fragments = readFragments(root);
  const broken = fragments.flatMap((f) => f.problems);
  if (broken.length) {
    console.error(`✗ ${CHANGES}/: ${broken.join("; ")}`);
    process.exit(1);
  }
  edit("CHANGELOG.md", (text) => assembleChangelog(text, fragments).replace(/^## Unreleased$/m, `## ${next}`));
  for (const { name } of fragments) rmSync(join(root, name));
  if (fragments.length) console.log(`✓ ${CHANGES}/: ${fragments.length} entries moved into CHANGELOG.md`);

  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
  console.log(`✓ package-lock.json\n\n${previous} → ${next}. Next: docs/RELEASING.md`);
}

// Run as a script, not imported (a path through a symlink, like macOS's /var, counts too).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
    console.error("usage: node tools/scripts/bump-version.mjs <major.minor.patch>");
    process.exit(1);
  }
  bump(ROOT, next);
}
