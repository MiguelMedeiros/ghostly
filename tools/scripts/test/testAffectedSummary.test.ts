import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** test-affected.mjs's last line over a change that reaches no step, as CI's draft job runs it (GITHUB_ACTIONS) or locally. */
function lastLine(ci: boolean): string {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  if (ci) env.GITHUB_ACTIONS = "true";
  const r = spawnSync(process.execPath, ["tools/scripts/test-affected.mjs", "--files", "docs/TESTING.md", "--no-e2e", "--no-rust", "--no-lint", "--no-typecheck"], { cwd: ROOT, encoding: "utf8", env });
  expect(r.status).toBe(0);
  return r.stdout.trim().split("\n").at(-1)!;
}

describe("test-affected.mjs's closing line", () => {
  it("says nothing ran when every step was skipped, not that the checks passed", () => {
    expect(lastLine(false)).toMatch(/^Nothing ran/);
  });

  it("in CI's draft job, says the full suite runs once the pull request leaves draft, not on every push", () => {
    const line = lastLine(true);
    expect(line).not.toContain("on every push");
    expect(line).toContain("Leaving draft runs the full suite.");
  });

  it("locally, does not claim every push gets the full suite", () => {
    expect(lastLine(false)).not.toContain("on every push");
  });
}, 60_000);
