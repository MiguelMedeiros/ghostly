#!/usr/bin/env node
/**
 * The desktop updater reads one file: `latest.json`, published with every
 * release. It names the newest version and, per platform, the bundle to take
 * and the signature it must carry — the app installs nothing that does not
 * verify against the public key built into it.
 *
 * The bundles are found by their signatures rather than by name: whatever
 * Tauri called the artifact, there is a `.sig` next to it, and only what the
 * updater can replace in place is published (no `.deb`, no `.rpm`, no `.dmg`).
 *
 *   node scripts/updater-manifest.mjs <artifacts-dir> <out-dir> <tag> [notes-file]
 *
 * Copies the bundles into <out-dir> and prints the manifest there too.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const REPOSITORY = "MiguelMedeiros/ghostly";

/** The artifact directory each build uploads, and what the updater calls that platform. */
const PLATFORMS = {
  "tauri-macOS-arm64": "darwin-aarch64",
  "tauri-macOS-x64": "darwin-x86_64",
  "tauri-Linux-x64": "linux-x86_64",
  "tauri-Windows-x64": "windows-x86_64",
};

/** What the updater can replace in place, best first. A `.deb` is its package manager's. */
const UPDATABLE = [".app.tar.gz", ".AppImage.tar.gz", ".AppImage", ".nsis.zip", "-setup.exe", ".msi.zip", ".msi"];

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/** The signed bundle for one platform: the `.sig` says which file it is. */
function bundleFor(dir) {
  const signed = walk(dir)
    .filter((path) => path.endsWith(".sig"))
    .map((signature) => ({ signature, bundle: signature.slice(0, -".sig".length) }))
    .map((pair) => ({ ...pair, rank: UPDATABLE.findIndex((suffix) => pair.bundle.endsWith(suffix)) }))
    .filter((pair) => pair.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((pair) => ({ ...pair, suffix: UPDATABLE[pair.rank] }));
  return signed[0] ?? null;
}

const [artifactsDir, outDir, tag, notesFile] = process.argv.slice(2);
if (!artifactsDir || !outDir || !tag) {
  console.error("usage: updater-manifest.mjs <artifacts-dir> <out-dir> <tag> [notes-file]");
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const version = tag.replace(/^v/, "");
const platforms = {};
const missing = [];

for (const [artifact, platform] of Object.entries(PLATFORMS)) {
  const dir = join(artifactsDir, artifact);
  let found = null;
  try {
    found = bundleFor(dir);
  } catch {
    // The build for this platform uploaded nothing.
  }
  if (!found) {
    missing.push(platform);
    continue;
  }

  // The AppImage is already published as its own download; the rest are named
  // after the platform they are for, because two architectures of the same app
  // are otherwise called exactly the same thing.
  const published = basename(found.bundle);
  const name = existsSync(join(outDir, published)) ? published : `Ghostly_${version}_${platform}${found.suffix}`;
  if (name !== published) copyFileSync(found.bundle, join(outDir, name));
  platforms[platform] = {
    signature: readFileSync(found.signature, "utf8").trim(),
    url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`,
  };
  console.error(`${platform}: ${name}`);
}

if (missing.length) {
  console.error(`No signed bundle for: ${missing.join(", ")}. Is TAURI_SIGNING_PRIVATE_KEY set?`);
  process.exit(1);
}

const manifest = {
  version,
  notes: notesFile ? readFileSync(notesFile, "utf8").trim() : `Ghostly ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(outDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.error(`latest.json: ${Object.keys(platforms).length} platforms`);
