import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appTrainIn, batchBody, bisect, BudgetLow, ciState, gitLayer, isBatch, LABEL, localBases, order, ordinal, pickBatch, queuedAt, readState, restLayer, rounds, tick, trainBases, waiting } from "../merge-train.mjs";

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
  let ids = 1;
  let next = 9000;
  let clock = 0;
  const gh = {
    pulls: async (base: string) => [...pulls.values()].filter((p) => p.open && p.base === base).map((p) => ({ ...p, labels: [...p.labels] })),
    mergedPulls: async (base: string) => [...pulls.values()].filter((p) => p.merged && p.base === base).map((p) => ({ ...p, labels: [...p.labels] })),
    events: async (n: number) => events.get(n) ?? [],
    checkRuns: async (sha: string) => runs.get(sha) ?? [],
    headPushedAt: async (sha: string) => (pushed.has(sha) ? pushed.get(sha) : "2026-10-01T00:00:00Z"),
    comments: async (n: number) => comments.get(n) ?? [],
    branchSha: async (base: string) => tips[base],
    comment: async (n: number, body: string) => void comments.set(n, [...(comments.get(n) ?? []), { id: ids++, body, user: { login: "train" } }]),
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
    merge: async (n: number, sha: string) => {
      const p = pulls.get(n)!;
      const state = readState(p.body);
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
      if (tips[base] !== state.baseSha) return { ok: false, message: "rejected (fetch first)" };
      for (const m of state.prs) landed.push(`#${m.number}`);
      tips[base] = sha;
      Object.assign(p, { open: false, merged: true });
      return { ok: true };
    },
  };
  const add = (number: number, { ci = green, draft = false, priority = false, base = "dev" } = {}) => {
    const sha = `h${number}`;
    pulls.set(number, { number, title: `fix ${number}`, body: "", draft, sha, branch: `fix-${number}`, fork: false, labels: [LABEL.queue, ...(priority ? [LABEL.priority] : [])], createdAt: "2026-10-01T00:00:00Z", open: true, base });
    events.set(number, [{ event: "labeled", label: { name: LABEL.queue }, created_at: new Date(Date.UTC(2026, 9, 8, 0, 0, clock++)).toISOString() }]);
    runs.set(sha, ci);
  };
  /** CI ends on every open batch: red when it holds one of `bad`. */
  const settle = (bad: number[] = []) => {
    for (const p of pulls.values()) {
      if (!p.open || !readState(p.body)) continue;
      runs.set(p.sha, readState(p.body).prs.some((m: { number: number }) => bad.includes(m.number)) ? red : green);
    }
  };
  const batch = () => [...pulls.values()].find((p) => p.open && readState(p.body));
  const members = () => readState(batch()?.body)?.prs.map((m: { number: number }) => m.number) ?? [];
  let stamp = 0;
  const run = (opts = {}) => tick({ gh, git, base: "dev", login: "train", stamp: String(stamp++), ...opts });
  return { gh, git, pulls, comments, runs, pushed, tips, landed, conflicts, add, settle, batch, members, run };
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
    expect(repo.members()).toEqual([16]);
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
    const seen: number[][] = [repo.members()];
    for (let i = 0; i < 10 && repo.batch(); i++) {
      repo.settle([13]);
      await repo.run();
      seen.push(repo.members());
    }
    // [13] alone is red twice (one rerun for a flake) before it is called the culprit.
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
    for (let i = 0; i < 6 && repo.batch(); i++) {
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
    expect(repo.members()).toEqual([2]);
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
    await repo.run();
    expect(repo.members()).toEqual([11]);
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
    const first = (await repo.run()).inFlight;
    repo.pulls.get(first)!.sha = "pushed-by-hand";
    repo.runs.set("pushed-by-hand", green);
    const r = await repo.run();
    expect(repo.landed).toEqual([]);
    expect(r.closed).toEqual([first]);
    expect(repo.members()).toEqual([11]);
  });

  it("drops an epic's umbrella from the line instead of squashing it", async () => {
    const repo = fakeRepo();
    repo.add(60);
    repo.add(61);
    repo.pulls.get(60)!.branch = "epic/apps-1.2";
    const r = await repo.run();
    expect(r.dropped).toEqual([60]);
    expect(repo.members()).toEqual([61]);
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
    await repo.run();
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
    expect(repo.members()).toEqual([12]);
  });

  it("keeps a pull request whose head is older than its queue label, as the auto-queue labels it after green CI", async () => {
    const repo = fakeRepo();
    repo.pushed.set("h11", "2026-10-07T23:40:00Z"); // pushed, CI green, then `queue` at 2026-10-08T00:00:00Z
    repo.add(11);
    const r = await repo.run();
    expect(r.dropped).toEqual([]);
    expect(repo.members()).toEqual([11]);
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
    const first = (await repo.run()).inFlight;
    repo.pulls.get(first)!.createdAt = "2026-10-08T00:00:00Z";
    expect((await repo.run({ now: Date.parse("2026-10-08T00:10:00Z") })).closed).toEqual([]);
    const r = await repo.run({ now: Date.parse("2026-10-08T00:30:00Z") });
    expect(r.closed).toEqual([first]);
    expect(repo.members()).toEqual([11]);
  });

  it("lands an epic's batch by a fast-forward of exactly the tested commits", async () => {
    const repo = fakeRepo();
    let merges = 0;
    repo.gh.merge = async () => ({ ok: !!++merges });
    repo.add(11, { base: "epic/x" });
    const b = (await repo.run({ base: "epic/x" })).inFlight;
    const tested = repo.pulls.get(b)!.sha;
    repo.settle();
    await repo.run({ base: "epic/x" });
    expect(merges).toBe(0);
    expect(repo.landed).toEqual(["#11"]);
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
