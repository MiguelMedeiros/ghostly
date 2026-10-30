#!/usr/bin/env node
/**
 * The translation runtime the Desktop app pins (RUNTIMES in apps/desktop/src/translate_models.rs, for RUNTIME_VERSION
 * in apps/desktop/src/translate.rs) against what the `Translation runtime` workflow published on
 * `translation-runtime-v<RUNTIME_VERSION>` (docs/RELEASING.md). A computer with no pin, or a pin that is not the
 * published archive, can never download the runtime, so translation never starts there. The release workflow runs it
 * before any Desktop build of a tag that carries translation (TRANSLATE_FROM in release.yml):
 *
 *   node tools/scripts/translation-runtimes.mjs --version          the RUNTIME_VERSION the app pins
 *   node tools/scripts/translation-runtimes.mjs --check <folder>   <folder> holds that release's runtimes.txt and
 *                                                                 its .sha256 files; without one, only that every
 *                                                                 Desktop platform has a pin
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The platforms release.yml's build-tauri builds the Desktop app for, as the runtime's archives name them. */
export const DESKTOP_PLATFORMS = ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"];

/** The archive's file name on the runtime's release, as RUNTIME_URL in translate_models.rs builds it. */
export const archiveName = (version, platform) => `ghostly-translation-runtime-${version}-${platform}.tar.gz`;

/** RUNTIME_VERSION in translate.rs. */
export function runtimeVersion(source) {
  const version = /pub const RUNTIME_VERSION: &str = "([^"]+)";/.exec(source)?.[1];
  if (!version) throw new Error("translate.rs has no RUNTIME_VERSION");
  return version;
}

/** RUNTIMES in translate_models.rs: `(platform, size, sha256)` entries, by platform. */
export function pinnedRuntimes(source) {
  const table = /const RUNTIMES: &\[\(&str, u64, &str\)\] = &\[([\s\S]*?)\];/.exec(source)?.[1];
  if (table === undefined) throw new Error("translate_models.rs has no RUNTIMES table");
  const pinned = new Map();
  for (const [, platform, size, sha256] of table.matchAll(/\(\s*"([^"]+)",\s*([\d_]+),\s*"([^"]*)",?\s*\)/g)) {
    pinned.set(platform, { size: Number(size.replaceAll("_", "")), sha256 });
  }
  return pinned;
}

/** runtimes.txt as the `Translation runtime` workflow writes it: one `<platform> <size> <sha256>` line per archive. */
export function publishedRuntimes(text) {
  const published = new Map();
  for (const line of text.split("\n")) {
    const [platform, size, sha256] = line.trim().split(/\s+/);
    if (platform) published.set(platform, { size: Number(size), sha256 });
  }
  return published;
}

/**
 * What stops a computer the Desktop app is built for from downloading the runtime, one line each; none when nothing
 * does. Without `published` (the release's runtimes.txt) and `sha256` (its .sha256 files: archive name -> SHA-256),
 * only that each platform has a pin.
 * @param {{ version: string, pinned: Map<string, { size: number, sha256: string }>, published?: Map<string, { size: number, sha256: string }>, sha256?: Map<string, string> }} runtimes
 */
export function runtimeProblems({ version, pinned, published, sha256 }) {
  const problems = [];
  for (const platform of DESKTOP_PLATFORMS) {
    if (!pinned.has(platform)) problems.push(`RUNTIMES has no entry for ${platform}: copy runtimes.txt of translation-runtime-v${version} into it`);
  }
  if (!published) return problems;
  for (const [platform, pin] of pinned) {
    const archive = archiveName(version, platform);
    const listed = published.get(platform);
    if (!listed) problems.push(`translation-runtime-v${version} published no archive for ${platform}, which RUNTIMES pins`);
    else if (listed.size !== pin.size || listed.sha256 !== pin.sha256) {
      problems.push(`RUNTIMES pins ${platform} as ${pin.size} bytes, sha256 ${pin.sha256}; translation-runtime-v${version}'s runtimes.txt has ${listed.size} bytes, sha256 ${listed.sha256}`);
    }
    const written = sha256?.get(archive);
    if (written === undefined) problems.push(`translation-runtime-v${version} has no ${archive}.sha256`);
    else if (written !== pin.sha256) problems.push(`RUNTIMES pins ${platform} as sha256 ${pin.sha256}; ${archive}.sha256 has ${written}`);
  }
  return problems;
}

/** The .sha256 files of a folder (`<sha256>  <archive>`, as sha256sum writes them): archive name -> SHA-256. */
function readSha256Files(folder) {
  const sha256 = new Map();
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".sha256"))) {
    const [hash, archive] = readFileSync(join(folder, file), "utf8").trim().split(/\s+/);
    sha256.set(archive ?? file.slice(0, -".sha256".length), hash);
  }
  return sha256;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [flag, folder] = process.argv.slice(2);
  const version = runtimeVersion(readFileSync(join(ROOT, "apps/desktop/src/translate.rs"), "utf8"));
  if (flag === "--version") {
    console.log(version);
  } else if (flag === "--check") {
    const pinned = pinnedRuntimes(readFileSync(join(ROOT, "apps/desktop/src/translate_models.rs"), "utf8"));
    const release = folder && {
      published: publishedRuntimes(existsSync(join(folder, "runtimes.txt")) ? readFileSync(join(folder, "runtimes.txt"), "utf8") : ""),
      sha256: readSha256Files(folder),
    };
    const problems = runtimeProblems({ version, pinned, ...release });
    for (const problem of problems) console.error(`::error::${problem}`);
    if (problems.length) process.exit(1);
    console.log(`The Desktop app pins translation runtime ${version} for ${[...pinned.keys()].join(", ")}${folder ? ", as published" : ""}`);
  } else {
    console.error("usage: translation-runtimes.mjs --version | --check [<folder>]");
    process.exit(2);
  }
}
