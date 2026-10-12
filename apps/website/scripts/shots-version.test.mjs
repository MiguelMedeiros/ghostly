import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The caption under an app screenshot names a version ("Ghostly {n}": home.next.fromDev, agents.show.caption). It is
// the release the site offers, without its patch (SHOTS_VERSION, lib/release.ts): tools/scripts/bump-version.mjs sets
// VERSION there, so the caption follows each release. A version written by hand beside it stays behind.
const website = fileURLToPath(new URL("..", import.meta.url));
const root = join(website, "../..");

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("the screenshots' version is made from the release's, which is the app's", () => {
  const release = readFileSync(join(website, "lib/release.ts"), "utf8");
  const version = /export const VERSION = "(\d+\.\d+\.\d+)";/.exec(release)?.[1];
  assert.equal(version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "lib/release.ts and package.json name one version");
  const made = /export const SHOTS_VERSION = (.+);/.exec(release)?.[1];
  assert.ok(made, "lib/release.ts exports SHOTS_VERSION");
  assert.equal(new Function("VERSION", `return ${made}`)(version), version.split(".").slice(0, 2).join("."));
  assert.equal(new Function("VERSION", `return ${made}`)("2.10.3"), "2.10");
});

test("every screenshot caption with a version takes it from the release", () => {
  const filled = [];
  for (const dir of ["components", "app"]) {
    for (const path of sources(join(website, dir))) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const by = /(?:fromDev|shotLabel|show\.caption)\.replace\("\{n\}", (\w+)\)/.exec(line);
        if (by) filled.push(`${relative(website, path)}: ${by[1]}`);
      }
    }
  }
  assert.deepEqual(filled.sort(), ["components/agents/AgentsPage.tsx: SHOTS_VERSION", "components/home/NextSection.tsx: SHOTS_VERSION", "components/home/SpaceSection.tsx: SHOTS_VERSION"]);
});
