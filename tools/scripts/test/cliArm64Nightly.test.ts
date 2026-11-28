// guards: #8392
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI's "CLI on Linux ARM64" job installs the packed CLI and starts its daemon with WebRTC and calls; the CLI's whole
 * suite, which the x64 packages shards already run on every pull request, runs on arm64 nightly, and a red night files
 * an issue.
 */
const root = resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, ".github/workflows", file), "utf8");
const SUITE = "run: npm run test -w @ghostlytools/cli";

describe("the CLI on Linux ARM64", () => {
  it("in CI: pack, install and the daemon with WebRTC and calls, not the suite", () => {
    const job = read("ci.yml").match(/^ {2}cli-linux-arm64:\n[\s\S]*?(?=^ {2}[\w-]+:\n)/m)?.[0] ?? "";
    expect(job).toContain("runs-on: ubuntu-24.04-arm");
    expect(job).toContain("- name: Pack and install the package");
    expect(job).toContain("- name: The installed CLI runs a daemon with WebRTC and calls");
    expect(job).not.toContain(SUITE);
  });

  it("nightly: the whole suite on arm64, and a red night opens or updates an issue", () => {
    const workflow = read("cli-arm64-nightly.yml");
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: /m);
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain(SUITE);
    expect(workflow).toMatch(/^ {4}if: failure\(\) && github\.event_name == 'schedule'$/m);
    expect(workflow).toMatch(/^ {6}issues: write$/m);
    expect(workflow).toContain('gh issue comment "$number"');
    expect(workflow).toContain('gh issue create --title "$TITLE"');
  });
});
