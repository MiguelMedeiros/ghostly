#!/usr/bin/env node
/**
 * Fetches the Linux Desktop app of an older release, for the Desktop compatibility e2e (e2e/desktop/compat-v115.spec.ts):
 * the current Desktop must still talk to a contact who has not updated. Unlike the web app (build-compat-web.mjs), a
 * release attaches its Desktop build, so the old app is the one people installed: the release's `.deb`, checked against
 * the release's SHA256SUMS.txt and unpacked with `dpkg-deb -x`, or with `tar` where there is no `dpkg-deb` (Arch):
 * unpack-deb.mjs. Nothing is built, and no Rust is needed.
 *
 * The unpacked tree keeps the package's layout (usr/bin/ghostly beside usr/lib/Ghostly/native-runtime): Tauri finds its
 * resources at ../lib/<product> from a binary in a `usr/bin` directory, as it does once installed.
 *
 * Fetched once per tag: the result is kept in a cache outside the repository (shared by every worktree) and a second
 * run only prints where it is. `--force` fetches again.
 *
 *   node tools/scripts/fetch-compat-desktop.mjs                  # v1.1.5 → ~/.cache/ghostly/compat/desktop-v1.1.5/usr/bin/ghostly
 *   node tools/scripts/fetch-compat-desktop.mjs --tag v1.1.5 --force
 *
 *   node tools/scripts/fetch-compat-desktop.mjs --deb Ghostly_1.1.5_amd64.deb   # a package already here: no download, no checksum
 *
 * Linux x64 only (the release's amd64 package). E2E_COMPAT_CACHE moves the cache. Prints the binary.
 * Ends with status 3 and the reason when no tool on this machine unpacks the package: the spec skips on it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NoUnpacker, unpackDeb } from "./unpack-deb.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const tag = option("--tag", "v1.1.5");
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Not a release tag: ${tag}`);
const version = tag.slice(1);
const cache = resolve(process.env.E2E_COMPAT_CACHE ?? join(homedir(), ".cache", "ghostly", "compat"));
const root = join(cache, `desktop-${tag}`);
const binary = join(root, "usr", "bin", "ghostly");
const done = join(root, ".fetched");
const local = option("--deb");

if (local || args.includes("--force") || !existsSync(done) || !existsSync(binary)) {
  try {
    await fetchRelease();
  } catch (error) {
    if (!(error instanceof NoUnpacker)) throw error;
    console.error(error.message);
    process.exit(3);
  }
}
console.log(binary);

async function download(name) {
  const url = `https://github.com/MiguelMedeiros/ghostly/releases/download/${tag}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The release's package, as its SHA256SUMS.txt says it is. */
async function checked(name) {
  console.error(`Fetching ${name} from the ${tag} release`);
  const [deb, sums] = await Promise.all([download(name), download("SHA256SUMS.txt")]);
  const expected = sums.toString().split("\n").map((line) => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`${tag}'s SHA256SUMS.txt lists no ${name}`);
  const actual = createHash("sha256").update(deb).digest("hex");
  if (actual !== expected) throw new Error(`${name}: sha256 ${actual}, the release says ${expected}`);
  return deb;
}

async function fetchRelease() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error(`The release's Desktop package is for Linux x64, not ${process.platform} ${process.arch}`);
  const name = `Ghostly_${version}_amd64.deb`;
  const deb = local ? readFileSync(local) : await checked(name);
  const actual = createHash("sha256").update(deb).digest("hex");

  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const file = join(cache, `.${name}`);
  writeFileSync(file, deb);
  try {
    unpackDeb(file, root);
  } finally {
    rmSync(file, { force: true });
  }
  if (!existsSync(binary)) throw new Error(`${name} has no usr/bin/ghostly`);
  writeFileSync(done, `${tag} ${actual}\n`);
}
