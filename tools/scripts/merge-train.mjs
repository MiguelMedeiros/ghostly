#!/usr/bin/env node
// The merge train: the only way pull requests land on `dev` (and on each `epic/*` branch). A reviewer adds the label
// `queue` to an approved, green pull request; the train lines them up and lands them in batches.
//
// - The line, per base: `queue:priority` first, then by the time each got `queue` (the latest `labeled` event, so
//   taking the label off and on again goes to the back), then by number. A draft, a fork, or a pull request whose CI
//   Success is not green on its last commit waits without losing its place.
// - One batch per base at a time: up to 5 pull requests from the front of the line, built on the base's tip with one
//   squash commit per pull request, in order ("<title> (#n)"). One that conflicts drops out: `queue:conflict`, one
//   comment, `queue` taken off. The batch is a pull request from `batch/<base>-<stamp>`; CI runs on it once.
// - Green: the batch merges with the rebase method (one commit per pull request on the base), each original closes
//   with "Merged via #<batch>" and loses its labels.
// - Red: the batch closes and its first half becomes the next batch, with the second half noted to go right after it
//   if the first half is green. A batch of one that is red is the culprit: `queue:failed`, a comment, `queue` off.
//   Whatever was not part of the red half goes back to the line at its old place.
// - Each queued pull request keeps one comment that says where it is ("In line for `dev`: 3rd").
//
// The train keeps no state of its own: a batch's members and the half that waits after it live in a hidden mark in
// the batch's body, and everything else is read again each run.
//
//   GH_TOKEN=<token> GITHUB_REPOSITORY=owner/repo node tools/scripts/merge-train.mjs --dry-run [--base dev] [--also 12,34]
//
// --dry-run reads the live repo, builds batches in a temporary worktree (never pushed) and prints what it would do;
// it changes nothing on GitHub. --also pretends the listed pull requests carry `queue` (dry runs only).
// tools/scripts/test/merge-train.test.ts drives the train through a fake GitHub and git.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ciState } from "./merge-queue.mjs";

export const LABEL = { queue: "queue", priority: "queue:priority", conflict: "queue:conflict", failed: "queue:failed" };
export const MAX_BATCH = 5;
const POSITION = "<!-- merge-train:position -->";
const STATE = /<!-- merge-train:batch (\{.*?\}) -->/g;
/** The bases a train runs for; anything else never reaches a URL path, a refspec or a branch name. */
const BASE = /^(dev|epic\/[A-Za-z0-9._-]+)$/;

export const ordinal = (n) => {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th"}`;
};

/** When a pull request joined the line: the latest time it got `queue`. */
export function queuedAt(events, fallback) {
  const times = events.filter((e) => e.event === "labeled" && e.label?.name === LABEL.queue).map((e) => e.created_at);
  return times.sort().at(-1) ?? fallback;
}

/** The line: `queue:priority` first, then by the time each joined, then by number. */
export function order(prs) {
  const at = (p) => Date.parse(p.queuedAt) || 0;
  return [...prs].sort((a, b) => Number(b.priority) - Number(a.priority) || at(a) - at(b) || a.number - b.number);
}

/** Why a queued pull request cannot board now (it keeps its place), or null. */
export function waiting(pr) {
  if (pr.draft) return "it is a draft";
  if (pr.fork) return "it comes from a fork";
  if (pr.ci === "failure") return "CI Success is red on its last commit; push a fix";
  if (pr.ci !== "success") return "CI Success has not passed on its last commit yet";
  return null;
}

/** The next batch: the first pull requests of the line that can board, up to `max`. Nobody behind overtakes them. */
export const pickBatch = (line, max = MAX_BATCH) => line.filter((p) => !waiting(p)).slice(0, max);

/** After a red batch: the culprit (a batch of one), or the half to try now and the half that goes right after it. */
export function bisect(prs) {
  if (prs.length === 1) return { culprit: prs[0], first: [], second: [] };
  const half = Math.ceil(prs.length / 2);
  return { culprit: null, first: prs.slice(0, half), second: prs.slice(half) };
}

// The last mark counts: the train writes it after the members' titles, so a title can't stand in for it.
export const readState = (body) => {
  try {
    return JSON.parse([...(body ?? "").matchAll(STATE)].at(-1)?.[1] ?? "null");
  } catch {
    return null;
  }
};

/**
 * A batch is a pull request the train opened: from this repository, on a `batch/<base>-` branch, with its mark. Only
 * the mark is not enough, since anyone can write one in a pull request's body (a fork's head could be named `dev`).
 */
export const isBatch = (p, base) => !p.fork && p.branch.startsWith(`batch/${base}-`) && readState(p.body)?.base === base;

/** An epic's umbrella (or main) merges into its base with a merge commit, never squashed into a batch. */
const mergeCommitOnly = (p) => p.branch.startsWith("epic/") || p.branch === "main";

export function batchBody(base, baseSha, head, prs, next) {
  const state = { base, baseSha, head, prs: prs.map((p) => ({ number: p.number, sha: p.sha })), next: next.map((p) => p.number) };
  return [
    `The merge train lands these pull requests on \`${base}\` together, one commit each, in this order:`,
    "",
    ...prs.map((p) => `- #${p.number} ${p.title.replaceAll("<", "&lt;")}`),
    "",
    next.length ? `If this batch is green, ${next.map((p) => `#${p.number}`).join(" ")} go next (the other half of a red batch).` : "",
    "Green: it merges with the rebase method and the originals close as merged via this one. Red: it is split in halves until the pull request that breaks CI is found.",
    `<!-- merge-train:batch ${JSON.stringify(state)} -->`,
  ].join("\n");
}

export function positionText(base, pr, place, batch) {
  if (batch) return `${POSITION}\nMerge train: in batch #${batch} into \`${base}\`, waiting for its CI.`;
  const why = waiting(pr);
  return `${POSITION}\nMerge train: in line for \`${base}\`: **${ordinal(place)}**.${why ? ` Waiting: ${why}. It keeps its place.` : ""}`;
}

const conflictText = (base, reason) =>
  reason === "empty"
    ? `Merge train: this pull request has no changes left against \`${base}\`, so it left the line. Close it if it already landed.`
    : `Merge train: this pull request conflicts with \`${base}\` (or with the pull requests ahead of it), so it left the line. Rebase it onto \`origin/${base}\`, push, and add \`queue\` again once CI is green.`;

/**
 * One run of the train for one base. `gh` reads and writes GitHub, `git` builds and pushes batches (both are fakes
 * in the tests). In a dry run every write is logged instead. Returns the log and what happened.
 */
export async function tick({ gh, git, base, dry = false, stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14), also = [] }) {
  if (!BASE.test(base)) throw new Error(`Not a train base: ${JSON.stringify(base)}`);
  const log = [];
  const say = (line) => log.push(line);
  const w = dry ? dryWriter(gh, say) : gh;
  const done = { merged: [], failed: [], dropped: [], opened: [], closed: [] };
  const gone = new Set();

  const open = await gh.pulls(base);
  const batches = open.filter((p) => isBatch(p, base)).sort((a, b) => a.number - b.number);
  const queued = open.filter((p) => !isBatch(p, base) && (p.labels.includes(LABEL.queue) || also.includes(p.number)));
  for (const p of queued) {
    p.queuedAt = queuedAt(await gh.events(p.number), p.createdAt);
    p.priority = p.labels.includes(LABEL.priority);
    p.ci = ciState(await gh.checkRuns(p.sha));
  }
  const byNumber = new Map(queued.map((p) => [p.number, p]));
  const line = () => order(queued.filter((p) => !gone.has(p.number)));
  say(`${base}: ${queued.length} in line, ${batches.length} batch(es) open.`);

  const sticky = async (n) => (await gh.comments(n)).find((c) => (c.body ?? "").includes(POSITION));
  const leave = async (p, label, text) => {
    gone.add(p.number);
    if (label) await w.addLabel(p.number, label);
    for (const l of [LABEL.queue, LABEL.priority]) if (p.labels.includes(l)) await w.removeLabel(p.number, l);
    const s = await sticky(p.number);
    if (s) await w.deleteComment(s.id);
    await w.comment(p.number, text);
  };
  const retire = async (batch, text) => {
    await w.comment(batch.number, text);
    await w.closePull(batch.number);
    if (batch.branch.startsWith("batch/")) await w.deleteBranch(batch.branch);
    done.closed.push(batch.number);
  };

  /** Builds a batch from `prs` on the base's tip and opens its pull request; `next` waits behind it. */
  const board = async (prs, next = []) => {
    if (!prs.length) return null;
    const built = await git.build(base, prs);
    for (const { number, reason } of built.dropped) {
      say(`DROP #${number} (${reason})`);
      done.dropped.push(number);
      await leave(byNumber.get(number), reason === "empty" ? null : LABEL.conflict, conflictText(base, reason));
    }
    const aboard = prs.filter((p) => built.applied.includes(p.number));
    if (!aboard.length) return board(next);
    const branch = `batch/${base}-${stamp}`;
    await (dry ? say(`(dry run) would push ${built.sha.slice(0, 12)} to ${branch}`) : git.push(branch, built.sha));
    const title = `train: ${aboard.length} into ${base} (${aboard.map((p) => `#${p.number}`).join(" ")})`;
    const pr = await w.createPull({ base, head: branch, title, body: batchBody(base, built.baseSha, built.sha, aboard, next) });
    say(`OPEN #${pr.number} ${title}`);
    done.opened.push(pr.number);
    return { number: pr.number, branch, sha: built.sha, members: aboard };
  };

  for (const p of queued.filter(mergeCommitOnly)) {
    say(`DROP #${p.number} (merges with a merge commit)`);
    done.dropped.push(p.number);
    await leave(p, null, `Merge train: \`${p.branch}\` merges into \`${base}\` with a merge commit, never squashed into a batch, so it left the line; it lands by hand with a merge commit when it is ready.`);
  }

  let inFlight = null;
  for (const extra of batches.slice(1)) await retire(extra, "Merge train: one batch at a time per base; this one closes and its pull requests go back to the line.");
  const batch = batches[0];
  if (batch) {
    const state = readState(batch.body);
    const members = state.prs.map((s) => byNumber.get(s.number));
    const next = state.next.map((n) => byNumber.get(n)).filter((p) => p && !waiting(p));
    const ci = ciState(await gh.checkRuns(batch.sha));
    const changed = state.prs.filter((s, i) => !members[i] || members[i].sha !== s.sha);
    const tip = await gh.branchSha(base);
    say(`BATCH #${batch.number} [${state.prs.map((s) => `#${s.number}`).join(" ")}] CI ${ci}`);

    if (batch.sha !== state.head) {
      await retire(batch, "Merge train: this batch's branch holds a commit the train did not build, so it closes; its pull requests go back to the line.");
    } else if (changed.length) {
      await retire(batch, `Merge train: ${changed.map((s) => `#${s.number}`).join(" ")} changed or left the line, so this batch closes; the rest go back to the line.`);
    } else if (ci === "failure") {
      const { culprit, first, second } = bisect(members);
      await retire(batch, culprit ? `Merge train: CI Success failed with only #${culprit.number} on \`${base}\`.` : `Merge train: CI Success failed; trying ${first.map((p) => `#${p.number}`).join(" ")} first.`);
      if (culprit) {
        say(`FAILED #${culprit.number}`);
        done.failed.push(culprit.number);
        await leave(culprit, LABEL.failed, `Merge train: CI Success failed in batch #${batch.number}, with this pull request alone on \`${base}\`. Fix it, get it reviewed again, and add \`queue\` again.`);
      } else {
        inFlight = await board(first, second);
      }
    } else if (tip !== state.baseSha) {
      await retire(batch, `Merge train: \`${base}\` moved, so this batch is rebuilt on its new tip.`);
      inFlight = await board(members, next);
    } else if (ci === "success") {
      const r = await w.merge(batch.number, batch.sha);
      if (!r.ok) {
        say(`::warning::Could not merge #${batch.number}: ${r.message}`);
        inFlight = { number: batch.number, members };
      } else {
        say(`MERGED #${batch.number}`);
        await w.deleteBranch(batch.branch);
        for (const p of members) {
          done.merged.push(p.number);
          await leave(p, null, `Merged via #${batch.number}.`);
          await w.closePull(p.number);
        }
        inFlight = await board(next);
      }
    } else {
      if (ci === "none") say(`::warning::CI has not started on batch #${batch.number}.`);
      inFlight = { number: batch.number, members };
    }
  }
  if (!inFlight) inFlight = await board(pickBatch(line()));

  const aboard = new Set(inFlight?.members.map((p) => p.number) ?? []);
  let place = 0;
  for (const p of line()) {
    const text = aboard.has(p.number) ? positionText(base, p, 0, inFlight.number) : positionText(base, p, ++place);
    if (!p.labels.includes(LABEL.queue)) continue; // --also: pretended, never commented on
    const s = await sticky(p.number);
    if (!s) await w.comment(p.number, text);
    else if (s.body !== text) await w.editComment(s.id, text);
  }
  say(inFlight ? `IN FLIGHT #${inFlight.number}` : "Nothing to board.");
  return { log, ...done, inFlight: inFlight?.number ?? null };
}

/** Logs every write a run would make, and changes nothing. */
function dryWriter(gh, say) {
  let n = 0;
  const would = (what) => say(`(dry run) would ${what}`);
  return {
    addLabel: async (num, l) => would(`label #${num} ${l}`),
    removeLabel: async (num, l) => would(`unlabel #${num} ${l}`),
    comment: async (num, body) => would(`comment on #${num}: ${body.replace(POSITION, "").trim().split("\n")[0]}`),
    editComment: async (id, body) => would(`edit comment ${id}: ${body.replace(POSITION, "").trim()}`),
    deleteComment: async (id) => would(`delete comment ${id}`),
    closePull: async (num) => would(`close #${num}`),
    deleteBranch: async (b) => would(`delete branch ${b}`),
    createPull: async ({ title }) => (would(`open a pull request "${title}"`), { number: `new${++n}` }),
    merge: async (num, sha) => (would(`merge #${num} at ${sha.slice(0, 12)} (rebase)`), { ok: true }),
  };
}

// --------------------------------------------------------------------------------------------------------------------

/** GitHub over REST (the shared GraphQL quota stays free). */
export function restLayer(token, repo) {
  const api = async (method, path, body) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 200) }; // an HTML error page (a 502): keep the status readable
    }
    return { ok: r.ok, status: r.status, data };
  };
  const must = async (method, path, body) => {
    const r = await api(method, path, body);
    if (!r.ok && !(method === "DELETE" && r.status === 404)) throw new Error(`${method} ${path}: HTTP ${r.status} ${r.data?.message ?? ""}`);
    return r.data;
  };
  const all = async (path) => {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const data = await must("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const list = Array.isArray(data) ? data : data.check_runs;
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  };
  const pull = (p) => ({
    number: p.number,
    title: p.title,
    body: p.body,
    draft: p.draft,
    sha: p.head.sha,
    branch: p.head.ref,
    fork: p.head.repo?.full_name !== repo,
    labels: p.labels.map((l) => l.name),
    createdAt: p.created_at,
  });
  return {
    pulls: async (base) => (await all(`/pulls?state=open&base=${encodeURIComponent(base)}`)).map(pull),
    events: (n) => all(`/issues/${n}/events`),
    checkRuns: (sha) => all(`/commits/${sha}/check-runs?filter=latest`),
    comments: (n) => all(`/issues/${n}/comments`),
    branchSha: async (base) => (await must("GET", `/git/ref/heads/${base}`)).object.sha,
    comment: (n, body) => must("POST", `/issues/${n}/comments`, { body }),
    editComment: (id, body) => must("PATCH", `/issues/comments/${id}`, { body }),
    deleteComment: (id) => must("DELETE", `/issues/comments/${id}`),
    addLabel: (n, label) => must("POST", `/issues/${n}/labels`, { labels: [label] }),
    removeLabel: (n, label) => must("DELETE", `/issues/${n}/labels/${encodeURIComponent(label)}`),
    closePull: (n) => must("PATCH", `/pulls/${n}`, { state: "closed" }),
    deleteBranch: (branch) => must("DELETE", `/git/refs/heads/${branch}`),
    createPull: ({ base, head, title, body }) => must("POST", "/pulls", { base, head, title, body }),
    merge: async (n, sha) => {
      const r = await api("PUT", `/pulls/${n}/merge`, { merge_method: "rebase", sha });
      return { ok: r.ok, message: `HTTP ${r.status} ${r.data?.message ?? ""}` };
    },
  };
}

/** Builds batches in a temporary worktree of the repository in `cwd`, from `remote`'s refs. */
export function gitLayer({ cwd = process.cwd(), remote = "origin" } = {}) {
  let dir = null;
  const git = (args, at = dir ?? cwd) => execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let who = null; // a runner without a git identity commits as the train (GitHub sets the committer on merge anyway)
  const identity = () => {
    if (who) return who;
    try {
      git(["config", "user.email"], cwd);
      who = [];
    } catch {
      who = ["-c", "user.name=merge-train", "-c", "user.email=merge-train@users.noreply.github.com"];
    }
    return who;
  };
  const fetch = (refspecs) => {
    for (let i = 0; ; i++) {
      try {
        return git(["fetch", "-q", "--no-tags", remote, ...refspecs], cwd);
      } catch (e) {
        if (i === 2) throw e; // other sessions fetch the same repo: "cannot lock ref" passes on a retry
      }
    }
  };
  return {
    async build(base, prs) {
      fetch([`+refs/heads/${base}:refs/merge-train/base`, ...prs.map((p) => `+refs/pull/${p.number}/head:refs/merge-train/pr-${p.number}`)]);
      const baseSha = git(["rev-parse", "refs/merge-train/base"], cwd);
      if (!dir) {
        dir = mkdtempSync(join(tmpdir(), "merge-train-"));
        git(["worktree", "add", "-q", "--detach", dir, baseSha], cwd);
      }
      git(["reset", "-q", "--hard", baseSha]);
      const applied = [];
      const dropped = [];
      for (const p of prs) {
        const ref = `refs/merge-train/pr-${p.number}`;
        try {
          git(["merge", "-q", "--squash", ref]);
        } catch {
          git(["reset", "-q", "--hard", "HEAD"]);
          dropped.push({ number: p.number, reason: "conflict" });
          continue;
        }
        if (!git(["status", "--porcelain"])) {
          dropped.push({ number: p.number, reason: "empty" });
          continue;
        }
        const author = git(["log", "-1", "--format=%an <%ae>", ref]);
        const commits = git(["log", "--reverse", "--format=* %s", `HEAD..${ref}`]);
        git([...identity(), "commit", "-q", "--no-verify", `--author=${author}`, "-m", `${p.title} (#${p.number})`, ...(commits ? ["-m", commits] : [])]);
        applied.push(p.number);
      }
      return { baseSha, sha: git(["rev-parse", "HEAD"]), applied, dropped };
    },
    async push(branch, sha) {
      git(["push", "-q", "--force", remote, `${sha}:refs/heads/${branch}`], cwd);
    },
    close() {
      if (dir) git(["worktree", "remove", "--force", dir], cwd);
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
      for (const ref of git(["for-each-ref", "--format=%(refname)", "refs/merge-train/"], cwd).split("\n").filter(Boolean)) git(["update-ref", "-d", ref], cwd);
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const { GH_TOKEN, GITHUB_REPOSITORY: repo = "MiguelMedeiros/ghostly" } = process.env;
  if (!args.includes("--dry-run")) throw new Error("Only --dry-run for now: it reads the repo and changes nothing.");
  if (!GH_TOKEN) throw new Error("GH_TOKEN is required");
  const also = (opt("--also") ?? "").split(",").filter(Boolean).map(Number);
  const git = gitLayer();
  try {
    const result = await tick({ gh: restLayer(GH_TOKEN, repo), git, base: opt("--base") ?? "dev", dry: true, also });
    for (const line of result.log) console.log(line);
  } finally {
    git.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
