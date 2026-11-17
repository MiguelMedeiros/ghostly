#!/usr/bin/env node
/**
 * Every file the web app's service worker asks for is in the build.
 *
 * `/sw.js` carries the files it installs, those of each language and those it keeps on first use, read from the bundle
 * by `apps/web/pwa.ts`. One name the build did not write (an entry chunk Vite inlined into index.html and deleted) and
 * the install fails on nginx, which answers `/assets/` it lacks with a 404: no worker for a new visitor, and the old one
 * stays for everyone else. `vite preview` answers it with index.html, so the e2e suites never see it.
 *
 * Checked in `apps/web/dist/`, as the build left it: each `/assets/` path named in sw.js is a file there.
 *
 *   npm run build:web && npm run check:web-precache
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The build to check: apps/web/dist, or another output folder given as the argument. */
const dist = process.argv[2] ?? fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
const worker = join(dist, "sw.js");
if (!existsSync(worker)) {
  console.error(`No ${worker}. Run \`npm run build:web\` first.`);
  process.exit(1);
}

// The minifier may join a list into one string split on commas, so the paths are read wherever they stand.
const named = [...new Set(readFileSync(worker, "utf8").match(/\/assets\/[^"'`,\s]+/g) ?? [])];
const missing = named.filter((path) => !existsSync(join(dist, path)));

if (named.length === 0) {
  console.error("sw.js names no file under /assets/: the worker's lists did not reach it. See apps/web/pwa.ts.");
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`sw.js names ${missing.length} file(s) the build did not write, so its install fails where /assets/ answers 404:\n`);
  for (const path of missing) console.error(`  - ${path}`);
  console.error("\nSee apps/web/pwa.ts: the worker's lists are read from the bundle as it is written.\n");
  process.exit(1);
}

console.log(`Web precache: all ${named.length} /assets/ files sw.js names are in the build.`);
