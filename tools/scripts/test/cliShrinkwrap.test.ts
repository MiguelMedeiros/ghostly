import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cliShrinkwrap } from "../cli-shrinkwrap.mjs";
// covers: headless.package

/**
 * The CLI went to npm with no npm-shrinkwrap.json, so every `npm install -g @ghostlytools/cli` resolved its ~240
 * packages from the registry's ranges that day: a release's install carried dozens of versions its CI never ran, and
 * none of the root's `overrides`. tools/scripts/cli-shrinkwrap.mjs cuts the CLI's tree out of package-lock.json, and
 * the publish workflow ships it in the package.
 */
const root = resolve(import.meta.dirname, "../../..");
const json = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8"));

type Entry = Record<string, unknown> & { version?: string; resolved?: string; integrity?: string };
type Lock = { lockfileVersion: number; packages: Record<string, Entry> };

const tarball = (name: string, version: string): Entry => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
});

/** A workspace root like ours: the CLI, a second workspace, a link, dev tools, an override and a shadowed version. */
function fixture(): Lock {
  return {
    lockfileVersion: 3,
    packages: {
      "": { name: "ghostly", workspaces: ["packages/*"], devDependencies: { vite: "^8.0.0" } },
      "packages/cli": {
        name: "@ghostlytools/cli", version: "1.2.3", license: "MIT", bin: { ghostly: "dist/ghostly.mjs" },
        dependencies: { a: "^1.0.0", shared: "^2.0.0" },
        devDependencies: { "@ghostly/browser": "*", vite: "^8.0.0" },
      },
      "packages/cli/node_modules/shared": tarball("shared", "2.0.0"),
      "packages/browser": { name: "@ghostly/browser", version: "0.0.0", dependencies: { other: "^1.0.0" } },
      "node_modules/@ghostly/browser": { resolved: "packages/browser", link: true },
      // a's dependency on schema says ^3, the root's `overrides` made it 4.
      "node_modules/a": { ...tarball("a", "1.4.0"), dependencies: { schema: "^3.25.0", shared: "^1.0.0", nested: "^1.0.0" }, optionalDependencies: { "a-darwin": "1.4.0" } },
      "node_modules/a/node_modules/nested": { ...tarball("nested", "1.0.0"), dependencies: { leaf: "^1.0.0" } },
      "node_modules/a-darwin": { ...tarball("a-darwin", "1.4.0"), optional: true, os: ["darwin"], cpu: ["arm64"] },
      "node_modules/schema": tarball("schema", "4.6.7"),
      "node_modules/shared": { ...tarball("shared", "1.5.0"), dependencies: { leaf: "^1.0.0" } },
      "node_modules/leaf": { ...tarball("leaf", "1.1.0"), dev: false },
      "node_modules/other": tarball("other", "1.0.0"),
      "node_modules/vite": { ...tarball("vite", "8.3.6"), dev: true, dependencies: { leaf: "^1.0.0" } },
    },
  };
}

describe("the CLI's npm-shrinkwrap.json from a lockfile", () => {
  const lock = fixture();
  const out = cliShrinkwrap(lock) as Lock & { name: string; version: string };
  const placed = out.packages;

  it("holds the CLI's production dependencies and what they reach, nothing else", () => {
    expect(Object.keys(placed).sort()).toEqual([
      "",
      "node_modules/a",
      "node_modules/a-darwin",
      "node_modules/a/node_modules/nested",
      "node_modules/a/node_modules/shared",
      "node_modules/leaf",
      "node_modules/schema",
      "node_modules/shared",
    ]);
    expect(out).toMatchObject({ name: "@ghostlytools/cli", version: "1.2.3", lockfileVersion: 3, requires: true });
    expect(placed[""]).toEqual({ name: "@ghostlytools/cli", version: "1.2.3", license: "MIT", bin: { ghostly: "dist/ghostly.mjs" }, dependencies: { a: "^1.0.0", shared: "^2.0.0" } });
  });

  it("keeps the lockfile's version, tarball and integrity for each, the root's overrides included", () => {
    const from: Record<string, string> = {
      "node_modules/a": "node_modules/a",
      "node_modules/a-darwin": "node_modules/a-darwin",
      "node_modules/a/node_modules/nested": "node_modules/a/node_modules/nested",
      // The root hoists shared@1 for a; the CLI's own shared@2 takes the top, so a gets its copy beside it.
      "node_modules/a/node_modules/shared": "node_modules/shared",
      "node_modules/leaf": "node_modules/leaf",
      "node_modules/schema": "node_modules/schema",
      "node_modules/shared": "packages/cli/node_modules/shared",
    };
    for (const [at, source] of Object.entries(from)) {
      const { version, resolved, integrity } = lock.packages[source]!;
      expect({ at, version: placed[at]!.version, resolved: placed[at]!.resolved, integrity: placed[at]!.integrity }).toEqual({ at, version, resolved, integrity });
    }
    expect(placed["node_modules/schema"]!.version).toBe("4.6.7");
    expect(placed["node_modules/a-darwin"]).toMatchObject({ optional: true, os: ["darwin"], cpu: ["arm64"] });
  });

  it("carries no workspace link, local package or dev flag", () => {
    for (const [at, entry] of Object.entries(placed)) {
      expect(entry.link, at).toBeUndefined();
      expect(entry.dev, at).toBeUndefined();
      expect(entry.devOptional, at).toBeUndefined();
      if (at) expect(entry.resolved, at).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(JSON.stringify(entry), at).not.toContain("file:");
    }
    expect(placed[""]!.devDependencies).toBeUndefined();
  });

  it("refuses a tree it cannot ship as tested: a workspace dependency, a local package, a missing package", () => {
    const linked = fixture();
    linked.packages["packages/cli"]!.dependencies = { "@ghostly/browser": "*" };
    expect(() => cliShrinkwrap(linked)).toThrow(/workspace link/);
    const local = fixture();
    local.packages["node_modules/leaf"]!.resolved = "file:../leaf";
    expect(() => cliShrinkwrap(local)).toThrow(/not a registry tarball/);
    const missing = fixture();
    delete missing.packages["node_modules/leaf"];
    expect(() => cliShrinkwrap(missing)).toThrow(/needs leaf/);
  });
});

describe("the CLI's npm-shrinkwrap.json from this repository's package-lock.json", () => {
  const lock = json("package-lock.json") as Lock;
  const out = cliShrinkwrap(lock) as Lock;
  const entries = Object.entries(out.packages).filter(([at]) => at);
  const named = (name: string) => entries.filter(([at]) => at === `node_modules/${name}` || at.endsWith(`/node_modules/${name}`));

  it("resolves zod to the root's override, everywhere", () => {
    const override = json("package.json").overrides.zod;
    expect(named("zod").map(([at, entry]) => `${at} ${entry.version}`)).toEqual([`node_modules/zod ${override}`]);
  });

  it("has hyperdht at the version the lockfile and the CLI pin", () => {
    const version = lock.packages["node_modules/hyperdht"]!.version;
    expect(json("packages/cli/package.json").dependencies.hyperdht).toBe(version);
    expect(named("hyperdht").map(([at, entry]) => `${at} ${entry.version}`)).toEqual([`node_modules/hyperdht ${version}`]);
  });

  it("is made only of packages the lockfile has, with the same tarball and integrity", () => {
    const known = new Set(Object.values(lock.packages).map((entry) => `${entry.version} ${entry.resolved} ${entry.integrity}`));
    expect(entries.length).toBeGreaterThan(100);
    for (const [at, entry] of entries) {
      expect(entry.integrity, at).toMatch(/^sha512-/);
      expect(known.has(`${entry.version} ${entry.resolved} ${entry.integrity}`), at).toBe(true);
    }
  });
});

describe("the package npm gets", () => {
  it("ships npm-shrinkwrap.json, which git never tracks", () => {
    const cli = json("packages/cli/package.json");
    expect(cli.files).toContain("npm-shrinkwrap.json");
    expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toMatch(/^\/packages\/cli\/npm-shrinkwrap\.json$/m);
    // `npm pack` leaves out any file `files` does not name, a shrinkwrap included.
    const dir = mkdtempSync(join(tmpdir(), "cli-pack-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...cli, scripts: {} }));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/ghostly.mjs"), "\n");
    writeFileSync(join(dir, "npm-shrinkwrap.json"), JSON.stringify(cliShrinkwrap(json("package-lock.json"))));
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" }));
    expect(packed.files.map((file: { path: string }) => file.path)).toContain("npm-shrinkwrap.json");
  });

  it("is packed with it: the publish workflow writes it after the install, before npm pack", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/npm-publish.yml"), "utf8");
    const at = (text: string) => workflow.indexOf(text);
    expect(at("node tools/scripts/cli-shrinkwrap.mjs")).toBeGreaterThan(at("run: npm ci"));
    expect(at("node tools/scripts/cli-shrinkwrap.mjs")).toBeLessThan(at("npm pack --workspace @ghostlytools/cli"));
    // What a person installs is checked against it.
    const check = workflow.slice(at("  check-cli:"), at("  verify-sdk:"));
    expect(check).toContain('const cli = "node_modules/@ghostlytools/cli";');
    expect(check).toContain("readFileSync(`${cli}/npm-shrinkwrap.json`");
    expect(check).toContain("node tree.cjs");
  });
});
