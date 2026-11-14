import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** test-affected.mjs over a change that reaches no step, with these arguments. */
function run(...args: string[]) {
  return spawnSync(process.execPath, ["tools/scripts/test-affected.mjs", "--files", "docs/TESTING.md", ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("test-affected.mjs's arguments", () => {
  it.each(["--lsit", "--no-e2"])("refuses %s before anything runs, with the usage", (typo) => {
    const r = run(typo);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`does not take ${typo}`);
    expect(r.stderr).toContain("npm run test:affected -- --list");
  });

  it("refuses a path given after --files ended, not only a flag", () => {
    const r = run("--list", "apps/ui/src/App.tsx");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("does not take apps/ui/src/App.tsx");
  });

  it("takes every flag and option it documents, as CI's draft job passes them", () => {
    const r = run("--base", "HEAD", "--port", "4999", "--unit-group", "2/4", "--no-e2e", "--no-rust", "--no-lint", "--no-typecheck", "--no-stack", "--list");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("test:affected — 1 changed file(s) from --files (1)");
  });
}, 60_000);
