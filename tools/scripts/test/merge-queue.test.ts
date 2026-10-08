import { describe, expect, it } from "vitest";
import { ciState, conflictComment, conflictNoted, decide } from "../merge-queue.mjs";

type Pr = { number: number; branch?: string; sha?: string; state: string; ci?: string };
const pr = ({ number, branch = `fix/${number}`, sha = `sha${number}`, state, ci = "success" }: Pr) => ({ number, branch, sha, state, ci });
const run = (name: string, status: string, conclusion: string | null = null, started_at = "2026-10-07T10:00:00Z", id = 1) => ({ name, status, conclusion, started_at, id });

describe("the merge queue's choice", () => {
  it("does nothing when no armed pull request is behind", () => {
    expect(decide([]).update).toBeNull();
    expect(decide([pr({ number: 1, state: "blocked", ci: "pending" })]).update).toBeNull();
  });

  it("updates the oldest behind pull request when the head is idle", () => {
    const { update, log } = decide([pr({ number: 9, state: "behind" }), pr({ number: 4, state: "behind", ci: "pending" }), pr({ number: 7, state: "behind" })]);
    expect(update?.number).toBe(4);
    expect(log.at(-1)).toMatch(/UPDATE #4/);
  });

  it("puts batch branches first", () => {
    expect(decide([pr({ number: 3, state: "behind" }), pr({ number: 8, branch: "batch/1200-1", state: "behind" })]).update?.number).toBe(8);
  });

  it("waits while an up-to-date pull request runs CI or is about to merge", () => {
    for (const head of [pr({ number: 2, state: "blocked", ci: "pending" }), pr({ number: 2, state: "blocked", ci: "success" }), pr({ number: 2, state: "clean" }), pr({ number: 2, state: "unstable" })]) {
      const { update, log } = decide([head, pr({ number: 5, state: "behind" })]);
      expect(update).toBeNull();
      expect(log.join("\n")).toMatch(/BUSY: #2/);
    }
  });

  it("does not wait behind a red or stalled head", () => {
    expect(decide([pr({ number: 2, state: "blocked", ci: "failure" }), pr({ number: 5, state: "behind" })]).update?.number).toBe(5);
    const stalled = decide([pr({ number: 2, state: "blocked", ci: "none" }), pr({ number: 5, state: "behind" })]);
    expect(stalled.update?.number).toBe(5);
    expect(stalled.log.join("\n")).toMatch(/STALLED #2/);
  });

  it("skips a behind pull request whose CI is red on its commit", () => {
    const { update, log } = decide([pr({ number: 3, state: "behind", ci: "failure" }), pr({ number: 6, state: "behind" })]);
    expect(update?.number).toBe(6);
    expect(log.join("\n")).toMatch(/WAITING #3/);
    expect(decide([pr({ number: 3, state: "behind", ci: "failure" })]).update).toBeNull();
  });

  it("skips conflicts and reports them", () => {
    const { update, conflicts } = decide([pr({ number: 3, state: "dirty" }), pr({ number: 6, state: "behind" })]);
    expect(conflicts.map((p) => p.number)).toEqual([3]);
    expect(update?.number).toBe(6);
  });

  it("waits for GitHub to compute a state it does not know yet", () => {
    const { update, log } = decide([pr({ number: 3, state: "unknown" }), pr({ number: 6, state: "behind" })]);
    expect(update).toBeNull();
    expect(log.join("\n")).toMatch(/UNKNOWN/);
  });
});

describe("CI on a commit", () => {
  it("reads CI Success, the newest run of it", () => {
    expect(ciState([run("CI Success", "completed", "success")])).toBe("success");
    expect(ciState([run("CI Success", "completed", "failure")])).toBe("failure");
    expect(ciState([run("CI Success", "in_progress")])).toBe("pending");
    expect(ciState([run("CI Success", "completed", "failure", "2026-10-07T10:00:00Z", 1), run("CI Success", "completed", "success", "2026-10-07T11:00:00Z", 2)])).toBe("success");
  });

  it("ignores the draft gate", () => {
    expect(ciState([run("CI Success (draft)", "completed", "success")])).toBe("none");
  });

  it("is pending while CI runs before its gate exists, and none when nothing ever started", () => {
    expect(ciState([run("Frontend lint and types", "in_progress")])).toBe("pending");
    expect(ciState([])).toBe("none");
    expect(ciState([run("Security", "completed", "success")])).toBe("none");
  });

  it("does not count a cancelled run as red", () => {
    expect(ciState([run("CI Success", "completed", "cancelled"), run("Changed paths", "queued")])).toBe("pending");
    expect(ciState([run("CI Success", "completed", "cancelled")])).toBe("none");
  });
});

describe("the conflict comment", () => {
  it("is left once per head commit", () => {
    const body = conflictComment("abc", "dev");
    expect(body).toMatch(/conflicts with `dev`/);
    expect(conflictNoted([{ body }], "abc")).toBe(true);
    expect(conflictNoted([{ body }], "def")).toBe(false);
    expect(conflictNoted([{ body: "LGTM" }, { body: null }], "abc")).toBe(false);
  });
});
