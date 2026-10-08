#!/usr/bin/env node
/**
 * The "independently authored adapter" gate, run the way an outside author would: pack @ghostlytools/sdk
 * into a tarball, install that tarball into packages/sdk/examples/adapter (a project that is not part of the
 * workspace), and run the example's type check and tests, contract suites included.
 *
 * Then the mini-app gate on the same tarball: packages/sdk/examples/mini-app, copied into a temporary folder,
 * installs it and type checks against `@ghostlytools/sdk/app` (bundler and NodeNext resolution), and the entry's
 * JavaScript must import nothing, since an app bundles it into its one HTML file.
 *
 *   npm run test:sdk-example
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const example = join(root, "packages/sdk/examples/adapter");
const vendor = join(example, "vendor");
const run = (cwd, file, args) => execFileSync(file, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
// `prepack` builds the package first.
run(root, "npm", ["pack", "--workspace", "@ghostlytools/sdk", "--pack-destination", vendor]);
const packed = readdirSync(vendor).find((name) => name.endsWith(".tgz"));
if (!packed) throw new Error("npm pack produced no tarball");
renameSync(join(vendor, packed), join(vendor, "ghostly-sdk.tgz"));
console.log(`\nPacked ${packed} → packages/sdk/examples/adapter/vendor/ghostly-sdk.tgz\n`);

// A fresh install every time: the tarball's integrity changes with every build, and a lockfile left by
// the last run would keep the old package.
rmSync(join(example, "node_modules/@ghostlytools"), { recursive: true, force: true });
rmSync(join(example, "package-lock.json"), { force: true });
run(example, "npm", ["install", "--no-audit", "--no-fund"]);
run(example, "npm", ["run", "typecheck"]);
run(example, "npm", ["test"]);
console.log("\nThe example builds and passes the contract suites against the packed SDK.");

const miniApp = mkdtempSync(join(tmpdir(), "ghostly-mini-app-"));
try {
  cpSync(join(root, "packages/sdk/examples/mini-app"), miniApp, { recursive: true, filter: (path) => !/[\\/](node_modules|vendor)$/.test(path) && !path.endsWith("package-lock.json") });
  mkdirSync(join(miniApp, "vendor"));
  copyFileSync(join(vendor, "ghostly-sdk.tgz"), join(miniApp, "vendor/ghostly-sdk.tgz"));
  run(miniApp, "npm", ["install", "--no-audit", "--no-fund"]);
  run(miniApp, "npm", ["run", "typecheck"]);
  const installed = join(miniApp, "node_modules/@ghostlytools/sdk");
  const js = readFileSync(join(installed, "dist/app.js"), "utf8");
  if (/^\s*import\b|\bimport\(|\brequire\(|^export .* from /m.test(js)) throw new Error("@ghostlytools/sdk/app's dist/app.js imports something: an app would bundle it");
  const exported = execFileSync(process.execPath, ["--input-type=module", "-e", 'console.log(Object.keys(await import("@ghostlytools/sdk/app")).sort().join(" "))'], { cwd: miniApp, encoding: "utf8" }).trim();
  if (exported !== "MINI_APP_ERROR_CODES MINI_APP_LIMITS miniAppErrorCode") throw new Error(`@ghostlytools/sdk/app exports ${exported}`);
  console.log("\nThe mini-app example type checks against the packed SDK's /app entry, which imports nothing.");
} finally {
  rmSync(miniApp, { recursive: true, force: true });
}
