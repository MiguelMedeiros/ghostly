// Every package the site lists is one its code, configs or scripts name. Each `npm ci` of the site (the checks job,
// the four browser shards and the image's deps stage) installs them all, and an install script runs every time:
// Puppeteer stayed for weeks after its only user (screenshot-tool.js) went, downloading a Chrome on every install.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(site, "package.json"), "utf8"));

/** Packages used with no line naming them, and why. `@types/*` too: TypeScript reads every one it finds. */
const IMPLICIT = { "react-dom": "Next renders the pages with it (a peer of next)" };

const SKIP = new Set(["node_modules", ".next", "public"]);

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:[cm]?[jt]sx?|css|json)$/.test(entry.name) && !/^package(?:-lock)?\.json$/.test(entry.name) ? [path] : [];
  });
}

test("every dependency of the site is named by its code, configs or scripts", () => {
  const text = sources(site).map((file) => readFileSync(file, "utf8")).join("\n");
  const scripts = Object.values(pkg.scripts).join("\n");
  const unused = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => {
    if (name in IMPLICIT || name.startsWith("@types/")) return false;
    const quoted = new RegExp(`["'\`]${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:/[^"'\`]*)?["'\`]`);
    return !quoted.test(text) && !new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "m").test(scripts);
  });
  assert.deepEqual(unused, [], "remove them from package.json (and the lock), or say in IMPLICIT why they stay");
});
