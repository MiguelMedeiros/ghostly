import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_WAIT, missedWakes, wakeIn } from "../merge-train.mjs";

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
const label = (name: string, action = "labeled"): Event => ({ event_name: "pull_request_target", event: { action, label: { name } } });
const ci = (conclusion: string, event = "pull_request", from = repository, branch = "fix"): Event => ({
  event_name: "workflow_run",
  event: { workflow_run: { event, conclusion, head_branch: branch, head_repository: { full_name: from } } },
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
    expect(wakes(label("queue"))).toBe(true);
    expect(wakes(label("queue:priority"))).toBe(true);
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
    expect(wakes(label("queue:conflict"))).toBe(false);
    expect(wakes(label("queue:failed"))).toBe(false);
  });

  it("not for another label, nor CI on a push to a branch that is no base", () => {
    expect(wakes(label("kind:bug"))).toBe(false);
    expect(wakes(label("queued"))).toBe(false);
    for (const branch of ["main", "claude/security-auto-1", "fix", "batch/dev-1", "release/1.2", "devx"]) expect(wakes(ci("success", "push", repository, branch)), branch).toBe(false);
  });

  // A red batch or lone pull request is held while CI Success on its base's tip still runs: that run ending is the only
  // event that can move it, so it wakes the train (the script lists the base only while the commit is its tip).
  it("for CI on a push to dev or an epic, green or red, and not when it was cancelled", () => {
    for (const branch of ["dev", "epic/apps-1.2"]) {
      expect(wakes(ci("success", "push", repository, branch)), branch).toBe(true);
      expect(wakes(ci("failure", "push", repository, branch)), branch).toBe(true);
      expect(wakes(ci("cancelled", "push", repository, branch)), branch).toBe(false);
    }
    // The trigger is CI's completed runs, from any branch: the condition above is what picks.
    expect(text).toMatch(/^ {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]$/m);
  });

  // A held pull request waits in line and boards once `queue:hold` comes off: nothing else may wake the train then, and
  // GitHub runs the schedule only every 10 to 30 minutes.
  it("for `queue:hold` taken off, and for no other label taken off", () => {
    expect(wakes(label("queue:hold", "unlabeled"))).toBe(true);
    // Put on hold: the train reads the labels again at its next run, and the hold only stops what it would do.
    expect(wakes(label("queue:hold"))).toBe(false);
    for (const name of ["queue", "queue:priority", "queue:conflict", "queue:failed", "kind:bug"]) expect(wakes(label(name, "unlabeled")), name).toBe(false);
    expect(text).toMatch(/^ {2}pull_request_target:\n {4}types: \[labeled, unlabeled\]$/m);
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

  // Two wakes close together (dev's CI and a batch's CI ending a second apart) never run two trains on one base: the
  // second waits behind the first, and a third replaces it.
  it("and one train per base at a time", () => {
    expect(job("train")).toMatch(/^ {4}concurrency:\n {6}group: merge-train-\$\{\{ matrix\.base \}\}\n {6}cancel-in-progress: false$/m);
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

// GitHub runs a schedule only loosely (its `*/5` 10 to 30 minutes apart): a batch held for company, with no other event,
// left up to ~45 minutes after the oldest could board instead of 15.
describe("merge-queue.yml wakes the train when a held batch leaves", () => {
  const job = (name: string) => text.match(new RegExp(`^ {2}${name}:\n((?: {4}.*\n|\n)+)`, "m"))?.[1] ?? "";

  // The schedule is only a backstop: events move the train, and the `wake` job serves a held batch's deadline.
  it("and otherwise every 15 minutes, as a backstop", () => {
    expect(text).toMatch(/^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "\*\/15 \* \* \* \*"$/m);
  });

  it("from the train job's wake time, in a group of its own where the newest wake replaces the one sleeping", () => {
    expect(job("train")).toMatch(/^ {4}outputs:\n {6}wake_in: \$\{\{ steps\.train\.outputs\.wake_in \}\}$/m);
    expect(job("train")).toMatch(/^ {6}- name: Run the train\n {8}id: train$/m);
    const wake = job("wake");
    expect(wake).toMatch(/^ {4}needs: train$/m);
    // A matrix leg that failed on another base does not skip the wake.
    expect(wake).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && needs\.train\.outputs\.wake_in != '' \}\}$/m);
    expect(wake).toMatch(/^ {4}concurrency:\n {6}group: merge-queue-wake\n {6}cancel-in-progress: true$/m);
    // The workflow's own token may start a run with workflow_dispatch, and needs nothing else.
    expect(wake).toMatch(/^ {4}permissions:\n {6}actions: write$/m);
    expect(wake).toMatch(/^ {10}sleep "\$WAKE_IN"$/m);
    expect(wake).toMatch(/^ {12}gh workflow run merge-queue\.yml --repo "\$GITHUB_REPOSITORY" && exit 0$/m);
  });

  // The wake step's own script, run with a fake `gh` that fails its first `fails` calls and a `sleep` that only logs.
  const runWake = (fails: number) => {
    const script = job("wake").match(/^ {8}run: \|\n((?: {10}.*\n)+)/m)![1].replace(/^ {10}/gm, "");
    const bin = mkdtempSync(join(tmpdir(), "wake-"));
    writeFileSync(join(bin, "sleep"), `#!/bin/sh\necho "sleep $*" >> "${bin}/log"\n`, { mode: 0o755 });
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "gh $*" >> "${bin}/log"\nn=$(grep -c '^gh ' "${bin}/log")\n[ "$n" -gt ${fails} ] && exit 0\necho "HTTP 503: No server is currently available" >&2; exit 1\n`,
      { mode: 0o755 },
    );
    const { status } = spawnSync("bash", ["-e", "-c", script], { env: { PATH: `${bin}:${process.env.PATH}`, WAKE_IN: "120", GITHUB_REPOSITORY: repository }, encoding: "utf8" });
    const log = readFileSync(join(bin, "log"), "utf8").trim().split("\n");
    rmSync(bin, { recursive: true });
    return { status, log };
  };
  const start = "gh workflow run merge-queue.yml --repo MiguelMedeiros/ghostly";

  // A 503 from GitHub on the one dispatch (2026-11-25, run 45647790003) left the held batch to the schedule.
  it("and starts it again when GitHub fails the first tries", () => {
    const { status, log } = runWake(2);
    expect(status).toBe(0);
    expect(log[0]).toBe("sleep 120");
    expect(log.filter((l) => l === start)).toHaveLength(3);
  });

  it("and gives up, red, after a few tries", () => {
    const { status, log } = runWake(Infinity);
    expect(status).not.toBe(0);
    expect(log.filter((l) => l === start)).toHaveLength(4);
  });

  it("with time to sleep through the longest hold and every try", () => {
    const minutes = Number(job("wake").match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
    const pauses = runWake(Infinity).log.slice(1).filter((l) => l.startsWith("sleep ")).reduce((s, l) => s + Number(l.slice(6)), 0);
    expect(minutes * 60).toBeGreaterThan(wakeIn(MAX_WAIT, 0)! + pauses);
  });
});
