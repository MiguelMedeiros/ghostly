#!/usr/bin/env node
/**
 * One version, many places. This sets all of them:
 *
 *   node scripts/bump-version.mjs 0.3.0
 *
 * - every package.json in the workspace, and package-lock.json
 * - the extension manifest and the Tauri config
 * - both crates and Cargo.lock
 * - the website's release constant (download links are built from it)
 * - the download tables in docs/INSTALLATION.md
 * - CHANGELOG.md: "## Unreleased" becomes "## <version>"
 *
 * See docs/RELEASING.md for the rest of a release.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
  console.error("usage: node scripts/bump-version.mjs <major.minor.patch>");
  process.exit(1);
}
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
for (const file of [
  "package.json",
  "web/package.json",
  "extension/package.json",
  "extension/public/manifest.json",
  "packages/core/package.json",
  "packages/browser/package.json",
  "packages/react/package.json",
  "src-tauri/tauri.conf.json",
]) {
  edit(file, jsonVersion);
}

const crateVersion = (text) => text.replace(/^version = "[^"]+"/m, `version = "${next}"`);
edit("src-tauri/Cargo.toml", crateVersion);
edit("cli/Cargo.toml", crateVersion);
edit("Cargo.lock", (text) => text.replace(/(name = "ghostly(?:-cli)?"\nversion = ")[^"]+(")/g, `$1${next}$2`));

edit("website/lib/release.ts", (text) => text.replace(/(export const VERSION = ")[^"]+(")/, `$1${next}$2`));
edit("docs/INSTALLATION.md", (text) =>
  text
    .replace(/releases\/download\/v\d+\.\d+\.\d+\//g, `releases/download/v${next}/`)
    .replace(/Ghostly_\d+\.\d+\.\d+_/g, `Ghostly_${next}_`)
    .replace(/ghostly-browser-extension-\d+\.\d+\.\d+\.zip/g, `ghostly-browser-extension-${next}.zip`),
);
edit("CHANGELOG.md", (text) => text.replace(/^## Unreleased$/m, `## ${next}`));

execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
console.log(`✓ package-lock.json\n\n${previous} → ${next}. Next: docs/RELEASING.md`);
