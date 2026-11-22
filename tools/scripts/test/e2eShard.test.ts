import { describe, expect, it } from "vitest";
import { fileSeconds, split } from "../../../e2e/shard.mjs";

/**
 * e2e/shard.mjs: e2e.yml's shards by time, not by Playwright's equal counts in file order, which gave shard 2 every
 * devices, dht and group story (51 to 62 test-minutes against 32 to 42 for the others, 2026-11-02).
 */
const report = (files: Record<string, { project?: string; tests: { duration: number; status?: string }[][] }>) => ({
  suites: Object.entries(files).map(([file, { project = "web", tests }]) => ({
    title: file,
    file,
    specs: tests.map((results, i) => ({ title: `test ${i}`, file, tests: [{ projectName: project, results: results.map((r) => ({ status: "passed", ...r })) }] })),
    suites: [],
  })),
});

describe("e2e/shard.mjs", () => {
  it("records a file's seconds as the sum of its tests' passed runs, retries and failures left out", () => {
    const seconds = fileSeconds([
      report({
        "web/a.spec.ts": { tests: [[{ duration: 30_000 }], [{ duration: 180_000, status: "failed" }, { duration: 20_000 }]] },
        "extension/b.spec.ts": { project: "extension", tests: [[{ duration: 90_000, status: "timedOut" }]] },
      }),
    ]);
    expect(seconds).toEqual({ "[web] › web/a.spec.ts": 50 });
  });

  it("records a file whose tests CI skips as taking no time, not as a typical one", () => {
    const seconds = fileSeconds([report({ "web/mint.spec.ts": { tests: [[{ duration: 0, status: "skipped" }]] } })]);
    expect(seconds).toEqual({ "[web] › web/mint.spec.ts": 0 });
  });

  it("averages a file over the reports that ran it", () => {
    const seconds = fileSeconds([
      report({ "web/a.spec.ts": { tests: [[{ duration: 40_000 }]] } }),
      report({ "web/a.spec.ts": { tests: [[{ duration: 60_000 }]] }, "web/b.spec.ts": { tests: [[{ duration: 10_000 }]] } }),
    ]);
    expect(seconds).toEqual({ "[web] › web/a.spec.ts": 50, "[web] › web/b.spec.ts": 10 });
  });

  // The order Playwright's --shard would have cut: the slow ones side by side.
  const files = ["a", "b", "c", "d1", "d2", "d3", "d4", "e", "f", "g", "h", "i"].map((f) => `[web] › web/${f}.spec.ts`);
  const seconds = Object.fromEntries(files.map((f) => [f, f.includes("/d") ? 400 : 100]));

  it("puts every file in exactly one shard", () => {
    const shards = split(files, seconds, 4);
    expect(shards.flatMap((s) => s.ids).sort()).toEqual([...files].sort());
  });

  it("spreads the slow files instead of cutting them into one shard", () => {
    const shards = split(files, seconds, 4);
    for (const s of shards) expect(s.ids.filter((id) => id.includes("/d"))).toHaveLength(1);
    expect(Math.max(...shards.map((s) => s.load)) - Math.min(...shards.map((s) => s.load))).toBeLessThanOrEqual(100);
  });

  it("counts a file it has no time for as a typical one, so a new spec never goes missing", () => {
    const shards = split([...files, "[extension] › extension/new.spec.ts"], seconds, 4);
    const home = shards.find((s) => s.ids.includes("[extension] › extension/new.spec.ts"));
    expect(home).toBeDefined();
    expect(shards.reduce((sum, s) => sum + s.load, 0)).toBe(8 * 100 + 4 * 400 + 100);
  });

  it("gives every shard the same split whatever order the list comes in", () => {
    const again = split([...files].reverse(), seconds, 4);
    expect(again).toEqual(split(files, seconds, 4));
  });
});
