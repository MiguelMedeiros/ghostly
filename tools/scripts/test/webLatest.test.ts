import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { image, verifiedDigest, verifyArgs } from "../web-image.mjs";
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

  it("moves from a published release, or by hand", () => {
    const workflow = read(".github/workflows/web-latest.yml");
    expect(workflow).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(workflow).toContain('node tools/scripts/web-latest.mjs "$TAG" "$latest"');
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
  });
});

describe("the web image a release deploys", () => {
  const tag = "v1.5.3";
  const digest = "a".repeat(64);
  const verified = (...digests: string[]) =>
    JSON.stringify(digests.map((sha256) => ({ verificationResult: { statement: { subject: [{ name: image(), digest: { sha256 } }] } } })));

  /** web-image.mjs with a `gh` that answers `answer` (exit 1 when null) and keeps its arguments. */
  function run(answer: string | null, ...args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "web-image-"));
    const gh = join(dir, "gh");
    writeFileSync(join(dir, "answer"), answer ?? "");
    writeFileSync(
      gh,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n${answer === null ? "exit 1" : `cat "${dir}/answer"`}\n`,
    );
    chmodSync(gh, 0o755);
    const output = join(dir, "output");
    writeFileSync(output, "");
    const result = spawnSync("node", [resolve(root, "tools/scripts/web-image.mjs"), ...args], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    const asked = existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8").trim().split("\n") : [];
    const out = { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8"), asked };
    rmSync(dir, { recursive: true, force: true });
    return out;
  }

  it("is the tag's image only when release.yml run from that tag attested it, pinned to the digest checked", () => {
    const ok = run(verified(digest), tag);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`${tag}@sha256:${digest}\n`);
    expect(ok.output).toBe(`ref=ghcr.io/miguelmedeiros/ghostly-web@sha256:${digest}\n`);
    expect(ok.asked).toEqual(verifyArgs(tag));
    expect(ok.asked).toEqual(
      expect.arrayContaining([
        `oci://ghcr.io/miguelmedeiros/ghostly-web:${tag}`,
        "https://github.com/MiguelMedeiros/ghostly/.github/workflows/release.yml@refs/tags/v1.5.3",
        "refs/tags/v1.5.3",
      ]),
    );
  });

  it("is refused when nothing vouches for one digest: an image a branch's workflow pushed, or retagged", () => {
    for (const answer of [null, "[]", "not json", verified("b".repeat(63)), verified(digest, "c".repeat(64))]) {
      const refused = run(answer, tag);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.output).toBe("");
    }
  });

  it("asks nothing for a ref that is not a release tag", () => {
    for (const ref of ["latest", "main", "v1.5.3-beta.1", "v1.5.3@sha256:" + digest, ""]) {
      const refused = run(verified(digest), ref);
      expect(refused.status).toBe(1);
      expect(refused.asked).toEqual([]);
    }
    expect(() => verifyArgs("latest")).toThrow(/not a release tag/);
    expect(() => verifiedDigest("[]")).toThrow(/no single verified/);
  });

  it("is attested by the tag's build, and the only image latest and the deploy take", () => {
    const build = job(".github/workflows/release.yml", "build-web");
    expect(build).toMatch(/^ {6}id-token: write$/m);
    expect(build).toMatch(/^ {6}attestations: write$/m);
    expect(build).toContain("uses: actions/attest-build-provenance@");
    expect(build).toContain("subject-digest: ${{ steps.push.outputs.digest }}");
    expect(build).toContain("push-to-registry: true");

    const latest = job(".github/workflows/web-latest.yml", "latest");
    expect(latest).toContain('node tools/scripts/web-image.mjs "$TAG" "$GITHUB_REPOSITORY"');
    expect(latest).toContain('docker buildx imagetools create --tag "$image:latest" "$REF"');
    expect(latest).not.toContain('"$image:$TAG"');
    expect(latest.indexOf("web-image.mjs")).toBeLessThan(latest.indexOf("imagetools create"));

    expect(read("docs/RELEASING.md")).toContain('tag=$(node tools/scripts/web-image.mjs v1.0.0) && export GHOSTLY_WEB_TAG="$tag"');
  });
});
