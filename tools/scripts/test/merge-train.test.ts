import { describe, expect, it } from "vitest";
import { batchBody, bisect, LABEL, order, ordinal, pickBatch, queuedAt, readState, tick, waiting } from "../merge-train.mjs";

type Pr = { number: number; title: string; body: string; draft: boolean; sha: string; branch: string; fork: boolean; labels: string[]; createdAt: string; open: boolean; base: string };
const green = [{ name: "CI Success", status: "completed", conclusion: "success", started_at: "2026-10-08T00:00:00Z", id: 1 }];
const red = [{ name: "CI Success", status: "completed", conclusion: "failure", started_at: "2026-10-08T00:00:00Z", id: 1 }];
const running = [{ name: "CI Success", status: "in_progress", conclusion: null, started_at: "2026-10-08T00:00:00Z", id: 1 }];

/** A fake repository: pull requests, labels, label events, comments, CI per commit, and the base's tip. */
function fakeRepo() {
  const pulls = new Map<number | string, Pr>();
  const events = new Map<number, { event: string; label: { name: string }; created_at: string }[]>();
  const comments = new Map<number | string, { id: number; body: string }[]>();
  const runs = new Map<string, object[]>();
  const tips: Record<string, string> = { dev: "dev0" };
  const landed: string[] = [];
  let ids = 1;
  let next = 9000;
  let clock = 0;
  const gh = {
    pulls: async (base: string) => [...pulls.values()].filter((p) => p.open && p.base === base).map((p) => ({ ...p, labels: [...p.labels] })),
    events: async (n: number) => events.get(n) ?? [],
    checkRuns: async (sha: string) => runs.get(sha) ?? [],
    comments: async (n: number) => comments.get(n) ?? [],
    branchSha: async (base: string) => tips[base],
    comment: async (n: number, body: string) => void comments.set(n, [...(comments.get(n) ?? []), { id: ids++, body }]),
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
  };
  const add = (number: number, { ci = green, draft = false, priority = false } = {}) => {
    const sha = `h${number}`;
    pulls.set(number, { number, title: `fix ${number}`, body: "", draft, sha, branch: `fix-${number}`, fork: false, labels: [LABEL.queue, ...(priority ? [LABEL.priority] : [])], createdAt: "2026-10-01T00:00:00Z", open: true, base: "dev" });
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
  const run = (opts = {}) => tick({ gh, git, base: "dev", stamp: String(stamp++), ...opts });
  return { gh, git, pulls, comments, runs, tips, landed, conflicts, add, settle, batch, members, run };
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
    const body = batchBody("dev", "abc", [{ number: 1, sha: "s1", title: "one" }], [{ number: 2, sha: "s2", title: "two" }]);
    expect(body).toMatch(/- #1 one/);
    expect(readState(body)).toEqual({ base: "dev", baseSha: "abc", prs: [{ number: 1, sha: "s1" }], next: [2] });
    expect(readState("a plain pull request")).toBeNull();
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
    expect(seen).toEqual([[11, 12, 13, 14], [11, 12], [13, 14], [13], [14], []]);
    expect(repo.landed).toEqual(["#11", "#12", "#14"]);
    expect(repo.pulls.get(13)!.labels).toEqual([LABEL.failed]);
    expect(repo.comments.get(13)!.at(-1)!.body).toMatch(/failed .* alone on `dev`/);
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
