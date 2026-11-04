import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Build output stays out of the tree: a folder like packages/cli/dista (a build kept for an A/B) is 100 MB of bundles,
 * wasm and source maps that every CI checkout fetches and lint reads, and nobody can review. .gitignore covers them;
 * this catches the ones committed anyway (`git add -f`, or committed before the rule).
 */
const root = resolve(import.meta.dirname, "../../..");

describe("tracked files", () => {
  it("none of them is one .gitignore ignores", () => {
    const tracked = execFileSync("git", ["ls-files", "--cached", "--ignored", "--exclude-standard"], { cwd: root, encoding: "utf8" });
    expect(tracked.split("\n").filter(Boolean)).toEqual([]);
  });
});
