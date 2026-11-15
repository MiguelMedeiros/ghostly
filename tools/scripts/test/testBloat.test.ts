import { describe, expect, it } from "vitest";
import {
  e2eFiles, flakes, growth, markdown, mockOnly, neverFailedSlow, pairs, parseArgs, parseMatrix, parsePerf,
  parsePlaywright, parseVitest, similarity, slowest, summary, unitCovers,
} from "../test-bloat-report.mjs";

// Tiny copies of what CI uploads: a packages shard's Vitest JSON, an E2E run's Playwright JSON, a matrix night.
const RUNNER = "/home/runner/work/ghostly/ghostly";
const vitestReport = (cases: [string, string, number][], file = "packages/core/test/a.test.ts", seconds = 3) => JSON.stringify({
  testResults: [{
    name: `${RUNNER}/${file}`, status: cases.some((c) => c[1] === "failed") ? "failed" : "passed", startTime: 1000, endTime: 1000 + seconds * 1000,
    assertionResults: cases.map(([title, status, duration]) => ({ fullName: title, title, status, duration })),
  }],
});
const result = (status: string, duration: number, retry = 0) => ({ status, duration, retry });
const playwrightReport = JSON.stringify({
  suites: [{
    title: "web/chat.spec.ts", file: "web/chat.spec.ts",
    specs: [{ title: "a message sent offline arrives later", file: "web/chat.spec.ts", tags: ["feature:chat.paired.offline-send"], tests: [{ projectName: "web", status: "flaky", results: [result("failed", 30_000), result("passed", 25_000, 1)] }] }],
    suites: [{ title: "groups", specs: [{ title: "a group opens", file: "web/chat.spec.ts", tags: [], tests: [{ projectName: "web", status: "expected", results: [result("passed", 5000)] }] }] }],
  }],
});

describe("test-bloat's arguments", () => {
  it("takes the window, the output file and one output form", () => {
    expect(parseArgs([])).toEqual({ since: 7, out: null, json: false, summary: false });
    expect(parseArgs(["--since", "14d", "--out", "r.md", "--summary"])).toEqual({ since: 14, out: "r.md", json: false, summary: true });
  });

  it.each([[["--since", "7"]], [["--since", "0d"]], [["--json", "--summary"]], [["--out"]], [["--weak"]]])("refuses %j", (args) => {
    expect(parseArgs(args)).toBeNull();
  });
});

describe("the parsers read CI's reports", () => {
  it("names a Vitest file by its repository path and package, with its seconds and cases", () => {
    expect(parseVitest(vitestReport([["sends", "passed", 1200]]))).toEqual([{
      path: "packages/core/test/a.test.ts", pkg: "packages/core", status: "passed", seconds: 3,
      cases: [{ key: "packages/core/test/a.test.ts › sends", status: "passed", ms: 1200 }],
    }]);
  });

  it("lists each Playwright test with its describe titles, tags, outcome and the time of all its tries", () => {
    expect(parsePlaywright(playwrightReport)).toEqual([
      { path: "e2e/web/chat.spec.ts", title: "a message sent offline arrives later", key: "e2e/web/chat.spec.ts › a message sent offline arrives later [web]", tags: ["feature:chat.paired.offline-send"], status: "flaky", ms: 55_000 },
      { path: "e2e/web/chat.spec.ts", title: "groups › a group opens", key: "e2e/web/chat.spec.ts › groups › a group opens [web]", tags: [], status: "expected", ms: 5000 },
    ]);
  });

  it("scores a matrix night and a perf night", () => {
    expect(parseMatrix(JSON.stringify({ rows: [{ status: "passed" }, { status: "timedOut" }, { status: "skipped" }] }))).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(parsePerf(JSON.stringify({ budgets: [{ value: 10, below: 20 }, { value: 30, below: 20 }] }))).toEqual({ met: 1, total: 2 });
  });

  it("reads a unit file's covers comment and its test titles", () => {
    expect(unitCovers('// covers: chat.paired.send, chat.paired.offline-send\nit("sends", () => {});\ntest.concurrent(`twice`, () => {});')).toEqual({
      features: ["chat.paired.send", "chat.paired.offline-send"], titles: ["sends", "twice"],
    });
  });
});

describe("the report's sections", () => {
  const now = [...parseVitest(vitestReport([["sends", "passed", 1500], ["fails once", "passed", 2500], ["quick", "passed", 5]])), ...parseVitest(vitestReport([["x", "passed", 1]], "packages/cli/test/b.test.ts", 60))];
  const then = parseVitest(vitestReport([["sends", "passed", 900]]));

  it("orders the slowest files and counts each package's growth", () => {
    expect(slowest(now, 1)).toEqual([{ path: "packages/cli/test/b.test.ts", pkg: "packages/cli", seconds: 60 }]);
    expect(growth(now, then)).toEqual([
      { pkg: "packages/cli", files: 1, cases: 1, minutes: 1, dFiles: 1, dCases: 1, dMinutes: 1 },
      { pkg: "packages/core", files: 1, cases: 3, minutes: 0.05, dFiles: 0, dCases: 2, dMinutes: 0 },
    ]);
    expect(growth(then, null)[0]).toMatchObject({ dFiles: null, dCases: null, dMinutes: null });
  });

  it("keeps the slow cases that never failed, slowest first", () => {
    const failed = new Set(["packages/core/test/a.test.ts › fails once"]);
    expect(neverFailedSlow(now.flatMap((f) => f.cases), failed, 1000)).toEqual([{ key: "packages/core/test/a.test.ts › sends", ms: 1500 }]);
  });

  it("counts the e2e tests that passed only on retry", () => {
    const run = parsePlaywright(playwrightReport);
    expect(flakes([run, run])).toEqual([{ key: "e2e/web/chat.spec.ts › a message sent offline arrives later [web]", times: 2 }]);
    expect(e2eFiles(run)).toMatchObject([{ path: "e2e/web/chat.spec.ts", pkg: "e2e", seconds: 60 }]);
  });

  it("pairs a unit and an e2e test on the same feature only when their names match", () => {
    expect(similarity("a message sent offline arrives", "the message sent offline arrives later")).toBe(0.8);
    const units = [{ path: "apps/ui/src/test/chat.test.tsx", features: ["chat.paired.offline-send"], titles: ["a message sent offline arrives later", "the composer clears"] }];
    expect(pairs(units, parsePlaywright(playwrightReport))).toEqual([{
      feature: "chat.paired.offline-send", unit: "apps/ui/src/test/chat.test.tsx › a message sent offline arrives later", e2e: "e2e/web/chat.spec.ts › a message sent offline arrives later", score: 1,
    }]);
  });

  it("counts the mock-only list by reason and by file", () => {
    const weak = [{ path: "a.test.ts", reason: "calls" }, { path: "a.test.ts", reason: "none" }, { path: "b.test.ts", reason: "exists" }];
    expect(mockOnly(weak)).toEqual({ total: 3, files: 2, byReason: { calls: 1, exists: 1, none: 1 }, top: [{ path: "a.test.ts", tests: 2 }, { path: "b.test.ts", tests: 1 }] });
  });

  it("says which artifact would carry a section it has no data for, and sums the week in five lines", () => {
    const none = (noData: string) => ({ noData });
    const data = {
      generated: "2026-11-16T09:00:00.000Z", since: 7, seconds: 40,
      window: { unitNow: { id: 1, at: "2026-11-16T08:00:00Z" }, unitThen: null, e2eNow: null, e2eThen: null, start: "2026-11-02", days: 14, failedRuns: 0, failedShards: 0, e2eRuns: 0 },
      slowest: { unit: slowest(now), e2e: none("e2e-results") },
      growth: growth(now, null),
      neverFailed: { unit: [], e2e: none("e2e-results") },
      mockOnly: mockOnly([]),
      pairs: none("e2e-results"),
      flakes: { e2e: none("e2e-results"), runs: 0, unit: none("a re-run attempt's report") },
      scores: { matrix: [{ at: "2026-11-16T03:46:00Z", text: "86/86 passed", run: "https://example.test/1" }], perf: none("e2e-perf-<run>"), loop: none("a loop-results artifact") },
    };
    const report = markdown(data);
    expect(report).toContain("no data: e2e-results");
    expect(report).toContain("One's e2e loop: no data: a loop-results artifact");
    expect(report).toContain("| packages/cli/test/b.test.ts | 60.0 |");
    const lines = summary(data).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Test bloat 2026-11-16, last 7 days: unit 2 files (+0), 4 cases (+0), 1 min (+0); e2e 0 files (+0), 0 cases (+0), 0 min (+0)");
    expect(lines[4]).toBe("Nightly matrix: 86/86 passed (2026-11-16); perf budgets: no data: e2e-perf-<run>; One loop: no data: a loop-results artifact");
  });
});
