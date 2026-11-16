import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { ghostlyScopeProblems } from "../ghostly-scope-lock.mjs";

/**
 * The workspaces are `@ghostly/*` with `"*"` ranges, and the npm scope `@ghostly` is another account's: a lock that
 * resolves one of them from the registry installs that account's package. tools/scripts/ghostly-scope-lock.mjs refuses
 * such a lock; here on a small one, and on the repository's own.
 */
const root = resolve(import.meta.dirname, "../../..");
const script = resolve(root, "tools/scripts/ghostly-scope-lock.mjs");

type Lock = { lockfileVersion: number; packages: Record<string, Record<string, unknown>> };

/** Two workspaces linked the way npm writes them, and an unrelated `@ghostlytools` package from the registry. */
const fixture = (): Lock => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "ghostly", workspaces: ["packages/*"] },
    "packages/core": { name: "@ghostly/core", version: "1.0.0" },
    "packages/browser": { name: "@ghostly/browser", version: "1.0.0", dependencies: { "@ghostly/core": "*" } },
    "node_modules/@ghostly/core": { resolved: "packages/core", link: true },
    "node_modules/@ghostly/browser": { resolved: "packages/browser", link: true },
    "node_modules/@ghostlytools/sdk": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/@ghostlytools/sdk/-/sdk-1.0.0.tgz",
      integrity: "sha512-sdk",
    },
  },
});

const fromRegistry = { version: "9.9.9", resolved: "https://registry.npmjs.org/@ghostly/core/-/core-9.9.9.tgz", integrity: "sha512-x" };

it("passes a lock whose @ghostly packages are all workspace links", () => {
  expect(ghostlyScopeProblems(fixture())).toEqual([]);
});

it("names, in one line, an @ghostly entry resolved from the registry", () => {
  const lock = fixture();
  lock.packages["node_modules/@ghostly/core"] = fromRegistry;
  expect(ghostlyScopeProblems(lock)).toEqual([
    "package-lock.json: node_modules/@ghostly/core is not a workspace link (resolved from https://registry.npmjs.org/@ghostly/core/-/core-9.9.9.tgz): the npm scope @ghostly is not ours",
  ]);
});

it("finds a nested copy under another package too", () => {
  const lock = fixture();
  lock.packages["packages/browser/node_modules/@ghostly/core"] = fromRegistry;
  expect(ghostlyScopeProblems(lock)).toEqual([expect.stringContaining("packages/browser/node_modules/@ghostly/core is not a workspace link")]);
});

it("finds an alias whose tarball is in the @ghostly scope, escaped or not", () => {
  const lock = fixture();
  lock.packages["node_modules/core-alias"] = fromRegistry;
  lock.packages["node_modules/other"] = { ...fromRegistry, resolved: "https://registry.example/%40ghostly%2fcore/-/core-9.9.9.tgz" };
  expect(ghostlyScopeProblems(lock)).toEqual([
    `package-lock.json: node_modules/core-alias is resolved from ${fromRegistry.resolved}: the npm scope @ghostly is not ours`,
    "package-lock.json: node_modules/other is resolved from https://registry.example/%40ghostly%2fcore/-/core-9.9.9.tgz: the npm scope @ghostly is not ours",
  ]);
});

it("refuses a link to a folder the lock does not have", () => {
  const lock = fixture();
  lock.packages["node_modules/@ghostly/core"] = { resolved: "packages/gone", link: true };
  expect(ghostlyScopeProblems(lock)).toEqual(["package-lock.json: node_modules/@ghostly/core links to packages/gone, which is no package in the lock"]);
});

it("passes on the repository's package-lock.json", () => {
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  expect(Object.keys(lock.packages)).toContain("node_modules/@ghostly/core");
  expect(ghostlyScopeProblems(lock)).toEqual([]);
  expect(execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" })).toContain("every @ghostly/* package is a workspace link");
});
