#!/usr/bin/env node
/**
 * The web app's first load is one file of the app's own, not dozens.
 *
 * Left to its default split, the build cut what the app runs on load into some 95 files: each gzipped on its own
 * (about 66 KB more on the wire than one file) and asked for by a modulepreload apiece, while a deploy changed nearly
 * all of them anyway. `apps/web/vite.config.ts` keeps them in one chunk, `main` (rolldown's `$initial` group). A new
 * entry, a group renamed or an option dropped would split it again with nothing at build time to say so.
 *
 * Checked in `apps/web/dist/`, as the build left it:
 *
 *  1. index.html asks for no more than a few scripts: `main`, rolldown's runtime and the sign-in page's `popup`.
 *  2. Its entry is `main-*.js`, the name the e2e specs hold back to test a slow or failed start (boot-unsupported,
 *     language-early).
 *  3. oidc-callback.html, the page a provider returns to after an identity-proof sign-in, loads none of the app.
 *
 *   npm run build:web && npm run check:web-first-load
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Files index.html may ask for: `main`, the runtime and `popup` (shared with the sign-in page). */
const MAX_SCRIPTS = 4;

/** The build to check: apps/web/dist, or another output folder given as the argument. */
const dist = process.argv[2] ?? fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
const problems = [];

/** The JavaScript files a page names: its module scripts and modulepreloads. */
function scriptsOf(page) {
  const path = join(dist, page);
  if (!existsSync(path)) {
    problems.push(`No ${path}. Run \`npm run build:web\` first.`);
    return [];
  }
  const html = readFileSync(path, "utf8");
  return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="(\/assets\/[^"]+\.js)"/g)].map(([, src]) => src);
}

const app = scriptsOf("index.html");
if (app.length > MAX_SCRIPTS) {
  problems.push(`index.html asks for ${app.length} scripts (at most ${MAX_SCRIPTS}): the first load is split again. See codeSplitting in apps/web/vite.config.ts.`);
}
const main = app.filter((src) => /^\/assets\/main-[\w-]+\.js$/.test(src));
if (app.length > 0 && main.length !== 1) problems.push(`index.html names ${main.length} main-*.js files, not one: ${app.join(", ")}`);

const signIn = scriptsOf("oidc-callback.html");
const loaded = signIn.filter((src) => app.includes(src) && !/\/(popup|rolldown-runtime)-/.test(src));
if (loaded.length > 0) problems.push(`oidc-callback.html loads the app's own ${loaded.join(", ")}: the sign-in page should share only popup with it.`);

if (problems.length > 0) {
  console.error("The web app's first load is not one file:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(`Web first load: ${app.length} scripts (${app.join(", ")}); the sign-in page loads ${signIn.length}.`);
