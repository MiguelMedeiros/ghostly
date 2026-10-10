import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { refusal } from "../web-latest.mjs";

const root = resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

/** One job of a workflow, by id, without comments. */
function job(file: string, id: string): string {
  const workflow = read(file);
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const part = body.split(/^(?= {2}[a-z][a-z-]*:$)/m).find((p) => p.startsWith(`  ${id}:\n`));
  if (!part) throw new Error(`${file} has no job ${id}`);
  return part.replace(/^ *#.*\n/gm, "");
}

describe("the web image's latest tag", () => {
  const published = ["v1.1.4", "v1.1.5", "v1.1.6", "v1.0.0"];

  it("moves to the newest published release when it is GitHub's Latest", () => {
    expect(refusal("v1.1.6", "v1.1.6", published)).toBeNull();
    expect(refusal("v1.2.0", "v1.2.0", [...published, "v1.2.0"])).toBeNull();
  });

  it("stays when the release is a draft, a pre-release or not a release at all", () => {
    expect(refusal("v1.1.7", "v1.1.6", published)).toMatch(/no published release/);
    expect(refusal("v1.2.0-beta.1", "v1.1.6", [...published, "v1.2.0-beta.1"])).toMatch(/not a release tag/);
    expect(refusal("main", "v1.1.6", published)).toMatch(/not a release tag/);
  });

  it("never moves back to an older release, even one marked Latest", () => {
    expect(refusal("v1.1.5", "v1.1.6", published)).toMatch(/latest release is v1.1.6/);
    expect(refusal("v1.1.5", "v1.1.5", published)).toMatch(/v1.1.6 is published and newer/);
    expect(refusal("v1.9.0", "v1.9.0", ["v1.9.0", "v1.10.0"])).toMatch(/v1.10.0 is published and newer/);
  });

  it("says so to the workflow on its output", () => {
    const run = (tag: string, latest: string) =>
      execFileSync("node", [resolve(root, "tools/scripts/web-latest.mjs"), tag, latest], {
        input: published.join("\n") + "\n",
        env: { ...process.env, GITHUB_OUTPUT: "" },
        stdio: ["pipe", "pipe", "ignore"],
      }).toString();
    expect(run("v1.1.6", "v1.1.6")).toBe("move=true\n");
    expect(run("v1.1.5", "v1.1.6")).toBe("move=false\n");
  });

  it("is not pushed by a tag build, which may stay a draft or be an old tag built again", () => {
    const build = job(".github/workflows/release.yml", "build-web");
    expect(build).toContain("push: true");
    expect(build).not.toContain(":latest");
    // The tag's commit, not the dispatching branch's (github.sha).
    expect(build).not.toContain("github.sha");
    expect(build).toContain("git rev-parse HEAD");
    expect(build).toContain("GHOSTLY_BUILD=${{ steps.commit.outputs.sha }}");
  });

  it("moves from a published release, by hand or after a security autorelease", () => {
    const workflow = read(".github/workflows/web-latest.yml");
    expect(workflow).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(workflow).toContain('node tools/scripts/web-latest.mjs "$TAG" "$latest"');
    expect(workflow).toContain('docker buildx imagetools create --tag "$image:latest" "$image:$TAG"');
    expect(job(".github/workflows/security-autorelease.yml", "web")).toContain("gh workflow run web-latest.yml");
  });
});
