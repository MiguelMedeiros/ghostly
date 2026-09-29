import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { versionedJson } from "../bump-version.mjs";
// covers: headless.package

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const json = (file: string) => JSON.parse(read(file));

describe("the CLI on npm", () => {
  const cli = json("packages/cli/package.json");

  it("is a public package in the maintainer's npm organization", () => {
    expect(cli.name).toBe("@ghostlytools/cli");
    // A scoped package is private on npm unless it says otherwise.
    expect(cli.publishConfig).toEqual({ access: "public" });
    expect(cli.private).toBeUndefined();
    expect(cli.bin).toEqual({ ghostly: "./dist/ghostly.mjs" });
  });

  it("names this repository, which npm checks against the provenance of every publish", () => {
    expect(cli.repository).toEqual({ type: "git", url: "git+https://github.com/MiguelMedeiros/ghostly.git", directory: "packages/cli" });
  });

  it("moves with every release: bump-version sets its version with the others", () => {
    expect(versionedJson(root)).toContain("packages/cli/package.json");
    expect(cli.version).toBe(json("package.json").version);
  });

  it("is published by one workflow, from a published release, with a short-lived OIDC token", () => {
    const workflow = read(".github/workflows/npm-publish.yml");
    expect(workflow).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(workflow).toMatch(/^ {6}id-token: write$/m);
    expect(workflow).toContain("npm publish --workspace @ghostlytools/cli --provenance --access public");
    // A tag that does not match the package's version never reaches npm.
    expect(workflow).toContain('"v$version" != "$TAG"');
  });

  it("follows a security autorelease too, whose release (made with the workflow token) triggers nothing by itself", () => {
    expect(read(".github/workflows/security-autorelease.yml")).toContain("gh workflow run npm-publish.yml");
  });
});
