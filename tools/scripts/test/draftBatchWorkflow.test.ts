import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// guards: #8394

/**
 * The long pull request lanes outside CI (an Android build and its emulator, the Desktop video check on Linux and
 * Windows) run on a ready pull request, not on a draft, which gets CI's fast tier only, and not on a merge train batch
 * (batch/<base>-<stamp>, from this repository): each pull request in a batch ran them on its own pull request, and the
 * train lands each of them as its own merge, never the batch. A `draft` job reads the draft state from the API (#742),
 * and the lane's first job needs it. The `if:` expressions are evaluated here for each kind of run.
 */
const root = resolve(import.meta.dirname, "../../..");

/** One job's text, up to the next job. */
function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job "${name}"`);
  const next = text.slice(start + 1).search(/\n {2}[\w-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next + 1);
}

type Run = { event_name: string; head_ref?: string; head_repo?: string; draft?: string };

/**
 * A job's `if:` as GitHub reads it, for these operators and functions (startsWith ignores case, as GitHub's does). An
 * `if:` with no status function gets GitHub's `success() &&` in front, and success() is false once any job before it,
 * however far back, did not succeed: a skipped draft job skips every job after it that has no `!cancelled()`.
 */
function evaluate(expr: string, run: Run, draftOutput = "", needsResults: Record<string, string> = {}, before = true): boolean {
  let body = expr.replace(/^\$\{\{(.*)\}\}$/, "$1").replace(/([!=])=/g, "$1==");
  if (!/\b(success|failure|cancelled|always)\(/.test(body)) body = `success() && (${body})`;
  const github = {
    event_name: run.event_name,
    head_ref: run.head_ref ?? "",
    repository: "o/ghostly",
    event: { pull_request: { head: { repo: { full_name: run.head_repo ?? "" } } } },
  };
  const needs: Record<string, { outputs?: Record<string, string>; result?: string }> = { draft: { outputs: { draft: draftOutput } } };
  for (const [name, result] of Object.entries(needsResults)) needs[name] = { ...needs[name], result };
  const startsWith = (s: string, p: string) => s.toLowerCase().startsWith(p.toLowerCase());
  return Boolean(
    new Function("github", "needs", "startsWith", "cancelled", "success", `return (${body});`)(github, needs, startsWith, () => false, () => before),
  );
}

describe.each([
  ["android-e2e.yml", "apk", "e2e"],
  ["android-native.yml", "apk", "emulator"],
  ["desktop-media.yml", "stream", null],
])("%s", (file, gated, after) => {
  const text = readFileSync(resolve(root, ".github/workflows", file), "utf8");
  const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:\n"));
  const ifOf = (name: string) => job(text, name).match(/^ {4}if: (.+)$/m)?.[1] ?? "true";

  /** Whether the lane's first job runs: the draft job first (skipped leaves its output empty), then the gated one. */
  const builds = (run: Run) => {
    const draftRuns = evaluate(ifOf("draft"), run);
    return evaluate(ifOf(gated), run, draftRuns ? (run.draft ?? "false") : "");
  };

  /** Whether the job after the first one runs, given how the first one ended when it ran. */
  const runsAfter = (run: Run, gatedResult = "success") => {
    if (!after) throw new Error(`${file} has no job after ${gated}`);
    const draftRuns = evaluate(ifOf("draft"), run);
    const result = builds(run) ? gatedResult : "skipped";
    const draft = draftRuns ? "success" : "skipped";
    return evaluate(ifOf(after), run, draftRuns ? (run.draft ?? "false") : "", { draft, [gated]: result }, draft === "success" && result === "success");
  };

  it("runs again when a pull request leaves draft", () => {
    expect(on).toContain("  pull_request:\n    # ready_for_review: a draft skips this (see the draft job below); leaving draft ");
    expect(on).toContain("    types: [opened, synchronize, reopened, ready_for_review]\n");
  });

  it("its first job needs the draft job, and the rest need that one", () => {
    expect(job(text, gated)).toContain("    needs: draft\n");
    if (after) expect(job(text, after)).toContain(`    needs: ${gated}\n`);
    expect(job(text, "draft")).toContain("draft=$(gh api \"$PR_URL\" --jq .draft) || draft=unknown");
  });

  it("a ready pull request runs it; a draft does not; a draft state that cannot be read runs it", () => {
    const pr = { event_name: "pull_request", head_ref: "issue-1-a-fix", head_repo: "o/ghostly" };
    expect(builds({ ...pr, draft: "false" })).toBe(true);
    expect(builds({ ...pr, draft: "true" })).toBe(false);
    expect(builds({ ...pr, draft: "unknown" })).toBe(true);
  });

  it("a merge train batch runs nothing, the draft job included", () => {
    const batch = { event_name: "pull_request", head_ref: "batch/dev-20261113-0912", head_repo: "o/ghostly", draft: "false" };
    expect(evaluate(ifOf("draft"), batch)).toBe(false);
    expect(builds(batch)).toBe(false);
    expect(builds({ ...batch, head_ref: "batch/epic-apps-1.2-20261113-0912" })).toBe(false);
  });

  it("a fork's pull request runs it whatever its branch is called, and so does a branch that only looks like a batch's", () => {
    expect(builds({ event_name: "pull_request", head_ref: "batch/dev-20261113-0912", head_repo: "someone/ghostly" })).toBe(true);
    expect(builds({ event_name: "pull_request", head_ref: "fix/batch/dev-1", head_repo: "o/ghostly" })).toBe(true);
  });

  it("a run by hand or on its schedule runs it, with no draft job", () => {
    for (const event_name of ["workflow_dispatch", "schedule"]) {
      expect(evaluate(ifOf("draft"), { event_name }), event_name).toBe(false);
      expect(builds({ event_name }), event_name).toBe(true);
    }
  });

  it.runIf(after)("the job after it runs when it built, on a run by hand, on its schedule and on a ready pull request", () => {
    for (const event_name of ["workflow_dispatch", "schedule"]) expect(runsAfter({ event_name }), event_name).toBe(true);
    const pr = { event_name: "pull_request", head_ref: "issue-1-a-fix", head_repo: "o/ghostly" };
    expect(runsAfter({ ...pr, draft: "false" })).toBe(true);
    expect(runsAfter({ ...pr, draft: "true" })).toBe(false);
    expect(runsAfter({ ...pr, head_ref: "batch/dev-20261113-0912", draft: "false" })).toBe(false);
    expect(runsAfter({ event_name: "schedule" }, "failure")).toBe(false);
  });
});
