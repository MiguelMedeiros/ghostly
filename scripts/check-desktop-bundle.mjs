#!/usr/bin/env node
/**
 * The Desktop build really does carry its Desktop wiring.
 *
 * `vite.config.ts` applies `ghostlyPlatformModules()` to the Desktop build too,
 * so every module the plugin lists is replaced by a browser stand-in in the app
 * that ships — silently, with nothing at build time to say so. That is how the
 * Desktop updater once shipped dead: a Desktop-only module in `src/lib/` was on
 * the list, Desktop got the stand-in, and only a grep through `dist/` found it.
 *
 * Two things are checked, both read from the source rather than kept by hand:
 *
 *  1. What Desktop's own modules ask of Rust is still in `dist/`. `src/main.tsx`
 *     and `src/desktop/` are never swapped, so anything they invoke has to be
 *     in the built app.
 *  2. Every module on the swap list is one someone decided Desktop can live
 *     without. Adding a module to `PLATFORM_MODULES` fails here until its
 *     reason is written down below — which is the moment to notice that
 *     Desktop needed the real one.
 *
 *   npm run build && npm run check:desktop-bundle
 *
 * This is a build assertion, not a test: `e2e/desktop/` drives the real app.
 * It is here because it costs nothing and runs everywhere, macOS included,
 * where that test cannot.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Why Desktop is content with the browser stand-in for each swapped module.
 * A module that Desktop actually needs does not belong here: it belongs with
 * its host in `src/desktop/`, reached through `BrowserHost`.
 */
const SWAPPED_ON_PURPOSE = {
  "lib/pkarr.ts": "Desktop runs the shared peer, which reaches Pkarr through src/desktop/host.ts instead.",
  "lib/crypto.ts": "Desktop runs the shared peer: the same WebCrypto as the browsers, not the Rust commands.",
  "lib/platform.ts": "The services platform is the browser one on Desktop too, backed by the Desktop host.",
  "lib/updates.ts": "Declarations only; Desktop's updater is src/desktop/updates.ts, reached through BrowserHost.",
  "hooks/useChat.ts": "Chat belongs to the shared peer on every client, Desktop included.",
  "hooks/useBackgroundPoller.ts": "The shared peer polls for itself; Desktop has nothing to add.",
};

const root = fileURLToPath(new URL("..", import.meta.url));
const problems = [];

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

// 1. Every module the plugin swaps is one someone signed off on.
const plugin = readFileSync(join(root, "packages/browser/vite-plugin.ts"), "utf8");
const swapped = [...plugin.slice(plugin.indexOf("PLATFORM_MODULES")).matchAll(/\bdesktop\("([^"]+)"\)/g)].map(([, path]) => path);
if (swapped.length === 0) {
  problems.push("Could not read PLATFORM_MODULES from packages/browser/vite-plugin.ts — has it moved?");
}
for (const path of swapped) {
  if (path in SWAPPED_ON_PURPOSE) continue;
  problems.push(
    `src/${path} is swapped for a browser stand-in, on Desktop as well.\n` +
      `      The Desktop app will run the stand-in, not this module. If that is fine, say why in\n` +
      `      SWAPPED_ON_PURPOSE in ${relative(root, fileURLToPath(import.meta.url))}. If it is not,\n` +
      "      the module belongs with its host in src/desktop/, reached through BrowserHost.",
  );
}
for (const path of Object.keys(SWAPPED_ON_PURPOSE)) {
  if (!swapped.includes(path)) problems.push(`src/${path} is no longer swapped — drop it from SWAPPED_ON_PURPOSE.`);
}

// 2. What Desktop's own modules ask of Rust survived into the built app.
const own = [join(root, "src/main.tsx"), ...walk(join(root, "src/desktop"))].filter((path) => /\.tsx?$/.test(path));
const wanted = new Map();
for (const path of own) {
  const source = readFileSync(path, "utf8");
  const found = [
    ...source.matchAll(/\binvoke\s*(?:<[\s\S]*?>)?\s*\(\s*"([^"]+)"/g),
    ...source.matchAll(/\bprotocol:\s*"([^"]+)"/g),
  ];
  for (const [, needle] of found) wanted.set(needle, relative(root, path));
}
if (wanted.size === 0) problems.push("Found nothing Desktop asks of Rust — has this check gone stale?");

const dist = join(root, "dist");
const bundle = existsSync(dist)
  ? walk(dist)
      .filter((path) => path.endsWith(".js"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n")
  : "";
if (bundle.length === 0) {
  problems.push("No JavaScript in dist/. Run `npm run build` first.");
} else {
  for (const [needle, source] of wanted) {
    if (!bundle.includes(needle)) problems.push(`${JSON.stringify(needle)}, from ${source}, is not in the built app.`);
  }
}

if (problems.length > 0) {
  console.error("The Desktop build does not carry its own wiring:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(`Desktop build carries its own wiring (${wanted.size} invocations, ${swapped.length} swapped modules accounted for).`);
