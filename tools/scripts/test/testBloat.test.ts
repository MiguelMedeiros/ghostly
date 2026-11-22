import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collect, e2eFiles, flakes, growth, main, markdown, mockOnly, neverFailedSlow, openCache, pairs, parseArgs, parseMatrix, parsePerf,
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
  it("takes the window, the output file, one output form, the cache folder and the call budget", () => {
    expect(parseArgs([])).toEqual({ since: 7, out: null, json: false, summary: false, cache: null, maxCalls: 200 });
    expect(parseArgs(["--since", "14d", "--out", "r.md", "--summary", "--cache", "/tmp/c", "--max-calls", "50"])).toEqual({ since: 14, out: "r.md", json: false, summary: true, cache: "/tmp/c", maxCalls: 50 });
  });

  it.each([[["--since", "7"]], [["--since", "0d"]], [["--json", "--summary"]], [["--out"]], [["--weak"]], [["--max-calls", "0"]], [["--max-calls"]], [["--cache"]]])("refuses %j", (args) => {
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

describe("reading GitHub under a call budget, a rate guard and a cache (a fake GitHub, no network)", () => {
  const NOW = Date.parse("2026-11-16T09:00:00Z");
  const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
  const artifact = (id: number, name: string, run: number, days: number, branch = "dev") => ({
    id, name, created_at: ago(days), expired: false, size_in_bytes: 1000, workflow_run: { id: run, head_branch: branch, head_repository_id: 1, repository_id: 1 },
  });
  // Dev run 11 (2 days old, 2 shards) and dev run 10 (9 days, the growth baseline); run 12 failed its packages shard 2.
  const ROUTES: Record<string, unknown> = {
    "actions/artifacts?name=packages-test-reports-1": { total_count: 3, artifacts: [artifact(111, "packages-test-reports-1", 11, 2), artifact(121, "packages-test-reports-1", 12, 3, "issue-1"), artifact(101, "packages-test-reports-1", 10, 9)] },
    "actions/runs/11/artifacts": { artifacts: [artifact(111, "packages-test-reports-1", 11, 2), artifact(112, "packages-test-reports-2", 11, 2)] },
    "actions/runs/10/artifacts": { artifacts: [artifact(101, "packages-test-reports-1", 10, 9)] },
    "actions/runs/12/artifacts": { artifacts: [artifact(121, "packages-test-reports-1", 12, 3, "issue-1"), artifact(122, "packages-test-reports-2", 12, 3, "issue-1")] },
    "actions/runs/12/jobs": { jobs: [{ name: "Frontend tests (packages 1/2)", conclusion: "success" }, { name: "Frontend tests (packages 2/2)", conclusion: "failure" }] },
    "actions/workflows/ci.yml/runs": { total_count: 1, workflow_runs: [{ id: 12, created_at: ago(3) }] },
    "actions/artifacts?name=e2e-results": { total_count: 3, artifacts: [artifact(201, "e2e-results", 21, 1), artifact(202, "e2e-results", 22, 3), artifact(203, "e2e-results", 23, 10)] },
    "actions/artifacts?name=playwright-report-matrix": { total_count: 1, artifacts: [artifact(301, "playwright-report-matrix", 31, 1)] },
    "actions/workflows/e2e-perf.yml/runs": { total_count: 0, workflow_runs: [] },
  };
  const ZIPS: Record<string, Record<string, string>> = {
    111: { "core.json": vitestReport([["sends", "passed", 1500]]) },
    112: { "cli.json": vitestReport([["x", "passed", 1]], "packages/cli/test/b.test.ts", 60) },
    101: { "core.json": vitestReport([["sends", "passed", 900]]) },
    122: { "cli.json": vitestReport([["x", "failed", 1]], "packages/cli/test/b.test.ts", 60) },
    201: { "e2e-results.json": playwrightReport }, 202: { "e2e-results.json": playwrightReport }, 203: { "e2e-results.json": playwrightReport },
    301: { "matrix-summary/results.json": JSON.stringify({ rows: [{ status: "passed" }, { status: "passed" }] }) },
  };
  /** A fake fetch: every api.github.com request counted, the zips redirected to a blob host counted apart. */
  const fakeGitHub = (remaining = (_call: number) => 4000) => {
    const calls: string[] = [], blobs: string[] = [];
    const fetch = async (url: string) => {
      const u = new URL(url);
      if (u.host === "blob.test") { blobs.push(url); return new Response(JSON.stringify(ZIPS[u.pathname.slice(1)])); }
      calls.push(url);
      const headers = { "x-ratelimit-remaining": String(remaining(calls.length)) };
      if (u.pathname === "/rate_limit") return Response.json({ resources: { core: { remaining: remaining(calls.length) } } }, { headers });
      const path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\//, "");
      const zip = /^actions\/artifacts\/(\d+)\/zip$/.exec(path);
      if (zip) return new Response(null, { status: 302, headers: { ...headers, location: `https://blob.test/${zip[1]}` } });
      const body = ROUTES[u.searchParams.get("name") ? `${path}?name=${u.searchParams.get("name")}` : path];
      return body ? Response.json(body, { headers }) : new Response("{}", { status: 404, headers });
    };
    return { fetch, calls, blobs };
  };
  const unzip = (zip: Buffer, pattern: RegExp) => Object.entries(JSON.parse(zip.toString()) as Record<string, string>).filter(([p]) => pattern.test(p)).map(([, text]) => text);
  const dirs: string[] = [];
  const cacheDir = () => { const dir = mkdtempSync(join(tmpdir(), "test-bloat-cache-")); dirs.push(dir); return dir; };
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const run = (gh: ReturnType<typeof fakeGitHub>, cache: string, maxCalls = 200) =>
    collect({ since: 7, cache, maxCalls }, { token: "t", fetch: gh.fetch, unzip, now: NOW, weak: async () => [], units: () => [] });

  it("reads everything within the budget and counts the API calls and the blob downloads apart", async () => {
    const gh = fakeGitHub();
    const data = await run(gh, cacheDir());
    expect(gh.calls).toHaveLength(18);
    expect(data.calls).toMatchObject({ calls: 18, blobs: 8, downloads: 8, hits: 0, stop: null, parts: { start: 1, unit: 6, e2e: 4, nightly: 3, history: 4 } });
    expect(data.partial).toEqual({});
    expect(data.window).toMatchObject({ unitNow: { id: 11 }, unitThen: { id: 10 }, failedRuns: 1, failedShards: 1, e2eRuns: 3 });
    expect(data.neverFailed.unit).toEqual([{ key: "packages/core/test/a.test.ts › sends", ms: 1500 }]);
    expect(data.scores.matrix[0].text).toBe("2/2 passed, 0 failed, 0 skipped");
  });

  it("stops at the call budget, still writes the report, and marks each section it cut", async () => {
    const gh = fakeGitHub();
    const data = await run(gh, cacheDir(), 5);
    expect(gh.calls).toHaveLength(5);
    expect(data.calls).toMatchObject({ calls: 5, stop: "budget of 5 calls reached" });
    expect(data.slowest.unit[0]).toMatchObject({ path: "packages/cli/test/b.test.ts", seconds: 60 });
    expect(data.partial.unit).toBe("partial: budget of 5 calls reached; read 1 of 2 dev runs' packages reports");
    expect(data.partial.e2e).toBe("partial: budget of 5 calls reached; read 0 of the e2e-results runs of the week");
    expect(Object.keys(data.partial).sort()).toEqual(["e2e", "history", "historyE2e", "nightly", "unit"]);
    const report = markdown(data);
    expect(report).toContain("**Partial:** reading stopped early (budget of 5 calls reached)");
    expect(report).toContain("## Flakes of the week\n\npartial: budget of 5 calls reached; read 0 of the e2e-results runs of the week");
    expect(summary(data).split("\n")[0]).toMatch(/; partial \(budget of 5 calls reached\), see the report$/);
  });

  it("stops reading once a response says fewer than 1000 requests are left", async () => {
    const gh = fakeGitHub((call) => (call >= 3 ? 999 : 4000));
    const data = await run(gh, cacheDir());
    expect(gh.calls).toHaveLength(3);
    expect(gh.blobs).toHaveLength(0);
    expect(data.calls.stop).toBe("x-ratelimit-remaining fell to 999, under 1000");
    expect(data.partial.unit).toBe("partial: x-ratelimit-remaining fell to 999, under 1000; read 0 of 2 dev runs' packages reports");
  });

  it("does not start with fewer than 1000 requests left: one call, exit 1", async () => {
    const gh = fakeGitHub(() => 999);
    expect(await run(gh, cacheDir())).toMatchObject({ refused: expect.stringContaining("has 999 GitHub requests left") });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--cache", cacheDir()], { token: "t", fetch: gh.fetch, unzip, now: NOW })).toBe(1);
    expect(error.mock.calls[0][0]).toContain("starts only with 1000 or more");
    error.mockRestore();
    expect(gh.calls).toHaveLength(2);
  });

  it("reads the same artifacts from the cache on the next run: no downloads, only the listings' first pages", async () => {
    const dir = cacheDir();
    const first = await run(fakeGitHub(), dir);
    const gh = fakeGitHub();
    const again = await run(gh, dir);
    expect(again.calls).toMatchObject({ downloads: 0, blobs: 0, hits: 8 });
    expect(gh.blobs).toHaveLength(0);
    expect(gh.calls.filter((url) => url.includes("/zip"))).toHaveLength(0);
    expect(gh.calls).toHaveLength(6); // the rate limit and 5 listings, each down to what the cache holds
    expect({ ...again, seconds: 0, calls: null }).toEqual({ ...first, seconds: 0, calls: null });
  });

  it("prunes cache entries older than the 14 days CI keeps the artifacts", () => {
    const dir = cacheDir();
    openCache(dir, NOW);
    for (const [id, days] of [[1, 15], [2, 13]]) {
      writeFileSync(join(dir, "artifacts", `${id}.json`), "{}");
      utimesSync(join(dir, "artifacts", `${id}.json`), new Date(NOW), new Date(Date.parse(ago(days))));
    }
    openCache(dir, NOW);
    expect([existsSync(join(dir, "artifacts", "1.json")), existsSync(join(dir, "artifacts", "2.json"))]).toEqual([false, true]);
  });
});
