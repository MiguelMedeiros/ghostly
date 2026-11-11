import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * The release installs the root's dependencies with `npm ci --ignore-scripts`: no dependency's install script runs
 * where the Desktop and the extension are built and signed. The one that did anything was better-sqlite3's, which
 * downloads a native binary with no checksum; only the Breez SDK's Node.js entry loads it, and the clients bundle its
 * web entry. The root's own postinstall (the dependency patches, the built-in apps) still runs.
 */
const root = join(import.meta.dirname, "../../..");
const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");

it("runs no dependency's install script in the release, and still runs the root's postinstall", () => {
  const installs = release.split("\n").filter((line) => /\bnpm ci\b/.test(line));
  expect(installs.length).toBeGreaterThan(0);
  for (const line of installs) expect(line.trim()).toBe("run: npm ci --ignore-scripts && npm run postinstall");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.postinstall).toMatch(/^patch-package --patch-dir tools\/patches/);
});

it("bundles only the Breez SDK's web entry, which needs no better-sqlite3", () => {
  const imports = execFileSync("git", ["grep", "-h", "-o", "-E", "[\"']@breeztech/breez-sdk-spark[^\"']*[\"']", "--", "apps/**/*.ts", "apps/**/*.tsx", "apps/**/*.mjs", "packages/**/*.ts", "packages/**/*.tsx", "packages/**/*.mjs", ":!**/test/**"], { cwd: root, encoding: "utf8" });
  expect([...new Set(imports.split("\n").filter(Boolean).map((s) => s.slice(1, -1)))].sort()).toEqual(["@breeztech/breez-sdk-spark/web"]);
});
