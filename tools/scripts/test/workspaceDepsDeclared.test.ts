import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * Every package a workspace's `src/` imports is in that workspace's package.json. npm hoists `@ghostly/core`'s
 * dependencies to the root, so packages/browser imported @noble/*, @scure/base and keet-identity-key with nothing in
 * its own manifest: they resolved to whatever copy core's pins hoisted, and the lock also holds older copies of the
 * same packages under nostr-tools, ethers and bip39. A change in core's pins, or in which copy npm hoists, changed what
 * browser's code got, and nothing recorded it. The website's deps-used test checks the other way round.
 */
const root = resolve(import.meta.dirname, "../../..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** The bare specifiers a file imports, read by TypeScript's own scanner: not words in comments or strings. */
const imports = (text: string) =>
  ts
    .preProcessFile(text, true, true)
    .importedFiles.map(({ fileName }) => fileName)
    .filter((name) => !name.startsWith(".") && !name.startsWith("/"));

/** The package an import names: `@scope/name` or `name`, without a subpath. */
const packageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const isTest = (file: string) => /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);

const workspaces = (): string[] => {
  const patterns: string[] = json("package.json").workspaces;
  const manifests = execFileSync("git", ["ls-files", "--", ...patterns.map((p) => `${p}/package.json`)], {
    cwd: root,
    encoding: "utf8",
  });
  return manifests
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replace(/\/package\.json$/, ""));
};

const undeclared = (workspace: string): string[] => {
  const manifest = json(`${workspace}/package.json`);
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const files = execFileSync("git", ["ls-files", "--", `${workspace}/src`], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.ts$/.test(file) && !isTest(file));
  const missing = new Map<string, string>();
  for (const file of files) {
    for (const specifier of imports(readFileSync(join(root, file), "utf8"))) {
      const name = packageOf(specifier);
      if (specifier.startsWith("node:") || builtinModules.includes(name) || declared.has(name)) continue;
      if (!missing.has(name)) missing.set(name, file);
    }
  }
  return [...missing].map(([name, file]) => `${workspace}: ${name} (e.g. ${file})`).sort();
};

it("every package a workspace's src imports is declared in its own package.json", () => {
  const list = workspaces();
  expect(list).toContain("packages/browser");
  expect(list.flatMap(undeclared)).toEqual([]);
});
