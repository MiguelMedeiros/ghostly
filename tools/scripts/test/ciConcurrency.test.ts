import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The concurrency of the workflows that run on every push to `dev`, evaluated for the events that start them. A green
 * batch lands on `dev` as one squash merge per pull request, a push each, seconds apart: those must not each run the
 * whole CI (about 18 jobs on the free plan's 20) and the dependency scan.
 */
const root = resolve(import.meta.dirname, "../../..");

type Ctx = { workflow: string; event_name: string; ref: string; run_id: number; event: { pull_request?: { number: number } } };

/** The `${{ }}` expressions these use (==, &&, ||, format) behave as in JavaScript for these strings. */
const evaluate = (text: string, github: Ctx) =>
  text.replace(/\$\{\{(.*?)\}\}/g, (_, expr: string) => {
    const format = (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_m, i) => String(a[Number(i)]));
    return String(new Function("github", "format", `return (${expr.replaceAll("==", "===")});`)(github, format));
  });

describe.each([
  ["CI", "ci.yml"],
  ["Security", "security.yml"],
])("%s concurrency", (workflow, file) => {
  const block = readFileSync(resolve(root, ".github/workflows", file), "utf8").match(/^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m);
  let run = 1000;
  const ctx = (event_name: string, ref: string, event: Ctx["event"] = {}): Ctx => ({ workflow, event_name, ref, run_id: run++, event });
  const push = (branch: string) => ctx("push", `refs/heads/${branch}`);
  const pr = (number: number) => ctx("pull_request", `refs/pull/${number}/merge`, { pull_request: { number } });
  const group = (c: Ctx) => evaluate(block?.[1] ?? "", c);
  const cancels = (c: Ctx) => evaluate(block?.[2] ?? "", c) === "true";

  it("pushes to dev share one group that never cancels a run in progress: a batch's landing runs it at most twice", () => {
    const landing = [push("dev"), push("dev"), push("dev"), push("dev"), push("dev")];
    expect(new Set(landing.map(group)).size).toBe(1);
    expect(landing.some(cancels)).toBe(false);
  });

  it("a push to any other branch, the morning run and a manual run get a group of their own", () => {
    for (const c of [push("main"), push("epic/apps-1.2"), push("claude/security-auto-1"), ctx("schedule", "refs/heads/dev"), ctx("workflow_dispatch", "refs/heads/dev")]) {
      const again = { ...c, run_id: run++ };
      expect(group(c)).not.toBe(group(again));
      expect(group(c)).not.toBe(group(push("dev")));
      expect(cancels(c)).toBe(false);
    }
  });

  it("a new push to a pull request cancels the run it supersedes, and pull requests never share a group", () => {
    expect(group(pr(7))).toBe(group(pr(7)));
    expect(group(pr(7))).not.toBe(group(pr(8)));
    expect(group(pr(7))).not.toBe(group(push("dev")));
    expect(cancels(pr(7))).toBe(true);
  });
});
