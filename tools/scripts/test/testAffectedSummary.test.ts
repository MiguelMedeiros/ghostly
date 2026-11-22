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

/** The plan's "lint (eslint)" and "typecheck (tsc)" lines for a change both would check, with these flags. */
function planLines(...flags: string[]): { lint: string[]; typecheck: string[] } {
  const r = spawnSync(process.execPath, ["tools/scripts/test-affected.mjs", "--list", "--no-e2e", "--no-rust", ...flags, "--files", "apps/ui/src/App.tsx"], { cwd: ROOT, encoding: "utf8" });
  expect(r.status).toBe(0);
  const lines = r.stdout.split("\n");
  const section = (title: string) => {
    const from = lines.indexOf(title) + 1;
    const to = lines.findIndex((l, i) => i >= from && !l.startsWith(" "));
    return lines.slice(from, to);
  };
  return { lint: section("lint (eslint)"), typecheck: section("typecheck (tsc)") };
}

describe("test-affected.mjs's plan", () => {
  it("says lint and typecheck are off under --no-lint/--no-typecheck, as CI's draft job runs it", () => {
    const { lint, typecheck } = planLines("--no-lint", "--no-typecheck");
    expect(lint).toEqual(["  off     --no-lint"]);
    expect(typecheck.some((l) => l.includes("off     ui (root tsconfig) --no-typecheck"))).toBe(true);
    expect(typecheck.filter((l) => /^\s+run\s/.test(l))).toEqual([]);
  });

  it("without the flags, says what lint and typecheck run", () => {
    const { lint, typecheck } = planLines();
    expect(lint).toEqual(["  files   eslint over 1 changed file(s): apps/ui/src/App.tsx"]);
    expect(typecheck.some((l) => /^\s+run\s+ui \(root tsconfig\)/.test(l))).toBe(true);
  });
}, 60_000);
