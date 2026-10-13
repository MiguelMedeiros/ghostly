import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { missedWakes } from "../merge-train.mjs";

/**
 * Which events wake the merge train: merge-queue.yml's `bases` job condition, evaluated for each. A green batch lands
 * on `dev` as one squash merge per pull request, a push each by the queue app: those must not each start a run.
 */
const root = resolve(import.meta.dirname, "../../..");
const text = readFileSync(resolve(root, ".github/workflows/merge-queue.yml"), "utf8");
// The job's `if: >-` block: its indented lines, folded into one expression.
const condition = (text.match(/^ {2}bases:\n(?: {4}#.*\n| {4}name:.*\n)*? {4}if: >-\n((?: {6}.+\n)+)/m)?.[1] ?? "").replace(/\s+/g, " ").trim();

type Event = { event_name: string; event: Record<string, unknown> };
const repository = "MiguelMedeiros/ghostly";
/** The operators the condition uses (==, !=, &&, ||, startsWith) behave as in JavaScript for these values. */
const wakes = ({ event_name, event }: Event) =>
  Boolean(new Function("github", "startsWith", `return (${condition.replace(/!=|==/g, (m) => `${m}=`)});`)({ event_name, event, repository }, (s: string, p: string) => String(s).startsWith(p)));

const push = (type: string): Event => ({ event_name: "push", event: { sender: { type, login: type === "Bot" ? "ghostly-merge-queue-mm[bot]" : "MiguelMedeiros" } } });
const ci = (conclusion: string, event = "pull_request", from = repository): Event => ({
  event_name: "workflow_run",
  event: { workflow_run: { event, conclusion, head_repository: { full_name: from } } },
});

describe("merge-queue.yml wakes the train", () => {
  it("found the condition", () => expect(condition).toContain("github.event_name"));

  it("not for the train's own pushes (a batch landing one squash merge at a time)", () => {
    expect(wakes(push("Bot"))).toBe(false);
  });

  it("for a person's push to the base, the schedule, a manual run, a queue label and a pull request's CI", () => {
    expect(wakes(push("User"))).toBe(true);
    expect(wakes({ event_name: "schedule", event: {} })).toBe(true);
    expect(wakes({ event_name: "workflow_dispatch", event: {} })).toBe(true);
    expect(wakes({ event_name: "pull_request_target", event: { label: { name: "queue" } } })).toBe(true);
    expect(wakes({ event_name: "pull_request_target", event: { label: { name: "queue:priority" } } })).toBe(true);
    expect(wakes(ci("success"))).toBe(true);
    expect(wakes(ci("failure"))).toBe(true);
  });

  // A cancelled run reads as "pending" or "none" (ciState), never green or red: the run that replaced it wakes the
  // train when it ends. The train's own cancels of a boarded batch's pull requests would wake it once each.
  it("not for a pull request's CI run that was cancelled", () => {
    expect(wakes(ci("cancelled"))).toBe(false);
  });

  // The train never boards a fork's pull request. Anyone whose fork runs need no approval could push every few seconds,
  // and each run that ended would replace the tick waiting in the bases job's group.
  it("not for a fork's pull request CI, green or red", () => {
    expect(wakes(ci("success", "pull_request", "someone/ghostly"))).toBe(false);
    expect(wakes(ci("failure", "pull_request", "someone/ghostly"))).toBe(false);
  });

  it("not for the labels the train puts on a pull request it drops from the line", () => {
    expect(wakes({ event_name: "pull_request_target", event: { label: { name: "queue:conflict" } } })).toBe(false);
    expect(wakes({ event_name: "pull_request_target", event: { label: { name: "queue:failed" } } })).toBe(false);
  });

  it("not for another label or CI on a push", () => {
    expect(wakes({ event_name: "pull_request_target", event: { label: { name: "kind:bug" } } })).toBe(false);
    expect(wakes({ event_name: "pull_request_target", event: { label: { name: "queued" } } })).toBe(false);
    expect(wakes(ci("success", "push"))).toBe(false);
  });
});

// GitHub cancels the run waiting in a concurrency group when a newer one joins it. On the whole workflow, every run
// joined: one whose jobs were all skipped (the train's own `queue:conflict`, a push's CI, its own landing pushes)
// replaced a batch's CI-end wake, and the train waited for the schedule.
describe("merge-queue.yml waits in line", () => {
  const job = (name: string) => text.match(new RegExp(`^ {2}${name}:\n((?: {4}.*\n|\n)+)`, "m"))?.[1] ?? "";

  it("only for runs that pass the bases job's condition: the group is that job's, not the workflow's", () => {
    expect(text).not.toMatch(/^concurrency:/m);
    expect(job("bases")).toMatch(/^ {4}concurrency:\n {6}group: merge-queue-bases\n {6}cancel-in-progress: false$/m);
  });

  it("and a run woken by CI is named after its head, so the run that replaced it serves it", async () => {
    const expr = (text.match(/^run-name: >-\n((?: {2}.+\n)+)/m)?.[1] ?? "").replace(/\s+/g, " ").trim().replace(/^\$\{\{(.*)\}\}$/, "$1");
    const name = (github: object) =>
      new Function("github", "format", `return (${expr.replace(/!=|==/g, (m) => `${m}=`)});`)(github, (f: string, ...v: string[]) => f.replace(/\{(\d)\}/g, (_, i) => v[Number(i)]));
    const sha = "f".repeat(40);
    expect(name({ event_name: "workflow_run", event: { workflow_run: { head_sha: sha } } })).toBe(`Merge queue: CI ended on ${sha}`);
    const runs = [{ id: 2, conclusion: null }, { id: 1, conclusion: "cancelled", display_title: name({ event_name: "workflow_run", event: { workflow_run: { head_sha: sha } } }) }];
    expect(await missedWakes(runs, 2, async () => [])).toEqual([sha]);
    // missedWakes tells a run replaced while it waited from one served by its bases job's name.
    expect(job("bases")).toMatch(/^ {4}name: Bases with a train$/m);
    expect(name({ event_name: "pull_request_target", event: { pull_request: { title: "fix: x" } } })).toBe("fix: x");
    expect(name({ event_name: "push", ref_name: "dev", event: {} })).toBe("Merge queue: push to dev");
    expect(name({ event_name: "schedule", event: {} })).toBe("Merge queue");
    expect(text).toMatch(/--list-bases --woken "\$WOKEN" --run-id "\$RUN_ID"/);
  });
});
