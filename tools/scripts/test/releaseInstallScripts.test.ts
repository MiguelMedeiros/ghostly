import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * The release installs the root's dependencies with `npm ci --ignore-scripts`: no dependency's install script runs
 * where the Desktop, the extension and the Android app are built and signed, or where the CLI and SDK tarballs for npm
 * are packed. The one that did anything was better-sqlite3's, which downloads a native binary with no checksum; only
 * the Breez SDK's Node.js entry loads it, and the clients bundle its web entry. The root's own postinstall (the
 * dependency patches, the built-in apps) still runs.
 */
const root = join(import.meta.dirname, "../../..");
const workflow = (name: string) => readFileSync(join(root, ".github/workflows", name), "utf8");
const release = workflow("release.yml");
// The workflows the release calls build what it ships, except e2e.yml: a test gate whose builds are thrown away.
const called = [...release.matchAll(/uses: \.\/\.github\/workflows\/([\w.-]+)/g)].map((m) => m[1]);
const builds = ["release.yml", ...called.filter((name) => name !== "e2e.yml"), "npm-publish.yml"];

it("runs no dependency's install script in the release, and still runs the root's postinstall", () => {
  expect(called).toEqual(expect.arrayContaining(["e2e.yml", "android.yml"]));
  for (const name of builds) {
    const installs = workflow(name).split("\n").filter((line) => /\bnpm ci\b/.test(line) && !line.trim().startsWith("#"));
    expect(installs.length, name).toBeGreaterThan(0);
    for (const line of installs) expect(line.trim(), name).toMatch(/^run: npm ci --ignore-scripts( --no-audit --no-fund)? && npm run postinstall$/);
  }
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.postinstall).toMatch(/^patch-package --patch-dir tools\/patches/);
});

it("bundles only the Breez SDK's web entry, which needs no better-sqlite3", () => {
  const imports = execFileSync("git", ["grep", "-h", "-o", "-E", "[\"']@breeztech/breez-sdk-spark[^\"']*[\"']", "--", "apps/**/*.ts", "apps/**/*.tsx", "apps/**/*.mjs", "packages/**/*.ts", "packages/**/*.tsx", "packages/**/*.mjs", ":!**/test/**"], { cwd: root, encoding: "utf8" });
  expect([...new Set(imports.split("\n").filter(Boolean).map((s) => s.slice(1, -1)))].sort()).toEqual(["@breeztech/breez-sdk-spark/web"]);
});
