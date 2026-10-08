import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aloneMark, appTrainIn, batchBody, bisect, BudgetLow, canGoAlone, ciState, gitLayer, isBatch, LABEL, localBases, order, ordinal, pickBatch, queuedAt, readState, restLayer, rounds, squashMessage, tick, trainBases, waiting } from "../merge-train.mjs";

type Pr = { number: number; title: string; body: string; draft: boolean; sha: string; branch: string; fork: boolean; labels: string[]; createdAt: string; open: boolean; base: string; merged?: boolean };
const green = [{ name: "CI Success", status: "completed", conclusion: "success", started_at: "2026-10-08T00:00:00Z", id: 1 }];
const red = [{ name: "CI Success", status: "completed", conclusion: "failure", started_at: "2026-10-08T00:00:00Z", id: 1 }];
const running = [{ name: "CI Success", status: "in_progress", conclusion: null, started_at: "2026-10-08T00:00:00Z", id: 1 }];

/** A fake repository: pull requests, labels, label events, comments, CI per commit, and the base's tip. */
function fakeRepo() {
  const pulls = new Map<number | string, Pr>();
  const events = new Map<number, { event: string; label: { name: string }; created_at: string }[]>();
  const comments = new Map<number | string, { id: number; body: string; user?: { login: string } }[]>();
  const runs = new Map<string, object[]>();
  /** When each head was pushed (its first check suite); unset: long before anything was queued, null: no suite yet. */
  const pushed = new Map<string, string | null>();
  const tips: Record<string, string> = { dev: "dev0", "epic/x": "epic0" };
  const landed: string[] = [];
  /** The base tip each head sits on: a head holds the tip when it sits on exactly it. */
  const sitsOn = new Map<string, string>();
  /** Heads the train made by rebasing a pull request, and its pushes to pull requests' branches. */
  const rebased = new Set<string>();
  const pushes: string[] = [];
  const moved = new Set<number>();
  let ids = 1;
  let next = 9000;
  let clock = 0;
  let rebases = 0;
  /** Every merge asked of GitHub ("rebase #9000", "squash #11"), and the title and message given with each squash. */
  const merges: string[] = [];
  const squashes = new Map<number, { title: string; message: string }>();
  /** Each pull request's commit messages (two commits unless set), and the commits GitHub does not show as verified. */
  const commits = new Map<number, string[]>();
  const unsigned = new Set<string>();
  /** A lone pull request merges only at its head, and only while that head sits on the base's tip. */
  const mergeAlone = (p: Pr, sha: string) => {
    if (p.sha !== sha || sitsOn.get(sha) !== tips[p.base]) return { ok: false, message: "HTTP 405 not up to date" };
    landed.push(`#${p.number}`);
    tips[p.base] = sha;
    Object.assign(p, { open: false, merged: true });
    return { ok: true };
  };
  const gh = {
    pulls: async (base: string) => [...pulls.values()].filter((p) => p.open && p.base === base).map((p) => ({ ...p, labels: [...p.labels] })),
    mergedPulls: async (base: string) => [...pulls.values()].filter((p) => p.merged && p.base === base).map((p) => ({ ...p, labels: [...p.labels] })),
    events: async (n: number) => events.get(n) ?? [],
    checkRuns: async (sha: string) => runs.get(sha) ?? [],
    headPushedAt: async (sha: string) => (pushed.has(sha) ? pushed.get(sha) : "2026-10-01T00:00:00Z"),
    comments: async (n: number) => comments.get(n) ?? [],
    branchSha: async (base: string) => tips[base],
    behindBy: async (tip: string, head: string) => (sitsOn.get(head) === tip ? 0 : 3),
    comment: async (n: number, body: string) => {
      const c = { id: ids++, body, user: { login: "train" } };
      comments.set(n, [...(comments.get(n) ?? []), c]);
      return { id: c.id };
    },
    editComment: async (id: number, body: string) => {
      for (const list of comments.values()) for (const c of list) if (c.id === id) c.body = body;
    },
    deleteComment: async (id: number) => {
      for (const [n, list] of comments) comments.set(n, list.filter((c) => c.id !== id));
    },
    addLabel: async (n: number, l: string) => void pulls.get(n)!.labels.push(l),
    removeLabel: async (n: number, l: string) => void (pulls.get(n)!.labels = pulls.get(n)!.labels.filter((x) => x !== l)),
    closePull: async (n: number) => void (pulls.get(n)!.open = false),
    deleteBranch: async () => {},
    createPull: async ({ base, head, title, body }: { base: string; head: string; title: string; body: string }) => {
      const number = next++;
      pulls.set(number, { number, title, body, draft: false, sha: built.get(head)!, branch: head, fork: false, labels: [], createdAt: "", open: true, base });
      return { number };
    },
    pullCommits: async (n: number) => (commits.get(n) ?? [`part one of ${n}`, `part two of ${n}\n\nIts body.`]).map((message) => ({ commit: { message } })),
    commit: async (sha: string) => ({ verified: !unsigned.has(sha), reason: unsigned.has(sha) ? "unsigned" : "valid", tree: `tree:${sha}` }),
    /** GitHub's squash merge: one new commit on the base (`s<n>`), written and signed by GitHub. */
    squash: async (n: number, sha: string, title: string, message: string) => {
      const p = pulls.get(n)!;
      merges.push(`squash #${n}`);
      const r = mergeAlone(p, sha);
      if (!r.ok) return r;
      squashes.set(n, { title, message });
      tips[p.base] = `s${n}`;
      return { ok: true, sha: tips[p.base] };
    },
    merge: async (n: number, sha: string) => {
      const p = pulls.get(n)!;
      const state = readState(p.body);
      merges.push(`rebase #${n}`);
      if (!state) return mergeAlone(p, sha);
      if (p.sha !== sha || tips[p.base] !== state.baseSha) return { ok: false, message: "HTTP 405 not up to date" };
      for (const m of state.prs) landed.push(`#${m.number}`);
      tips[p.base] = `${tips[p.base]}+${state.prs.map((m: { number: number }) => m.number).join("+")}`;
      p.open = false;
      p.merged = true;
      return { ok: true };
    },
  };
  const built = new Map<string, string>();
  const conflicts = new Set<number>();
  let lastSha = "";
  const git = {
    build: async (base: string, prs: Pr[]) => {
      const applied = prs.filter((p) => !conflicts.has(p.number)).map((p) => p.number);
      lastSha = `${tips[base]}:${applied.join(",")}`;
      return { baseSha: tips[base], sha: lastSha, applied, dropped: prs.filter((p) => conflicts.has(p.number)).map((p) => ({ number: p.number, reason: "conflict" })) };
    },
    push: async (branch: string, sha: string) => void built.set(branch, sha),
    /** An epic's fast-forward: refused unless the epic's tip is the batch's base. */
    land: async (base: string, sha: string) => {
      const p = [...pulls.values()].find((x) => x.open && x.sha === sha)!;
      const state = readState(p.body);
      if (!state) return mergeAlone(p, sha);
      if (tips[base] !== state.baseSha) return { ok: false, message: "rejected (fetch first)" };
      for (const m of state.prs) landed.push(`#${m.number}`);
      tips[base] = sha;
      Object.assign(p, { open: false, merged: true });
      return { ok: true };
    },
    landPull: async (base: string, _n: number, sha: string) => git.land(base, sha),
    /** A rebase onto the tip: a new head that sits on it, unless the head already does and nothing forces new commits. */
    rebase: async (base: string, p: Pr, { force = false } = {}) => {
      if (moved.has(p.number)) return { baseSha: tips[base], dropped: "moved" };
      if (conflicts.has(p.number)) return { baseSha: tips[base], dropped: "conflict" };
      if (!force && sitsOn.get(p.sha) === tips[base]) return { baseSha: tips[base], sha: p.sha };
      const sha = `r${p.number}.${++rebases}`;
      sitsOn.set(sha, tips[base]);
      rebased.add(sha);
      return { baseSha: tips[base], sha };
    },
    /** A push with a lease: refused once the branch is no longer at `expected`. */
    pushHead: async (branch: string, sha: string, expected: string) => {
      const p = [...pulls.values()].find((x) => x.open && x.branch === branch)!;
      if (p.sha !== expected) return { ok: false, message: "! [rejected] (stale info)" };
      p.sha = sha;
      pushes.push(`${branch}=${sha}`);
      return { ok: true };
    },
  };
  /** A pull request with `queue`; its head sits on the base's tip unless it is `behind`. */
  const add = (number: number, { ci = green as object[], draft = false, priority = false, base = "dev", behind = false } = {}) => {
    const sha = `h${number}`;
    pulls.set(number, { number, title: `fix ${number}`, body: "", draft, sha, branch: `fix-${number}`, fork: false, labels: [LABEL.queue, ...(priority ? [LABEL.priority] : [])], createdAt: "2026-10-01T00:00:00Z", open: true, base });
    events.set(number, [{ event: "labeled", label: { name: LABEL.queue }, created_at: new Date(Date.UTC(2026, 9, 8, 0, 0, clock++)).toISOString() }]);
    runs.set(sha, ci);
    sitsOn.set(sha, behind ? "old" : tips[base]);
  };
  /** CI ends on every open batch and on every head the train rebased: red when it holds one of `bad`. */
  const settle = (bad: number[] = []) => {
    for (const p of pulls.values()) {
      if (p.open && rebased.has(p.sha)) runs.set(p.sha, bad.includes(p.number) ? red : green);
      if (!p.open || !readState(p.body)) continue;
      runs.set(p.sha, readState(p.body).prs.some((m: { number: number }) => bad.includes(m.number)) ? red : green);
    }
  };
  const batch = () => [...pulls.values()].find((p) => p.open && readState(p.body));
  const members = () => readState(batch()?.body)?.prs.map((m: { number: number }) => m.number) ?? [];
  /** The train's mark on a lone pull request (from its own position comment), or null. */
  const alone = (n: number) => aloneMark(comments.get(n)?.find((c) => c.user?.login === "train" && c.body.includes("merge-train:position")));
  /** What is in flight: a batch's members, or the one pull request rebased alone whose head is the mark's commit. */
  const flight = () => (batch() ? members() : [...pulls.values()].filter((p) => p.open && alone(p.number)?.sha === p.sha).map((p) => p.number));
  let stamp = 0;
  const run = (opts = {}) => tick({ gh, git, base: "dev", login: "train", stamp: String(stamp++), ...opts });
  return { gh, git, pulls, comments, runs, pushed, tips, landed, conflicts, moved, pushes, sitsOn, merges, squashes, commits, unsigned, add, settle, batch, members, alone, flight, run };
}

describe("the line", () => {
  it("puts queue:priority first, then the time each got queue, then the number", () => {
    const line = order([
      { number: 5, priority: false, queuedAt: "2026-10-08T03:00:00Z" },
      { number: 9, priority: false, queuedAt: "2026-10-08T01:00:00Z" },
      { number: 7, priority: true, queuedAt: "2026-10-08T05:00:00Z" },
      { number: 3, priority: false, queuedAt: "2026-10-08T01:00:00Z" },
    ]);
    expect(line.map((p) => p.number)).toEqual([7, 3, 9, 5]);
  });

  it("counts the latest time queue was added, so taking it off and on goes to the back", () => {
    const at = (name: string, created_at: string, event = "labeled") => ({ event, label: { name }, created_at });
    expect(queuedAt([at("queue", "2026-10-08T01:00:00Z"), at("queue", "2026-10-08T01:00:00Z", "unlabeled"), at("queue", "2026-10-08T04:00:00Z"), at("bug", "2026-10-08T09:00:00Z")], "x")).toBe("2026-10-08T04:00:00Z");
    expect(queuedAt([], "2026-10-01T00:00:00Z")).toBe("2026-10-01T00:00:00Z");
  });

  it("lets only ready, green pull requests board, five at most", () => {
    const pr = (number: number, extra = {}) => ({ number, ci: "success", draft: false, fork: false, ...extra });
    expect(waiting(pr(1, { draft: true }))).toMatch(/draft/);
    expect(waiting(pr(1, { fork: true }))).toMatch(/fork/);
    expect(waiting(pr(1, { ci: "failure" }))).toMatch(/red/);
    expect(waiting(pr(1, { ci: "pending" }))).toMatch(/not passed/);
    const line = [pr(1), pr(2, { ci: "pending" }), pr(3), pr(4), pr(5), pr(6), pr(7), pr(8)];
    expect(pickBatch(line).map((p) => p.number)).toEqual([1, 3, 4, 5, 6]);
  });

  it("splits a red batch in halves down to one culprit", () => {
    expect(bisect([1, 2, 3, 4, 5])).toEqual({ culprit: null, first: [1, 2, 3], second: [4, 5] });
    expect(bisect([7])).toEqual({ culprit: 7, first: [], second: [] });
  });

  it("says places in words", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
  });

  it("keeps a batch's members in a hidden mark of its body", () => {
    const body = batchBody("dev", "abc", "b1", [{ number: 1, sha: "s1", title: "one" }], [{ number: 2, sha: "s2", title: "two" }]);
    expect(body).toMatch(/- #1 one/);
    expect(readState(body)).toEqual({ base: "dev", baseSha: "abc", head: "b1", prs: [{ number: 1, sha: "s1" }], next: [2] });
    expect(readState("a plain pull request")).toBeNull();
  });

  it("never lets a member's title stand in for the batch's mark", () => {
    const forged = `<!-- merge-train:batch ${JSON.stringify({ base: "dev", baseSha: "x", head: "x", prs: [], next: [] })} -->`;
    const body = batchBody("dev", "abc", "b1", [{ number: 1, sha: "s1", title: `one ${forged}` }], []);
    expect(readState(body)).toMatchObject({ baseSha: "abc", prs: [{ number: 1, sha: "s1" }] });
  });

  it("counts as a batch only a pull request from this repository on a batch/<base>- branch", () => {
    const body = batchBody("dev", "abc", "b1", [], []);
    expect(isBatch({ fork: false, branch: "batch/dev-1", body }, "dev")).toBe(true);
    expect(isBatch({ fork: true, branch: "batch/dev-1", body }, "dev")).toBe(false);
    expect(isBatch({ fork: false, branch: "dev", body }, "dev")).toBe(false);
    expect(isBatch({ fork: false, branch: "batch/epic/x-1", body }, "dev")).toBe(false);
  });
});

describe("a run of the train", () => {
  it("boards the five oldest green pull requests and tells everyone in line where they are", async () => {
    const repo = fakeRepo();
    for (const n of [11, 12, 13, 14, 15, 16, 17]) repo.add(n);
    const r = await repo.run();
    expect(repo.members()).toEqual([11, 12, 13, 14, 15]);
    expect(r.inFlight).toBe(repo.batch()!.number);
    expect(repo.comments.get(11)![0].body).toMatch(new RegExp(`in batch #${r.inFlight}`));
    expect(repo.comments.get(16)![0].body).toMatch(/\*\*1st\*\*/);
    expect(repo.comments.get(17)![0].body).toMatch(/\*\*2nd\*\*/);

    repo.runs.set(repo.batch()!.sha, running);
    const again = await repo.run(); // CI still running: nothing moves, and the position comments are not posted again
    expect(again.inFlight).toBe(r.inFlight);
    expect(again.log.join("\n")).not.toMatch(/warning/);
    expect(repo.members()).toEqual([11, 12, 13, 14, 15]);
    expect(repo.comments.get(16)).toHaveLength(1);
  });

  it("merges a green batch, closes the originals as merged via it, and boards the next", async () => {
    const repo = fakeRepo();
    for (const n of [11, 12, 13, 14, 15, 16]) repo.add(n);
    const first = (await repo.run()).inFlight;
    repo.settle();
    const r = await repo.run();
    expect(r.merged).toEqual([11, 12, 13, 14, 15]);
    expect(repo.landed).toEqual(["#11", "#12", "#13", "#14", "#15"]);
    for (const n of [11, 12, 13, 14, 15]) {
      const p = repo.pulls.get(n)!;
      expect(p.open).toBe(false);
      expect(p.labels).toEqual([]);
      expect(repo.comments.get(n)!.map((c) => c.body)).toEqual([`Merged via #${first}.`]);
    }
    // #16 is next, alone: dev moved under it, so the train rebases its branch instead of opening a batch.
    expect(r.inFlight).toBe(16);
    expect(repo.batch()).toBeUndefined();
    expect(repo.flight()).toEqual([16]);
  });

  it("drops a conflicting pull request with one comment and boards the rest", async () => {
    const repo = fakeRepo();
    for (const n of [11, 12, 13]) repo.add(n);
    repo.conflicts.add(12);
    const r = await repo.run();
    expect(r.dropped).toEqual([12]);
    expect(repo.members()).toEqual([11, 13]);
    expect(repo.pulls.get(12)!.labels).toEqual([LABEL.conflict]);
    expect(repo.comments.get(12)!.map((c) => c.body)).toEqual([expect.stringMatching(/conflicts with `dev`/)]);
  });

  it("finds the culprit of a red batch by halves, and lands everyone else", async () => {
    const repo = fakeRepo();
    for (const n of [11, 12, 13, 14]) repo.add(n);
    await repo.run();
    const seen: number[][] = [repo.flight()];
    for (let i = 0; i < 10 && repo.flight().length; i++) {
      repo.settle([13]);
      await repo.run();
      seen.push(repo.flight());
    }
    // [13] alone is red twice (one rerun for a flake) before it is called the culprit; [14], last, goes alone.
    expect(seen).toEqual([[11, 12, 13, 14], [11, 12], [13, 14], [13], [13], [14], []]);
    expect(repo.landed).toEqual(["#11", "#12", "#14"]);
    expect(repo.pulls.get(13)!.labels).toEqual([LABEL.failed]);
    expect(repo.comments.get(13)!.at(-1)!.body).toMatch(/failed twice in a batch with only this pull request on `dev`/);
  });

  it("never lets a newer pull request overtake an older one (FIFO)", async () => {
    const repo = fakeRepo();
    // Numbers out of order: the time each got `queue` decides, as with #1488 behind newer, faster pull requests.
    for (const n of [1488, 1501, 1490, 1477, 1503, 1495, 1499]) repo.add(n);
    await repo.run();
    for (let i = 0; i < 6; i++) {
      repo.add(1600 + i); // more arrive while the train runs
      repo.settle();
      await repo.run();
    }
    for (let i = 0; i < 10 && repo.flight().length; i++) {
      repo.settle();
      await repo.run();
    }
    expect(repo.landed).toEqual(["#1488", "#1501", "#1490", "#1477", "#1503", "#1495", "#1499", ...[0, 1, 2, 3, 4, 5].map((i) => `#${1600 + i}`)]);
  });

  it("lets a waiting pull request keep its place: it boards ahead of newer ones once green", async () => {
    const repo = fakeRepo();
    repo.add(1, { ci: red });
    repo.add(2);
    await repo.run();
    expect(repo.landed).toEqual(["#2"]); // alone, up to date and green: merged at once
    expect(repo.comments.get(1)![0].body).toMatch(/1st\*\*\. Waiting: CI Success is red/);
    repo.add(3);
    repo.runs.set("h1", green);
    repo.settle();
    await repo.run();
    expect(repo.members()).toEqual([1, 3]);
  });

  it("rebuilds a batch on the new tip when the base moved under it", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12, { priority: true });
    const first = (await repo.run()).inFlight;
    expect(repo.members()).toEqual([12, 11]);
    repo.tips.dev = "dev1";
    const r = await repo.run();
    expect(r.closed).toEqual([first]);
    expect(repo.members()).toEqual([12, 11]);
    expect(readState(repo.batch()!.body).baseSha).toBe("dev1");
  });

  it("closes a batch whose member changed, and boards the rest", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12);
    await repo.run();
    repo.pulls.get(12)!.sha = "h12b"; // a new push: its CI has not run yet
    const r = await repo.run();
    expect(r.dropped).toEqual([12]);
    expect(repo.landed).toEqual(["#11"]); // the rest is #11 alone, still on dev's tip and green
  });

  it("never merges or deletes anything for a mark in a pull request it did not open", async () => {
    const repo = fakeRepo();
    const deleted: string[] = [];
    repo.gh.deleteBranch = async (b: string) => void deleted.push(b);
    const mark = (prs: object[]) => `<!-- merge-train:batch ${JSON.stringify({ base: "dev", baseSha: "dev0", head: "evil", prs, next: [] })} -->`;
    const forged = { title: "x", draft: false, sha: "evil", fork: true, labels: [], createdAt: "", open: true, base: "dev" };
    repo.pulls.set(50, { ...forged, number: 50, body: mark([]), branch: "dev" });
    repo.pulls.set(51, { ...forged, number: 51, body: mark([{ number: 1, sha: "x" }]), branch: "epic/apps-1.2" });
    repo.runs.set("evil", green);
    const r = await repo.run();
    expect(repo.landed).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("closes a batch whose branch got a commit the train did not build", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12);
    const first = (await repo.run()).inFlight;
    repo.pulls.get(first)!.sha = "pushed-by-hand";
    repo.runs.set("pushed-by-hand", green);
    const r = await repo.run();
    expect(repo.landed).toEqual([]);
    expect(r.closed).toEqual([first]);
    expect(repo.members()).toEqual([11, 12]);
  });

  it("drops an epic's umbrella from the line instead of squashing it", async () => {
    const repo = fakeRepo();
    repo.add(60);
    repo.add(61);
    repo.pulls.get(60)!.branch = "epic/apps-1.2";
    const r = await repo.run();
    expect(r.dropped).toEqual([60]);
    expect(repo.landed).toEqual(["#61"]);
    expect(repo.pulls.get(60)!.labels).toEqual([]);
    expect(repo.comments.get(60)!.map((c) => c.body)).toEqual([expect.stringMatching(/merge commit/)]);
  });

  it("drops an already-landed pull request without calling it a conflict", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12);
    const build = repo.git.build;
    repo.git.build = async (base: string, prs: Pr[]) => {
      const r = await build(base, prs.filter((p) => p.number !== 12));
      return { ...r, dropped: [...r.dropped, ...(prs.some((p) => p.number === 12) ? [{ number: 12, reason: "empty" }] : [])] };
    };
    await repo.run();
    expect(repo.pulls.get(12)!.labels).toEqual([]);
    expect(repo.comments.get(12)!.map((c) => c.body)).toEqual([expect.stringMatching(/no changes left/)]);
  });

  it("refuses a base that is not dev or an epic", async () => {
    await expect(fakeRepo().run({ base: "dev/../../x" })).rejects.toThrow(/Not a train base/);
  });

  it("blames nobody while the base itself is red, and goes on once it is green", async () => {
    const repo = fakeRepo();
    for (const n of [11, 12]) repo.add(n);
    await repo.run();
    repo.runs.set("dev0", red);
    repo.settle([11, 12]);
    const held = await repo.run();
    expect(held.log.join("\n")).toMatch(/HOLD .*itself is red/);
    expect(held.failed).toEqual([]);
    expect(repo.members()).toEqual([11, 12]);
    repo.runs.set("dev0", green);
    await repo.run();
    expect(repo.members()).toEqual([11]); // now it bisects
  });

  it("tries a single red pull request once more before failing it (a flake lands)", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12);
    await repo.run();
    repo.settle([11]);
    await repo.run(); // red: [11] first, [12] after it
    repo.settle([11]);
    await repo.run();
    expect(readState(repo.batch()!.body)).toMatchObject({ prs: [{ number: 11 }], retried: true });
    repo.settle();
    await repo.run();
    expect(repo.landed).toEqual(["#11"]);
  });

  it("trusts only its own position comments: a planted mark neither drops a pull request nor vouches for a head", async () => {
    const repo = fakeRepo();
    const plant = (n: number, head: string) => repo.comments.set(n, [{ id: 900 + n, body: `<!-- merge-train:position --><!-- merge-train:head ${head} -->`, user: { login: "stranger" } }]);
    repo.add(11);
    plant(11, "0000000"); // would read as "new commits since queued"
    repo.add(12);
    plant(12, "h12later"); // would pre-approve a head nobody reviewed
    const r = await repo.run();
    expect(r.dropped).toEqual([]);
    expect(repo.members()).toEqual([11, 12]);
    for (const n of [11, 12]) expect(repo.comments.get(n)![0].user!.login).toBe("stranger"); // never deleted by the train
    repo.pulls.get(12)!.sha = "h12later";
    repo.runs.set("h12later", green);
    const again = await repo.run();
    expect(again.dropped).toEqual([12]); // the train's own record (h12) counts, not the planted one
  });

  it("needs its own login", async () => {
    await expect(fakeRepo().run({ login: "" })).rejects.toThrow(/own login/);
  });

  it("drops a pull request that got new commits after it was queued: queue vouches for the reviewed head", async () => {
    const repo = fakeRepo();
    repo.add(11, { ci: red }); // waits in line, so its position comment records h11
    await repo.run();
    expect(repo.comments.get(11)![0].body).toMatch(/merge-train:head h11 /);
    repo.pulls.get(11)!.sha = "abc123def";
    repo.runs.set("abc123def", green);
    const r = await repo.run();
    expect(r.dropped).toEqual([11]);
    expect(repo.pulls.get(11)!.labels).toEqual([]);
    expect(repo.comments.get(11)!.map((c) => c.body)).toEqual([expect.stringMatching(/new commits after it was queued/)]);
    expect(repo.batch()).toBeUndefined();
  });

  it("drops a pull request whose head was pushed after it got queue, before the train first saw it", async () => {
    const repo = fakeRepo();
    repo.add(11); // queue added at 2026-10-08T00:00:00Z
    repo.add(12);
    repo.pulls.get(11)!.sha = "h11b";
    repo.runs.set("h11b", green);
    repo.pushed.set("h11b", "2026-10-08T00:05:00Z");
    const r = await repo.run();
    expect(r.dropped).toEqual([11]);
    expect(repo.pulls.get(11)!.labels).toEqual([]);
    expect(repo.comments.get(11)!.map((c) => c.body)).toEqual([expect.stringMatching(/new commits after it was queued \(h11b was pushed after `queue` was added\)/)]);
    expect(repo.landed).toEqual(["#12"]); // alone, on dev's tip and green
  });

  it("keeps a pull request whose head is older than its queue label, as the auto-queue labels it after green CI", async () => {
    const repo = fakeRepo();
    repo.pushed.set("h11", "2026-10-07T23:40:00Z"); // pushed, CI green, then `queue` at 2026-10-08T00:00:00Z
    repo.add(11);
    const r = await repo.run();
    expect(r.dropped).toEqual([]);
    expect(repo.landed).toEqual(["#11"]); // alone, on dev's tip and green
  });

  it("records no head for a pull request with no CI on its head yet, and lets the time decide once it has", async () => {
    const repo = fakeRepo();
    repo.add(11, { ci: [] });
    repo.pushed.set("h11", null);
    const r = await repo.run();
    expect(r.dropped).toEqual([]);
    expect(repo.comments.get(11)).toBeUndefined();
    repo.pushed.set("h11", "2026-10-08T00:01:00Z"); // its first CI started after the label: pushed after it
    repo.runs.set("h11", green);
    expect((await repo.run()).dropped).toEqual([11]);
  });

  it("finishes a landing that a run left half done", async () => {
    const repo = fakeRepo();
    for (const n of [11, 12]) repo.add(n);
    const b = (await repo.run()).inFlight;
    repo.settle();
    await repo.gh.merge(b, repo.pulls.get(b)!.sha); // the run stopped right after this merge
    const r = await repo.run();
    expect(r.merged).toEqual([11, 12]);
    for (const n of [11, 12]) expect(repo.pulls.get(n)!.open).toBe(false);
    expect(repo.comments.get(11)!.at(-1)!.body).toBe(`Merged via #${b}.`);
    expect(r.opened).toEqual([]);
  });

  it("rebuilds a batch whose CI never started", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12);
    const first = (await repo.run()).inFlight;
    repo.pulls.get(first)!.createdAt = "2026-10-08T00:00:00Z";
    expect((await repo.run({ now: Date.parse("2026-10-08T00:10:00Z") })).closed).toEqual([]);
    const r = await repo.run({ now: Date.parse("2026-10-08T00:30:00Z") });
    expect(r.closed).toEqual([first]);
    expect(repo.members()).toEqual([11, 12]);
  });

  it("still lands a batch on dev by the rebase merge of the batch", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12);
    const b = (await repo.run()).inFlight;
    repo.settle();
    const r = await repo.run();
    expect(repo.merges).toEqual([`rebase #${b}`]);
    expect(repo.landed).toEqual(["#11", "#12"]);
    expect(r.log.join("\n")).not.toMatch(/verified/i); // GitHub signs no rebase merge: nothing to check
  });

  it("lands an epic's batch by a fast-forward of exactly the tested commits", async () => {
    const repo = fakeRepo();
    repo.add(11, { base: "epic/x" });
    repo.add(12, { base: "epic/x" });
    const b = (await repo.run({ base: "epic/x" })).inFlight;
    const tested = repo.pulls.get(b)!.sha;
    repo.settle();
    await repo.run({ base: "epic/x" });
    expect(repo.merges).toEqual([]); // no merge asked of GitHub: a push
    expect(repo.landed).toEqual(["#11", "#12"]);
    expect(repo.tips["epic/x"]).toBe(tested);
  });

  it("leaves a pull request in line when its branch moved after its CI was read", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12);
    const build = repo.git.build;
    repo.git.build = async (base: string, prs: Pr[]) => {
      const r = await build(base, prs.filter((p) => p.number !== 11));
      return { ...r, dropped: [...r.dropped, { number: 11, reason: "moved" }] };
    };
    const r = await repo.run();
    expect(r.dropped).toEqual([]);
    expect(repo.members()).toEqual([12]);
    expect(repo.pulls.get(11)!.labels).toEqual([LABEL.queue]);
  });

  it("changes nothing in a dry run", async () => {
    const repo = fakeRepo();
    for (const n of [11, 12]) repo.add(n);
    await repo.run();
    repo.settle();
    const before = JSON.stringify([...repo.pulls.values()]) + JSON.stringify([...repo.comments.entries()]);
    const r = await repo.run({ dry: true });
    expect(JSON.stringify([...repo.pulls.values()]) + JSON.stringify([...repo.comments.entries()])).toBe(before);
    expect(repo.landed).toEqual([]);
    expect(r.log.join("\n")).toMatch(/\(dry run\) would merge #9000/);
  });
});

describe("one pull request alone", () => {
  it("merges an up-to-date, green pull request itself: no batch, no new CI run, no comment left", async () => {
    const repo = fakeRepo();
    repo.add(11, { ci: running });
    await repo.run(); // waits in line first, so it has a position comment
    expect(repo.comments.get(11)).toHaveLength(1);
    repo.runs.set("h11", green);
    const r = await repo.run();
    expect(r.merged).toEqual([11]);
    expect(r.opened).toEqual([]);
    expect(r.inFlight).toBeNull();
    expect(repo.landed).toEqual(["#11"]);
    expect(repo.tips.dev).toBe("s11");
    expect(repo.pulls.get(11)).toMatchObject({ open: false, merged: true, labels: [] });
    expect(repo.comments.get(11)).toEqual([]); // the position comment goes, and no "Merged via"
    expect(repo.pushes).toEqual([]);
  });

  it("rebases a pull request that is behind, then merges it once CI is green on exactly that commit", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    const r = await repo.run();
    expect(r.opened).toEqual([]);
    expect(r.inFlight).toBe(11);
    const head = repo.pulls.get(11)!.sha;
    expect(repo.pushes).toEqual([`fix-11=${head}`]);
    expect(repo.alone(11)).toMatchObject({ sha: head, baseSha: "dev0", retried: false });
    expect(repo.comments.get(11)![0].body).toMatch(/next into `dev`, alone/);
    expect(repo.comments.get(11)![0].body).toMatch(/merge-train:head h11 /); // the reviewed head stays on record

    // A second pull request queued meanwhile waits behind it, and the flight survives a restart (state is re-read).
    repo.add(12, { behind: true });
    repo.runs.set(head, running);
    const wait = await repo.run();
    expect(wait.inFlight).toBe(11);
    expect(repo.comments.get(12)![0].body).toMatch(/\*\*1st\*\*/);
    expect(repo.landed).toEqual([]);

    repo.settle();
    const done = await repo.run();
    expect(done.merged).toEqual([11]);
    expect(repo.landed).toEqual(["#11"]);
    expect(repo.pulls.get(11)).toMatchObject({ merged: true, labels: [] });
    expect(repo.comments.get(11)).toEqual([]);
    expect(done.inFlight).toBe(12); // next, alone: rebased onto the new tip in the same run
    expect(repo.alone(12)).toMatchObject({ baseSha: "s11" }); // dev's tip is GitHub's squash commit of #11
  });

  it("re-evaluates from scratch when the author pushes during the flight: the new head leaves the line", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    repo.pulls.get(11)!.sha = "h11b";
    repo.runs.set("h11b", green);
    const r = await repo.run();
    expect(r.dropped).toEqual([11]);
    expect(r.inFlight).toBeNull();
    expect(repo.landed).toEqual([]);
    expect(repo.pulls.get(11)!.labels).toEqual([]);
    expect(repo.comments.get(11)!.map((c) => c.body)).toEqual([expect.stringMatching(/new commits after it was queued/)]);
  });

  it("starts over when its push lost the lease: the reviewed head stays vouched for", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    const push = repo.git.pushHead;
    repo.git.pushHead = async () => ({ ok: false, message: "! [rejected] (stale info)" });
    const r = await repo.run();
    expect(r.log.join("\n")).toMatch(/Could not push the rebase of #11/);
    expect(repo.pulls.get(11)!.sha).toBe("h11");
    repo.git.pushHead = push;
    const again = await repo.run();
    expect(again.dropped).toEqual([]);
    expect(again.inFlight).toBe(11);
    expect(repo.pulls.get(11)!.sha).toBe(repo.alone(11)!.sha);
  });

  it("gives a red pull request one more run on a fresh rebase, then queue:failed", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    const first = repo.pulls.get(11)!.sha;
    repo.settle([11]);
    await repo.run();
    const second = repo.pulls.get(11)!.sha;
    expect(second).not.toBe(first);
    expect(repo.alone(11)).toMatchObject({ sha: second, retried: true });
    expect(repo.comments.get(11)![0].body).toMatch(/a second run, after a red one/);
    repo.settle([11]);
    const r = await repo.run();
    expect(r.failed).toEqual([11]);
    expect(r.opened).toEqual([]);
    expect(repo.pulls.get(11)!.labels).toEqual([LABEL.failed]);
    expect(repo.comments.get(11)!.map((c) => c.body)).toEqual([expect.stringMatching(/failed twice with only this pull request on `dev`/)]);
  });

  it("lands a flake on its second run", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    repo.settle([11]);
    await repo.run();
    repo.settle();
    await repo.run();
    expect(repo.landed).toEqual(["#11"]);
  });

  it("blames nobody while the base itself is red", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    const head = repo.pulls.get(11)!.sha;
    repo.runs.set("dev0", red);
    repo.settle([11]);
    const held = await repo.run();
    expect(held.log.join("\n")).toMatch(/HOLD #11: .*itself is red/);
    expect(repo.pulls.get(11)!.sha).toBe(head);
    expect(repo.alone(11)!.retried).toBe(false);
  });

  it("rebases again when the base moves under it, and never lands green on an old tip", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    const head = repo.pulls.get(11)!.sha;
    repo.settle();
    repo.tips.dev = "dev1";
    const r = await repo.run();
    expect(repo.landed).toEqual([]);
    expect(r.inFlight).toBe(11);
    expect(repo.pulls.get(11)!.sha).not.toBe(head);
    expect(repo.alone(11)).toMatchObject({ baseSha: "dev1" });
  });

  it("lets one turned into a draft mid-flight wait in line, its rebased head still vouched for", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    const head = repo.pulls.get(11)!.sha;
    repo.settle();
    repo.pulls.get(11)!.draft = true;
    repo.add(12);
    const r = await repo.run();
    expect(repo.landed).toEqual(["#12"]); // a draft waits and others go, as in the batch line
    expect(repo.comments.get(11)![0].body).toMatch(/1st\*\*\. Waiting: it is a draft/);
    repo.pulls.get(11)!.draft = false;
    const again = await repo.run();
    expect(r.dropped).toEqual([]);
    expect(again.dropped).toEqual([]);
    expect(again.inFlight).toBe(11); // dev moved (#12): rebased again from the train's own head
    expect(repo.pulls.get(11)!.sha).not.toBe(head);
  });

  it("rebases again when CI never started on its commit", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run({ now: Date.parse("2026-10-08T00:00:00Z") });
    const head = repo.pulls.get(11)!.sha;
    await repo.run({ now: Date.parse("2026-10-08T00:10:00Z") });
    expect(repo.pulls.get(11)!.sha).toBe(head);
    await repo.run({ now: Date.parse("2026-10-08T00:30:00Z") });
    expect(repo.pulls.get(11)!.sha).not.toBe(head);
  });

  it("takes a pull request that conflicts with the tip out of the line with queue:conflict", async () => {
    const repo = fakeRepo();
    repo.conflicts.add(11);
    repo.add(11, { behind: true });
    const r = await repo.run();
    expect(r.dropped).toEqual([11]);
    expect(r.inFlight).toBeNull();
    expect(repo.pushes).toEqual([]);
    expect(repo.pulls.get(11)!.labels).toEqual([LABEL.conflict]);
    expect(repo.comments.get(11)!.map((c) => c.body)).toEqual([expect.stringMatching(/conflicts with `dev`/)]);
  });

  it("still builds a batch for two or more, and never pushes to their branches", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    repo.add(12);
    const r = await repo.run();
    expect(r.opened).toHaveLength(1);
    expect(repo.members()).toEqual([11, 12]);
    expect(repo.pushes).toEqual([]);
  });

  it("fast-forwards an epic to the pull request's head, behind or not", async () => {
    const repo = fakeRepo();
    repo.add(11, { base: "epic/x" });
    const first = await repo.run({ base: "epic/x" });
    expect(repo.tips["epic/x"]).toBe("h11");
    repo.add(12, { base: "epic/x", behind: true });
    await repo.run({ base: "epic/x" });
    const head = repo.pulls.get(12)!.sha;
    expect(repo.alone(12)).toMatchObject({ baseSha: "h11" });
    repo.settle();
    await repo.run({ base: "epic/x" });
    expect(repo.merges).toEqual([]); // no merge asked of GitHub: the pull request's own commits, pushed as they are
    expect(first.log.join("\n")).not.toMatch(/verified/i); // so nothing GitHub signed to read back
    expect(repo.landed).toEqual(["#11", "#12"]);
    expect(repo.tips["epic/x"]).toBe(head);
  });

  it("lands on dev by GitHub's squash merge, with the title and message a batch gives a pull request", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.commits.set(11, ["fix(chat): the first change\n\nA body that stays out.", "test(chat): cover it", "  "]);
    const r = await repo.run();
    expect(repo.merges).toEqual(["squash #11"]); // never the rebase merge, which GitHub does not sign
    expect(repo.squashes.get(11)).toEqual({ title: "fix 11 (#11)", message: "* fix(chat): the first change\n* test(chat): cover it" });
    expect(repo.tips.dev).toBe("s11"); // GitHub's own commit, not the pull request's head
    expect(r.log).toContain("VERIFIED #11: GitHub signed s11 (verified=true)");
    expect(r.log.join("\n")).not.toMatch(/::warning::/);
    expect(squashMessage({ title: "feat: x", number: 7 }, [])).toEqual({ title: "feat: x (#7)", message: "" });
  });

  it("lands a rebased pull request by the same squash merge, at the commit CI passed on", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    expect(repo.merges).toEqual([]);
    repo.settle();
    const r = await repo.run();
    expect(repo.merges).toEqual(["squash #11"]);
    expect(repo.squashes.get(11)!.title).toBe("fix 11 (#11)");
    expect(r.log).toContain("VERIFIED #11: GitHub signed s11 (verified=true)");
  });

  it("warns when the commit it landed is not verified, or cannot be read", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.unsigned.add("s11");
    const r = await repo.run();
    expect(r.merged).toEqual([11]);
    expect(r.log).toContain("::warning::#11 landed as s11, which is not verified (verified=false, reason: unsigned).");
    expect(repo.pulls.get(11)).toMatchObject({ merged: true, labels: [] });

    repo.add(12, { behind: true });
    await repo.run();
    repo.settle();
    repo.gh.commit = async () => Promise.reject(new Error("GET /commits/s12: HTTP 502"));
    const unread = await repo.run();
    expect(unread.merged).toEqual([12]); // landed all the same
    expect(unread.log.join("\n")).toMatch(/::warning::Could not read whether #12's commit s12 is verified: GET \/commits\/s12: HTTP 502/);

    // The API budget running out on that read stops the run like anywhere else, after the labels and comment went.
    repo.add(13, { behind: true });
    await repo.run();
    repo.settle();
    repo.gh.commit = async () => Promise.reject(new BudgetLow("GitHub API budget low"));
    await expect(repo.run()).rejects.toBeInstanceOf(BudgetLow);
    expect(repo.pulls.get(13)).toMatchObject({ merged: true, labels: [] });
    expect(repo.comments.get(13)).toEqual([]);
  });

  it("sends a pull request whose squash merge GitHub refuses the batch way, so it never blocks the line", async () => {
    const repo = fakeRepo();
    repo.gh.squash = async () => ({ ok: false, message: "HTTP 405 Squash merges are not allowed on this repository." });
    repo.add(11);
    const r = await repo.run();
    expect(r.log.join("\n")).toMatch(/Could not merge #11 alone: HTTP 405 Squash merges are not allowed on this repository\.; it goes the batch way/);
    expect(repo.members()).toEqual([11]);
    expect(repo.landed).toEqual([]);
    repo.settle();
    await repo.run();
    expect(repo.merges).toEqual([`rebase #${r.opened[0]}`]); // a batch still lands by the rebase merge
    expect(repo.landed).toEqual(["#11"]);
  });

  it("keeps a rebased pull request in flight when its squash merge is refused", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    await repo.run();
    repo.settle();
    const squash = repo.gh.squash;
    repo.gh.squash = async () => ({ ok: false, message: "HTTP 405 Base branch was modified. Review and try the merge again." });
    const r = await repo.run();
    expect(r.log.join("\n")).toMatch(/::warning::Could not land #11: HTTP 405 Base branch was modified/);
    expect(r.inFlight).toBe(11);
    repo.gh.squash = squash;
    expect((await repo.run()).merged).toEqual([11]);
  });

  it("goes the batch way for a head the train must never push to", async () => {
    expect(canGoAlone({ fork: false, branch: "fix-1" })).toBe(true);
    for (const branch of ["dev", "main", "epic/x", "batch/dev-1"]) expect(canGoAlone({ fork: false, branch })).toBe(false);
    expect(canGoAlone({ fork: true, branch: "fix-1" })).toBe(false);
    const repo = fakeRepo();
    repo.add(11, { base: "epic/x", behind: true });
    repo.pulls.get(11)!.branch = "dev";
    await repo.run({ base: "epic/x" });
    expect(repo.pushes).toEqual([]);
    expect(repo.members()).toEqual([11]);
  });

  it("changes nothing in a dry run, and says what it would do", async () => {
    const repo = fakeRepo();
    repo.add(11);
    repo.add(12, { base: "epic/x", behind: true });
    const merged = await repo.run({ dry: true });
    expect(merged.log.join("\n")).toMatch(/\(dry run\) would merge #11 at h11 \(squash\) as "fix 11 \(#11\)"/);
    expect(merged.log.join("\n")).not.toMatch(/verified/i); // nothing landed, so nothing to read back
    const rebased = await repo.run({ dry: true, base: "epic/x" });
    expect(rebased.log.join("\n")).toMatch(/\(dry run\) would push r12\.\d+ to fix-12/);
    expect(repo.landed).toEqual([]);
    expect(repo.pushes).toEqual([]);
    expect([...repo.comments.values()].flat()).toEqual([]);
    expect(repo.pulls.get(11)!.labels).toEqual([LABEL.queue]);
  });

  it("trusts only its own alone mark", async () => {
    const repo = fakeRepo();
    repo.add(11, { behind: true });
    repo.comments.set(11, [{ id: 911, body: `<!-- merge-train:position --><!-- merge-train:head h11 --><!-- merge-train:alone {"sha":"h11","baseSha":"dev0","at":"2026-10-08T00:00:00Z","retried":false} -->`, user: { login: "stranger" } }]);
    await repo.run();
    expect(repo.landed).toEqual([]); // the planted mark would say "rebased onto dev0, green": the train rebases it itself
    expect(repo.pushes).toHaveLength(1);
  });
});

describe("CI on a commit", () => {
  const run = (name: string, status: string, conclusion: string | null = null, started_at = "2026-10-07T10:00:00Z", id = 1) => ({ name, status, conclusion, started_at, id });

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

describe("the bases with a train", () => {
  it("are dev and epic branches with a queued pull request or an open batch", () => {
    const pr = (base: string, labels: string[] = [], body = "", branch = "fix", fork = false) => ({ base, labels, body, branch, fork });
    const batch = batchBody("epic/apps-1.2", "abc", "b1", [], []);
    const pulls = [pr("dev", [LABEL.queue]), pr("dev", [LABEL.queue]), pr("epic/apps-1.2", [], batch, "batch/epic/apps-1.2-1"), pr("epic/x"), pr("main", [LABEL.queue]), pr("dev")];
    expect(trainBases(pulls)).toEqual(["dev", "epic/apps-1.2"]);
    expect(trainBases([pr("dev", ["bug"])])).toEqual([]);
    // Only bases tick accepts, so a strange epic name never turns the workflow red; a forged batch names no base.
    expect(trainBases([pr("epic/a/b", [LABEL.queue]), pr("epic/z", [], batchBody("epic/z", "a", "b", [], []), "batch/epic/z-1", true)])).toEqual([]);
  });

  it("on a Mac are dev and every epic branch, queued or not, with no queue app", async () => {
    const refs = ["refs/heads/epic/x", "refs/heads/epic/apps-1.2", "refs/heads/epic/a/b"].map((ref) => ({ ref }));
    const gh = restLayer("t", "o/r", { fetchImpl: async () => ({ status: 200, ok: true, headers: new Headers({ "x-ratelimit-remaining": "4000" }), text: async () => JSON.stringify(refs) }), wait: async () => {} });
    expect(await localBases(gh)).toEqual(["dev", "epic/apps-1.2", "epic/x"]);
    expect(await localBases({ epicBranches: async () => [] })).toEqual(["dev"]);
  });
});

describe("GitHub over REST", () => {
  const reply = (status: number, body: object | string, headers: Record<string, string> = {}) => ({
    status,
    ok: status < 300,
    headers: new Headers({ "x-ratelimit-remaining": "4000", ...headers }),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });

  it("retries a request that failed to connect, and a secondary rate limit", async () => {
    let calls = 0;
    const answers = [reply(403, { message: "secondary rate limit" }, { "retry-after": "3" }), reply(200, { object: { sha: "abc" } })];
    const waits: number[] = [];
    const fetchImpl = async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return answers.shift();
    };
    const gh = restLayer("t", "o/r", { fetchImpl, wait: async (ms: number) => void waits.push(ms) });
    expect(await gh.branchSha("dev")).toBe("abc");
    expect(waits).toEqual([5000, 3000]);
    const down = restLayer("t", "o/r", { fetchImpl: async () => Promise.reject(new TypeError("fetch failed")), wait: async () => {} });
    await expect(down.branchSha("dev")).rejects.toThrow(/fetch failed/);
  });

  it("retries a 502 and a rate-limited 403 with backoff, then answers", async () => {
    const answers = [reply(502, "<html>bad gateway</html>"), reply(403, { message: "rate" }, { "x-ratelimit-remaining": "0", "retry-after": "7" }), reply(200, { object: { sha: "abc" } })];
    const waits: number[] = [];
    const gh = restLayer("t", "o/r", { budget: 0, fetchImpl: async () => answers.shift(), wait: async (ms: number) => void waits.push(ms) });
    expect(await gh.branchSha("dev")).toBe("abc");
    expect(waits).toEqual([5000, 7000]);
  });

  it("keeps the status of an HTML error page readable once retries run out", async () => {
    const gh = restLayer("t", "o/r", { fetchImpl: async () => reply(502, "<html>bad gateway</html>"), wait: async () => {} });
    await expect(gh.branchSha("dev")).rejects.toThrow(/HTTP 502 <html>bad gateway/);
  });

  it("asks for a squash merge at a head with a title and a message, and reads back what GitHub made", async () => {
    const sent: { method: string; url: string; body: unknown }[] = [];
    const answers = [
      reply(200, { sha: "new1", merged: true, message: "Pull Request successfully merged" }),
      reply(409, { message: "Head branch was modified. Review and try the merge again." }),
      reply(200, [{ commit: { message: "one\n\nbody" } }, { commit: { message: "two" } }]),
      reply(200, { sha: "new1", commit: { tree: { sha: "t1" }, verification: { verified: true, reason: "valid" } } }),
      reply(200, { sha: "old1", commit: { tree: { sha: "t0" }, verification: { verified: false, reason: "unsigned" } } }),
      reply(200, { sha: "b9", merged: true }),
    ];
    const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
      sent.push({ method: init.method, url: url.replace("https://api.github.com/repos/o/r", ""), body: init.body ? JSON.parse(init.body) : undefined });
      return answers.shift();
    };
    const gh = restLayer("t", "o/r", { fetchImpl, wait: async () => {} });
    expect(await gh.squash(7, "abc", "fix: x (#7)", "* one\n* two")).toEqual({ ok: true, sha: "new1", message: "HTTP 200 Pull Request successfully merged" });
    expect(await gh.squash(8, "def", "fix: y (#8)", "* one")).toEqual({ ok: false, sha: undefined, message: "HTTP 409 Head branch was modified. Review and try the merge again." });
    expect(squashMessage({ title: "fix: x", number: 7 }, await gh.pullCommits(7))).toEqual({ title: "fix: x (#7)", message: "* one\n* two" });
    expect(await gh.commit("new1")).toEqual({ verified: true, reason: "valid", tree: "t1" });
    expect(await gh.commit("old1")).toEqual({ verified: false, reason: "unsigned", tree: "t0" });
    await gh.merge(9000, "b1"); // a batch: the rebase merge, as before
    expect(sent).toEqual([
      { method: "PUT", url: "/pulls/7/merge", body: { merge_method: "squash", sha: "abc", commit_title: "fix: x (#7)", commit_message: "* one\n* two" } },
      { method: "PUT", url: "/pulls/8/merge", body: { merge_method: "squash", sha: "def", commit_title: "fix: y (#8)", commit_message: "* one" } },
      { method: "GET", url: "/pulls/7/commits?per_page=100&page=1", body: undefined },
      { method: "GET", url: "/commits/new1", body: undefined },
      { method: "GET", url: "/commits/old1", body: undefined },
      { method: "PUT", url: "/pulls/9000/merge", body: { merge_method: "rebase", sha: "b1" } },
    ]);
  });

  it("stops the run when the token's budget runs low", async () => {
    const gh = restLayer("t", "o/r", { fetchImpl: async () => reply(200, []), wait: async () => {} });
    const low = restLayer("t", "o/r", { fetchImpl: async () => reply(200, [], { "x-ratelimit-remaining": "40" }), wait: async () => {} });
    expect(await gh.comments(1)).toEqual([]);
    await expect(low.comments(1)).rejects.toBeInstanceOf(BudgetLow);
  });
});

describe("a stalled request or git call", () => {
  /** A fetch that never answers: it ends only when its signal aborts. */
  const hung = (url: string, { signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

  it("times out a request with no answer, retried like one that failed to connect", async () => {
    let calls = 0;
    const gh = restLayer("t", "o/r", { timeout: 20, wait: async () => {}, fetchImpl: (url: string, init: { signal: AbortSignal }) => (calls++, hung(url, init)) });
    await expect(gh.branchSha("dev")).rejects.toThrow(/GET \/git\/ref\/heads\/dev: no answer within 0.02 s/);
    expect(calls).toBe(4);
  });

  it("times out a reply whose body stalls", async () => {
    const stalled = async (url: string, { signal }: { signal: AbortSignal }) => ({ status: 200, ok: true, headers: new Headers(), text: () => hung(url, { signal }) });
    await expect(restLayer("t", "o/r", { timeout: 20, fetchImpl: stalled }).branchSha("dev")).rejects.toThrow(/no answer within/);
  });

  it("fails every request at once after the round's deadline", async () => {
    const ac = new AbortController();
    ac.abort(new Error("cut"));
    let calls = 0;
    const gh = restLayer("t", "o/r", { signal: ac.signal, fetchImpl: async () => void calls++ });
    await expect(gh.branchSha("dev")).rejects.toThrow(/cut/);
    expect(calls).toBe(0);
  });

  it("kills a git fetch that hangs", async () => {
    const root = mkdtempSync(join(tmpdir(), "merge-train-test-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    try {
      git(["init", "-q", "-b", "dev", "origin"]);
      git(["-C", "origin", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
      git(["clone", "-q", "origin", "clone"]);
      git(["-C", "clone", "config", "remote.origin.uploadpack", "sleep 10; git-upload-pack"]); // a remote that never answers
      const layer = gitLayer({ cwd: join(root, "clone"), timeout: 300 });
      const started = Date.now();
      await expect(layer.build("dev", [])).rejects.toThrow(/git fetch: no answer within 0.3 s/);
      expect(Date.now() - started).toBeLessThan(5000); // once: a timeout is not retried like a locked ref
      layer.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cuts a round past its deadline, logs it, and runs the next round", async () => {
    const signals: AbortSignal[] = [];
    const reports: string[] = [];
    let n = 0;
    await rounds(
      async (signal: AbortSignal) => {
        signals.push(signal);
        if (++n === 1) return new Promise(() => {}); // stalls for good
        if (n === 2) throw new Error("network down");
        return true; // the workflow took over: stop
      },
      { every: 300, deadline: 20, sleep: async () => {}, report: (e: Error) => void reports.push(e.message) },
    );
    expect(n).toBe(3);
    expect(reports).toEqual([expect.stringMatching(/past its 0.02 s deadline/), "network down"]);
    expect(signals.map((s) => s.aborted)).toEqual([true, false, false]);
  });
});

describe("the Mac's stop signal", () => {
  const job = (name: string, status: string, conclusion: string | null, steps: object[] = []) => ({ name, status, conclusion, steps });
  const checkout = (conclusion: string) => [{ name: "Check the queue app", conclusion: "success" }, { name: "Checkout the script", conclusion }];

  it("is a configured app, queue empty or not, or a train job running or done", () => {
    expect(appTrainIn([job("Bases with a train", "completed", "success", checkout("success")), job("Train into ${{ matrix.base }}", "completed", "skipped")])).toBe(true);
    expect(appTrainIn([job("Train into dev", "in_progress", null)])).toBe(true);
    expect(appTrainIn([job("Train into dev", "completed", "failure")])).toBe(true);
  });

  it("is not an unconfigured app, or a train job that only waits to be skipped", () => {
    expect(appTrainIn([job("Bases with a train", "completed", "success", checkout("skipped")), job("Train into ${{ matrix.base }}", "completed", "skipped")])).toBe(false);
    expect(appTrainIn([job("Train into ${{ matrix.base }}", "queued", null)])).toBe(false);
    expect(appTrainIn([])).toBe(false);
  });
});
