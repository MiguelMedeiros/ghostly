import { describe, expect, it } from "vitest";
import { bump, runGate } from "./autoreleaseGate.ts";

/**
 * `dev` holds `main` (main is merged back after each release), so a commit that sits on dev's tip is "on top of main"
 * too, and carries everything dev has not released. A security branch rebased onto dev (the merge train did that to a
 * lone queued pull request) must not ship that.
 */
describe("the security autorelease gate and dev's unreleased commits", () => {
  it("accepts a branch cut from main", () => {
    const run = runGate(bump());
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  it("refuses a branch that carries commits of dev that main does not have, in both modes", () => {
    for (const mode of ["all", "deps"] as const) {
      const run = runGate({ ...bump(), unreleased: 3 }, mode);
      expect(run.stderr).toContain("✗ carries 3 commits of dev that main does not have");
      expect(run.code).toBe(1);
      expect(run.outputs).toEqual({});
    }
  });
});
