import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `pull_request` run builds the pull request's own code: its Gradle files, build scripts and dependencies run in the
 * job with whatever the workflow put in their environment. GitHub gives a fork's pull request no secrets, but a branch
 * of this repository gets them all. So a workflow that runs on `pull_request` names a secret only behind
 * `github.event_name != 'pull_request' &&`, which leaves it empty there (GITHUB_TOKEN aside: GitHub scopes it to the
 * run). `pull_request_target` runs the base branch's code, not the pull request's, and is not counted here.
 */
const root = resolve(import.meta.dirname, "../../..");
const dir = resolve(root, ".github/workflows");
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => ({ file, text: readFileSync(resolve(dir, file), "utf8") }));

/** The events under `on:`, block or inline form. */
const triggers = (text: string): string[] => {
  const inline = text.match(/^on:[ \t]*\[([^\]]*)\]/m)?.[1];
  if (inline !== undefined) return inline.split(",").map((s) => s.trim());
  const single = text.match(/^on:[ \t]*([a-z_]+)[ \t]*$/m)?.[1];
  if (single) return [single];
  const block = text.match(/^on:[ \t]*\n((?: {2}.*\n|[ \t]*#.*\n|\n)+)/m)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
};

const GUARD = "github.event_name != 'pull_request' &&";

/** Every `${{ … }}` that reads a secret other than GITHUB_TOKEN, and every `secrets: inherit`, without the guard. */
const exposed = (text: string): string[] => [
  ...[...text.matchAll(/\$\{\{([^}]*)\}\}/g)]
    .map((m) => m[1].trim())
    .filter((expr) => /\bsecrets\.(?!GITHUB_TOKEN\b)\w+/.test(expr) && !expr.startsWith(GUARD)),
  ...[...text.matchAll(/^\s*secrets:\s*inherit\s*$/gm)].map((m) => m[0].trim()),
];

const onPullRequest = workflows.filter(({ text }) => triggers(text).includes("pull_request"));

describe("workflows that run on pull_request", () => {
  it("finds them, android.yml among them", () => {
    expect(onPullRequest.map((w) => w.file)).toEqual(expect.arrayContaining(["android.yml", "ci.yml"]));
    expect(triggers("on: [push, pull_request]\n")).toEqual(["push", "pull_request"]);
    expect(exposed("        env:\n          K: ${{ secrets.K }}\n")).toEqual(["secrets.K"]);
    expect(exposed(`          K: \${{ ${GUARD} secrets.K || '' }}\n`)).toEqual([]);
  });

  it.each(onPullRequest.map((w) => [w.file, w.text]))("%s gives no secret to a pull request's build", (_file, text) => {
    expect(exposed(text)).toEqual([]);
  });

  it("android.yml reads the upload key only outside pull requests", () => {
    const text = workflows.find((w) => w.file === "android.yml")?.text ?? "";
    for (const name of ["ANDROID_KEYSTORE_B64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
      const reads = text.split("\n").filter((line) => line.includes(`secrets.${name}`));
      expect(reads.length, name).toBeGreaterThan(0);
      for (const line of reads) expect(line, name).toContain(`\${{ ${GUARD} secrets.${name} || '' }}`);
    }
  });
});
