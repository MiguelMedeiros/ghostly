import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Which events wake the merge train: merge-queue.yml's `bases` job condition, evaluated for each. A green batch lands
 * on `dev` as one squash merge per pull request, a push each by the queue app: those must not each start a run.
 */
const root = resolve(import.meta.dirname, "../../..");
const text = readFileSync(resolve(root, ".github/workflows/merge-queue.yml"), "utf8");
// The job's `if: >-` block: its indented lines, folded into one expression.
const condition = (text.match(/^ {2}bases:\n(?: {4}#.*\n| {4}name:.*\n)*? {4}if: >-\n((?: {6}.+\n)+)/m)?.[1] ?? "").replace(/\s+/g, " ").trim();

type Event = { event_name: string; event: Record<string, unknown> };
/** The operators the condition uses (==, !=, &&, ||, startsWith) behave as in JavaScript for these values. */
const wakes = ({ event_name, event }: Event) =>
  Boolean(new Function("github", "startsWith", `return (${condition.replace(/!=|==/g, (m) => `${m}=`)});`)({ event_name, event }, (s: string, p: string) => String(s).startsWith(p)));

const push = (type: string): Event => ({ event_name: "push", event: { sender: { type, login: type === "Bot" ? "ghostly-merge-queue-mm[bot]" : "MiguelMedeiros" } } });

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
    expect(wakes({ event_name: "workflow_run", event: { workflow_run: { event: "pull_request" } } })).toBe(true);
  });

  it("not for another label or CI on a push", () => {
    expect(wakes({ event_name: "pull_request_target", event: { label: { name: "kind:bug" } } })).toBe(false);
    expect(wakes({ event_name: "workflow_run", event: { workflow_run: { event: "push" } } })).toBe(false);
  });
});
