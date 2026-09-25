#!/usr/bin/env node
/**
 * Builds the web app of an older release, for the compatibility e2e (e2e/compat/, WISP 402): 0.5 must still
 * talk to a contact on v0.4.0. The release attaches no web build, so the tag's source is exported with
 * `git archive` (no worktree, nothing checked out here) and built with its own lockfile.
 *
 * Built once per tag: the result is kept in a cache outside the repository (shared by every worktree) and a
 * second run only prints where it is. `--force` rebuilds. About a minute from nothing (npm ci and a Vite build).
 *
 *   node scripts/build-compat-web.mjs              # v0.4.0 → ~/.cache/ghostly/compat/v0.4.0/web/dist
 *   node scripts/build-compat-web.mjs --tag v0.4.0 --force
 *   node scripts/build-compat-web.mjs --serve 4184   # builds if needed, then serves it on 127.0.0.1:4184
 *
 * E2E_COMPAT_CACHE moves the cache. Prints the dist directory.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const tag = option("--tag", "v0.4.0");
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Not a release tag: ${tag}`);
const serve = option("--serve", null);
const cache = resolve(process.env.E2E_COMPAT_CACHE ?? join(homedir(), ".cache", "ghostly", "compat"));
const root = join(cache, tag);
const dist = join(root, "web", "dist");
const done = join(root, ".built");

if (args.includes("--force") || !existsSync(done) || !existsSync(join(dist, "index.html"))) build();
console.log(dist);
if (serve) serveDist(Number(serve));

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CI: "1" } });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed in ${cwd} (${result.status})`);
}

function build() {
  // The tag must be here; a shallow clone (CI) fetches just it.
  try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], { stdio: "ignore" }); }
  catch { run("git", ["fetch", "--depth=1", "origin", `refs/tags/${tag}:refs/tags/${tag}`], process.cwd()); }

  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  console.error(`Exporting ${tag} into ${root}`);
  const archive = execFileSync("git", ["archive", "--format=tar", tag], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", root], { input: archive });

  // Its own lockfile, its own postinstall (patch-package); no Rust and no browsers are needed for the web app.
  console.error(`Installing ${tag}'s dependencies`);
  run("npm", ["ci", "--no-audit", "--no-fund"], root);
  console.error(`Building ${tag}'s web app`);
  run("npm", ["run", "build:web"], root);
  if (!existsSync(join(dist, "index.html"))) throw new Error(`${tag}'s build left no ${dist}/index.html`);

  // The sources and node_modules are only needed to build: keep the cache small.
  for (const entry of ["node_modules", "web/node_modules", "packages", "extension", "src", "src-tauri", "e2e", "website", "docs"])
    rmSync(join(root, entry), { recursive: true, force: true });
  writeFileSync(done, `${tag}\n`);
}

/**
 * The built app over plain HTTP on loopback (a secure context, like the current app's preview server), with the
 * SPA's index for any other path. Dependency-free: the export keeps no node_modules.
 */
function serveDist(port) {
  const types = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
    ".png": "image/png", ".ico": "image/x-icon", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
  };
  createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://compat").pathname)).replace(/^[/\\]+/, "");
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(readFileSync(file));
  }).listen(port, "127.0.0.1", () => console.error(`${tag} on http://localhost:${port}`));
}
