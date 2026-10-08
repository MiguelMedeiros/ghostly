import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI's concurrency, evaluated for the events that start it. A green batch lands on `dev` as one squash merge per pull
 * request, a push each, seconds apart: those must not each run the whole CI (about 18 jobs on the free plan's 20).
 */
const root = resolve(import.meta.dirname, "../../..");
const block = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8").match(/^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m);
const concurrency = { group: block?.[1] ?? "", "cancel-in-progress": block?.[2] ?? "" };

type Ctx = { workflow: string; event_name: string; ref: string; run_id: number; event: { pull_request?: { number: number } } };

/** The `${{ }}` expressions CI's concurrency uses (==, &&, ||, format) behave as in JavaScript for these strings. */
const evaluate = (text: string, github: Ctx) =>
  text.replace(/\$\{\{(.*?)\}\}/g, (_, expr: string) => {
    const format = (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_m, i) => String(a[Number(i)]));
    return String(new Function("github", "format", `return (${expr.replaceAll("==", "===")});`)(github, format));
  });

let run = 1000;
const push = (branch: string): Ctx => ({ workflow: "CI", event_name: "push", ref: `refs/heads/${branch}`, run_id: run++, event: {} });
const pr = (number: number): Ctx => ({ workflow: "CI", event_name: "pull_request", ref: `refs/pull/${number}/merge`, run_id: run++, event: { pull_request: { number } } });
const group = (c: Ctx) => evaluate(concurrency.group, c);
const cancels = (c: Ctx) => evaluate(concurrency["cancel-in-progress"], c) === "true";

describe("CI concurrency", () => {
  it("pushes to dev share one group that never cancels a run in progress: a batch's landing runs CI at most twice", () => {
    const landing = [push("dev"), push("dev"), push("dev"), push("dev"), push("dev")];
    expect(new Set(landing.map(group)).size).toBe(1);
    expect(landing.some(cancels)).toBe(false);
  });

  it("a push to any other branch gets a group of its own", () => {
    for (const branch of ["main", "epic/apps-1.2", "claude/security-auto-1"]) {
      const [a, b] = [push(branch), push(branch)];
      expect(group(a)).not.toBe(group(b));
      expect(group(a)).not.toBe(group(push("dev")));
      expect(cancels(a)).toBe(false);
    }
  });

  it("a new push to a pull request cancels the run it supersedes, and pull requests never share a group", () => {
    expect(group(pr(7))).toBe(group(pr(7)));
    expect(group(pr(7))).not.toBe(group(pr(8)));
    expect(group(pr(7))).not.toBe(group(push("dev")));
    expect(cancels(pr(7))).toBe(true);
  });

  it("merge queue entries group by their own ref", () => {
    const entry = (ref: string): Ctx => ({ workflow: "CI", event_name: "merge_group", ref, run_id: run++, event: {} });
    expect(group(entry("refs/heads/gh-readonly-queue/dev/pr-1-abc"))).toBe(group(entry("refs/heads/gh-readonly-queue/dev/pr-1-abc")));
    expect(group(entry("refs/heads/gh-readonly-queue/dev/pr-1-abc"))).not.toBe(group(entry("refs/heads/gh-readonly-queue/dev/pr-2-abc")));
  });
});
