#!/usr/bin/env node
/**
 * The "independently authored adapter" gate, run the way an outside author would: pack @ghostlytools/sdk
 * into a tarball, install that tarball into packages/sdk/examples/adapter (a project that is not part of the
 * workspace), and run the example's type check and tests, contract suites included.
 *
 *   npm run test:sdk-example
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
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
