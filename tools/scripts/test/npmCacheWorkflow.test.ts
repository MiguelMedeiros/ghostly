import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// guards: #8399

/**
 * Who saves the npm cache. The repository's Actions cache holds 10 GB, and GitHub evicts by last use. A pull request
 * restores dev's entries but never another pull request's, so `actions/setup-node` with `cache: "npm"`, which saves on
 * any miss, made every pull request save its own copy of the same cache (about 350 MB on ARM64, 235 MB on x64, 206 MB
 * on macOS) whenever dev held none for the lock file: 6.5 GB of the 10.3 the cache once held, which pushed dev's costly
 * Cargo caches out. And a push to dev whose tree a pull request already tested runs no Node job, so dev rarely saved
 * one: never the ARM64 key. Now every job restores (.github/actions/node-npm), and one job on a push to dev saves.
 */
const root = resolve(import.meta.dirname, "../../..");
const read = (file: string) => (existsSync(resolve(root, file)) ? readFileSync(resolve(root, file), "utf8") : "");
/** The workflows every pull request runs: CI, and the ones it calls. */
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/desktop-macos.yml"];
const ACTION = ".github/actions/node-npm/action.yml";

/** A workflow's jobs by id, each its text up to the next job. */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const parts = body.split(/^(?= {2}[\w-]+:\n)/m).filter((p) => /^ {2}[\w-]+:\n/.test(p));
  return new Map(parts.map((p) => [p.match(/^ {2}([\w-]+):/)?.[1] ?? "", p]));
}

/** A job's (or a composite action's) steps, each its text up to the next step. */
const steps = (text: string) => text.split(/^(?= *- name: )/m).filter((s) => /^ *- name: /.test(s));
const field = (step: string, name: string) => step.match(new RegExp(`^ +${name}: (.+)$`, "m"))?.[1]?.trim();

type Ctx = { event_name: string; ref: string };
/** The `${{ }}` expressions these use (==, &&, ||) behave as in JavaScript for these strings. */
const evaluate = (expr: string, github: Ctx) =>
  Boolean(new Function("github", `return (${expr.replace(/^\$\{\{|\}\}$/g, "").replaceAll("==", "===")});`)(github));
const EVENTS: Ctx[] = [
  { event_name: "pull_request", ref: "refs/pull/7/merge" },
  { event_name: "merge_group", ref: "refs/heads/gh-readonly-queue/dev/pr-7-abc" },
  { event_name: "push", ref: "refs/heads/epic/x" },
  { event_name: "push", ref: "refs/heads/main" },
  { event_name: "schedule", ref: "refs/heads/dev" },
  { event_name: "workflow_dispatch", ref: "refs/heads/dev" },
];
const PUSH_TO_DEV: Ctx = { event_name: "push", ref: "refs/heads/dev" };

describe.each(WORKFLOWS)("%s", (file) => {
  const all = jobs(read(file));

  it("never lets setup-node cache: its post step saves the npm cache on a miss, a pull request's run too", () => {
    for (const [id, job] of all)
      for (const step of steps(job).filter((s) => field(s, "uses")?.startsWith("actions/setup-node@"))) {
        expect([id, field(step, "cache")]).toEqual([id, undefined]);
      }
  });

  it("every job that installs from the lock file restores the npm cache first, and only restores it", () => {
    for (const [id, job] of all) {
      const list = steps(job);
      const install = list.findIndex((s) => /^ +run: npm ci$/m.test(s));
      if (install < 0 || id === "npm-cache") continue;
      const setup = list.findIndex((s) => field(s, "uses") === "./.github/actions/node-npm");
      expect([id, setup >= 0 && setup < install]).toEqual([id, true]);
    }
  });

  it("no other job saves anything under ~/.npm", () => {
    for (const [id, job] of all) {
      if (id === "npm-cache") continue;
      for (const step of steps(job).filter((s) => /^ +uses: actions\/cache(\/save)?@/m.test(s))) expect([id, step]).not.toEqual([id, expect.stringContaining(".npm")]);
    }
  });
});

describe("the action every job sets Node.js up with", () => {
  const action = read(ACTION);
  const list = steps(action);

  it("installs Node.js without setup-node's own cache", () => {
    const setup = list.find((s) => field(s, "uses")?.startsWith("actions/setup-node@")) ?? "";
    expect(field(setup, "cache")).toBeUndefined();
    expect(field(setup, "package-manager-cache")).toBe("false");
  });

  it("restores and never saves", () => {
    expect(list.map((s) => field(s, "uses")?.split("@")[0]).filter(Boolean)).toEqual(["actions/setup-node", "actions/cache/restore"]);
  });
});

describe("the job that saves it", () => {
  const ci = jobs(read(".github/workflows/ci.yml"));
  const job = ci.get("npm-cache") ?? "";
  const list = steps(job);
  const action = steps(read(ACTION));
  const restore = action.find((s) => field(s, "uses")?.startsWith("actions/cache/restore@")) ?? "";

  it("runs on a push to dev only: pull requests, the merge queue, epics and the nightly runs restore what dev saved", () => {
    const condition = job.match(/^ {4}if: (.+)$/m)?.[1] ?? "false";
    expect(evaluate(condition, PUSH_TO_DEV)).toBe(true);
    for (const c of EVENTS) expect([c, evaluate(condition, c)]).toEqual([c, false]);
  });

  it("does not wait for the plan: a push to dev whose tree a pull request tested runs no Node job, yet needs the keys", () => {
    expect(job).not.toMatch(/^ {4}needs:/m);
  });

  it("saves every key a pull request's job restores: x64, ARM64 and macOS for the app, x64 for the site", () => {
    const runners = [...job.matchAll(/^ {10}- runner: (\S+)\n {12}lock: (\S+)$/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
    expect(runners).toEqual(["macos-15 package-lock.json", "ubuntu-24.04 apps/website/package-lock.json", "ubuntu-24.04 package-lock.json", "ubuntu-24.04-arm package-lock.json"]);
    const used = new Set<string>();
    for (const file of WORKFLOWS)
      for (const [, j] of jobs(read(file))) {
        const runsOn = j.match(/^ {4}runs-on: (\S+)$/m)?.[1];
        for (const s of steps(j).filter((x) => field(x, "uses") === "./.github/actions/node-npm")) used.add(`${runsOn} ${field(s, "lock") ?? "package-lock.json"}`);
      }
    expect([...used].filter((u) => !runners.includes(u))).toEqual([]);
  });

  it("looks the key up before it installs anything, and saves the exact key and path the action restores", () => {
    const lookup = list.find((s) => field(s, "uses")?.startsWith("actions/cache/restore@")) ?? "";
    const save = list.find((s) => field(s, "uses")?.startsWith("actions/cache/save@")) ?? "";
    expect(field(lookup, "lookup-only")).toBe("true");
    expect(field(lookup, "path")).toBe(field(restore, "path"));
    expect(field(save, "path")).toBe(field(restore, "path"));
    const key = (s: string) => field(s, "key")?.replaceAll("inputs.lock", "matrix.lock");
    expect(key(lookup)).toBe(key(restore));
    expect(field(save, "key")).toBe("${{ steps.lookup.outputs.cache-primary-key }}");
    for (const s of list.slice(list.indexOf(lookup) + 1)) expect(field(s, "if")).toContain("steps.lookup.outputs.cache-hit != 'true'");
  });
});
