import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
// covers: transport.hyperdht

/**
 * The root's postinstall applies tools/patches/hyperdht+<version>.patch (lib/nat.js: an open NAT advertises its
 * sampled addresses) to the repository's node_modules only. The CLI left hyperdht an import resolved at run time, so
 * every install from npm ran the unpatched file. The build now bundles hyperdht with the patch applied
 * (packages/cli/vite.config.ts, hyperdhtPatched).
 */
const cli = resolve(import.meta.dirname, "..");
const root = resolve(cli, "../..");
const dist = join(cli, "dist");
const built = [join(dist, "ghostly.mjs"), ...readdirSync(join(dist, "assets")).filter((name) => /\.m?js$/.test(name)).map((name) => join(dist, "assets", name))];
const lines = new Set(built.flatMap((file) => readFileSync(file, "utf8").split("\n").map((line) => line.trim())));

it("bundles hyperdht: no built file imports it at run time", () => {
  for (const file of built) expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s*["']hyperdht["']|require\(\s*["']hyperdht["']\s*\)/);
});

it("bundles hyperdht with tools/patches applied: every line the patch adds is in the build, every line it removes is not", () => {
  const version = JSON.parse(readFileSync(join(cli, "package.json"), "utf8")).dependencies.hyperdht;
  const patch = readFileSync(join(root, `tools/patches/hyperdht+${version}.patch`), "utf8").split("\n");
  const added = patch.filter((line) => /^\+(?!\+\+ )/.test(line)).map((line) => line.slice(1).trim()).filter(Boolean);
  const removed = patch.filter((line) => /^-(?!-- )/.test(line)).map((line) => line.slice(1).trim()).filter(Boolean);
  expect(added.length).toBeGreaterThan(0);
  for (const line of added) expect(lines.has(line), line).toBe(true);
  for (const line of removed) expect(lines.has(line), line).toBe(false);
});

it("bundles the repository's hyperdht, never the copy the Desktop's sidecar folder installs for itself", () => {
  // tools/scripts/prepare-native-runtime.mjs gives native/transports/hyperdht a node_modules of its own; the runtime
  // imports that folder's endpoint.mjs, so without the alias the build took hyperdht from there (the macOS Desktop job).
  for (const file of built) expect(readFileSync(file, "utf8"), file).not.toContain("native/transports/hyperdht/node_modules/");
});
