import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { versionedJson } from "../bump-version.mjs";
// covers: headless.package

const root = resolve(import.meta.dirname, "../../..");
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

/** The workflow's jobs by id, each its own text without comments (a comment above a job sits at the end of the one before). */
function jobs(): Record<string, string> {
  const workflow = read(".github/workflows/npm-publish.yml");
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const out: Record<string, string> = {};
  for (const part of body.split(/^(?= {2}[a-z][a-z-]*:$)/m)) {
    const id = /^ {2}([a-z][a-z-]*):$/m.exec(part)?.[1];
    if (id) out[id] = part.replace(/^ *#.*\n/gm, "");
  }
  return out;
}

describe("npm-publish.yml's tokens", () => {
  const all = jobs();

  it("only the two publish jobs can ask for one, and both run in the npm environment their Trusted Publishers name", () => {
    expect(Object.keys(all).sort()).toEqual(["check-cli", "check-sdk", "publish", "publish-sdk", "verify-sdk"]);
    const withToken = Object.keys(all).filter((id) => /id-token: write/.test(all[id]!)).sort();
    expect(withToken).toEqual(["publish", "publish-sdk"]);
    for (const id of withToken) expect(all[id], id).toMatch(/^ {4}environment: npm$/m);
    expect(read("docs/RELEASING.md")).toContain("environment `npm`");
  });

  it("publishes the SDK tarball verify-sdk checked, with no install, build or script where the token is", () => {
    expect(all["verify-sdk"]).toContain("npm run test:sdk-example");
    expect(all["verify-sdk"]).toContain("actions/upload-artifact@");
    const publish = all["publish-sdk"]!;
    expect(publish).toMatch(/needs: verify-sdk/);
    expect(publish).toContain("actions/download-artifact@");
    expect(publish).toContain('npm publish "$RUNNER_TEMP/sdk/ghostlytools-sdk-$VERSION.tgz" --provenance --access public --ignore-scripts');
    for (const step of ["actions/checkout@", "npm ci", "npm install", "npm run"]) expect(publish, step).not.toContain(step);
    expect(publish).not.toMatch(/^ +cache:/m);
    // The checks that install from npm run where no token is.
    expect(all["check-sdk"]).toContain('npm install --no-audit --no-fund --prefer-online "@ghostlytools/sdk@$VERSION"');
    expect(all["check-cli"]).toContain('npm install --no-audit --no-fund --prefer-online "@ghostlytools/cli@$VERSION"');
  });
});
