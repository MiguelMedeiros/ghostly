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
// - One pull request alone (the next batch would hold only it) skips the batch: when its head already holds the base's
//   tip and CI Success is green on it, the train merges the pull request itself (dev: the rebase merge at that head;
//   an epic: a fast-forward), with no batch and no new CI run. When it is behind, the train rebases its branch onto the
//   tip (a push with --force-with-lease, so an author's push wins), waits for CI on exactly that commit, and merges it
//   the same way. Red there gets one more run on a fresh rebase, then `queue:failed`; a conflict, `queue:conflict`. A
//   fork, or a head branch the train must never push to (dev, main, an epic, a batch), goes the batch way.
// - Each queued pull request keeps one comment that says where it is ("In line for `dev`: 3rd").
//
// The train keeps no state of its own: a batch's members and the half that waits after it live in a hidden mark in
// the batch's body, the commit a lone pull request was rebased to lives in a hidden mark of its position comment, and
// everything else is read again each run.
//
//   node tools/scripts/merge-train.mjs --run | --dry-run | --list-bases  [--base dev] [--every 120] [--also 12,34]
//
// .github/workflows/merge-queue.yml runs it with the queue app's token (GH_TOKEN); pushes made with the workflow's own
// GITHUB_TOKEN would start no CI. Until that app exists a Mac runs it with its gh login (`gh auth token` when GH_TOKEN
// is unset) and its git credentials for `origin`; --every <seconds> repeats the run. Without --base the workflow runs
// every base that has a queued pull request or a batch open (--list-bases prints them as JSON), and a Mac runs `dev`
// and every `epic/*` branch, logging them each round. Every request and git call has a timeout, and a round that runs
// past ROUND_DEADLINE is cut and logged, so the loop never stalls silently. --dry-run reads the live repo,
// builds batches in a temporary worktree (never pushed) and prints what it would do; it changes nothing on GitHub.
// --also pretends the listed pull requests carry `queue` (dry runs only). GITHUB_REPOSITORY defaults to this repo.
// tools/scripts/test/merge-train.test.ts drives the train through a fake GitHub and git.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LABEL = { queue: "queue", priority: "queue:priority", conflict: "queue:conflict", failed: "queue:failed" };
export const MAX_BATCH = 5;
const POSITION = "<!-- merge-train:position -->";
const HEAD = /<!-- merge-train:head (\w+) -->/;
const STATE = /<!-- merge-train:batch (\{.*?\}) -->/g;
const ALONE = /<!-- merge-train:alone (\{.*?\}) -->/;
/** The bases a train runs for; anything else never reaches a URL path, a refspec or a branch name. */
export const BASE = /^(dev|epic\/[A-Za-z0-9._-]+)$/;
/** A batch whose CI has not started after this long (the GITHUB_TOKEN trap, a lost event) is rebuilt. */
export const CI_START_TIMEOUT = 20 * 60_000;
/** One REST request (each attempt), one git call, and one round of every base: past these they fail and are logged. */
export const REQUEST_TIMEOUT = 30_000;
export const GIT_TIMEOUT = 5 * 60_000;
export const ROUND_DEADLINE = 15 * 60_000;

/**
 * CI on one commit, from its check runs: "success", "failure", "pending" (CI Success has not finished, or has no run
 * yet while other checks run) or "none" (nothing ran: CI never started). A rerun adds a run with the same name, so
 * the newest counts; a draft's gate "CI Success (draft)" does not count.
 */
export function ciState(runs) {
  const newest = (a, b) => (Date.parse(b.started_at ?? 0) || 0) - (Date.parse(a.started_at ?? 0) || 0) || (b.id ?? 0) - (a.id ?? 0);
  const gate = runs.filter((r) => r.name === "CI Success").sort(newest)[0];
  const running = runs.some((r) => r.status !== "completed");
  if (!gate) return running ? "pending" : "none";
  if (gate.status !== "completed") return "pending";
  if (gate.conclusion === "success") return "success";
  // A run cancelled by a newer one (a push, a rerun) says nothing about the commit until the newer one ends.
  if (gate.conclusion === "cancelled" || gate.conclusion === "skipped") return running ? "pending" : "none";
  return "failure";
}

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

export function batchBody(base, baseSha, head, prs, next, extra = {}) {
  const state = { base, baseSha, head, prs: prs.map((p) => ({ number: p.number, sha: p.sha })), next: next.map((p) => p.number), ...extra };
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

/**
 * The comment that says where a pull request is. It also records the head the train first saw queued (`head`) and,
 * while the train lands it alone, the commit it rebased it to (`alone`: sha, baseSha, at, retried).
 */
export function positionText(base, pr, place, batch, head = pr.sha, alone = null) {
  const mark = `<!-- merge-train:head ${head} -->`;
  if (alone) {
    const again = alone.retried ? " (a second run, after a red one)" : "";
    return `${POSITION}${mark}<!-- merge-train:alone ${JSON.stringify(alone)} -->\nMerge train: next into \`${base}\`, alone. Rebased onto \`${base}\` (${alone.baseSha.slice(0, 12)}), waiting for CI Success on ${alone.sha.slice(0, 12)}${again}.`;
  }
  if (batch) return `${POSITION}${mark}\nMerge train: in batch #${batch} into \`${base}\`, waiting for its CI.`;
  const why = waiting(pr);
  return `${POSITION}${mark}\nMerge train: in line for \`${base}\`: **${ordinal(place)}**.${why ? ` Waiting: ${why}. It keeps its place.` : ""}`;
}

/** The head a pull request had when the train first saw it queued (the reviewed one), from its position comment. */
export const queuedHead = (sticky) => sticky?.body?.match(HEAD)?.[1] ?? null;

const newCommitsText = (what) =>
  `Merge train: this pull request got new commits after it was queued (${what}), so it left the line. Add \`queue\` again once this head is reviewed and green.`;

/** The commit the train rebased a lone pull request to, from its position comment: { sha, baseSha, at, retried }. */
export const aloneMark = (sticky) => {
  try {
    const m = JSON.parse(sticky?.body?.match(ALONE)?.[1] ?? "null");
    return typeof m?.sha === "string" && typeof m.baseSha === "string" ? m : null;
  } catch {
    return null;
  }
};

/** Whether the train may land a pull request alone: its head is a branch of this repository it may rebase and push. */
export const canGoAlone = (p) => !p.fork && !BASE.test(p.branch) && p.branch !== "main" && !p.branch.startsWith("batch/");

const conflictText = (base, reason) =>
  reason === "empty"
    ? `Merge train: this pull request has no changes left against \`${base}\`, so it left the line. Close it if it already landed.`
    : `Merge train: this pull request conflicts with \`${base}\` (or with the pull requests ahead of it), so it left the line. Rebase it onto \`origin/${base}\`, push, and add \`queue\` again once CI is green.`;

/**
 * One run of the train for one base. `gh` reads and writes GitHub, `git` builds and pushes batches (both are fakes
 * in the tests). In a dry run every write is logged instead. Returns the log and what happened.
 */
export async function tick({ gh, git, base, login, dry = false, stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14), also = [], now = Date.now(), log = [] }) {
  if (!BASE.test(base)) throw new Error(`Not a train base: ${JSON.stringify(base)}`);
  // The train's own GitHub login: only its comments count as position comments (anyone can write the marks).
  if (!login) throw new Error("The train's own login is required");
  const say = (line) => log.push(line);
  const w = dry ? dryWriter(gh, say) : gh;
  const done = { merged: [], failed: [], dropped: [], opened: [], closed: [] };
  const gone = new Set();

  const open = await gh.pulls(base);
  const batches = open.filter((p) => isBatch(p, base)).sort((a, b) => a.number - b.number);
  const queued = open.filter((p) => !isBatch(p, base) && (p.labels.includes(LABEL.queue) || also.includes(p.number)));
  for (const p of queued) {
    const events = await gh.events(p.number);
    p.queuedAt = queuedAt(events, p.createdAt);
    p.priority = p.labels.includes(LABEL.priority);
    p.ci = ciState(await gh.checkRuns(p.sha));
    p.sticky = (await gh.comments(p.number)).find((c) => c.user?.login === login && (c.body ?? "").includes(POSITION));
    p.alone = aloneMark(p.sticky);
    // No position comment records the queued head yet: tell it by time, the head's first CI against the label.
    if (!p.sticky && p.labels.includes(LABEL.queue)) {
      p.labeledAt = queuedAt(events, null);
      p.pushedAt = await gh.headPushedAt(p.sha);
    }
  }
  const byNumber = new Map(queued.map((p) => [p.number, p]));
  const line = () => order(queued.filter((p) => !gone.has(p.number)));
  say(`${base}: ${queued.length} in line, ${batches.length} batch(es) open.`);

  const leave = async (p, label, text) => {
    gone.add(p.number);
    if (label) await w.addLabel(p.number, label);
    for (const l of Object.values(LABEL)) if (l !== label && p.labels.includes(l)) await w.removeLabel(p.number, l);
    if (p.sticky) await w.deleteComment(p.sticky.id);
    if (text) await w.comment(p.number, text);
  };
  /** Posts or edits a pull request's position comment, and keeps the copy read at the start of the run current. */
  const setSticky = async (p, text) => {
    if (!p.labels.includes(LABEL.queue)) return; // --also: pretended, never commented on
    if (!p.sticky) p.sticky = { id: (await w.comment(p.number, text))?.id, body: text };
    else if (p.sticky.body !== text) {
      await w.editComment(p.sticky.id, text);
      p.sticky = { ...p.sticky, body: text };
    }
  };
  // Closed first: a run that stops before the labels are off leaves a closed pull request, never an open one out of line.
  const landed = async (p, batch) => {
    done.merged.push(p.number);
    await w.closePull(p.number);
    await leave(p, null, `Merged via #${batch}.`);
  };
  const retire = async (batch, text) => {
    await w.comment(batch.number, text);
    await w.closePull(batch.number);
    if (batch.branch.startsWith("batch/")) await w.deleteBranch(batch.branch);
    done.closed.push(batch.number);
  };

  /** Builds a batch from `prs` on the base's tip and opens its pull request; `next` waits behind it. */
  const board = async (prs, next = [], extra = {}) => {
    if (!prs.length) return null;
    const built = await git.build(base, prs);
    for (const { number, reason } of built.dropped) {
      say(`DROP #${number} (${reason})`);
      // Pushed to after its CI was read: not built now, and on the next run its new head no longer matches the head in
      // its position comment, so it leaves the line until it is reviewed and queued again.
      if (reason === "moved") continue;
      done.dropped.push(number);
      await leave(byNumber.get(number), reason === "empty" ? null : LABEL.conflict, conflictText(base, reason));
    }
    const aboard = prs.filter((p) => built.applied.includes(p.number));
    if (!aboard.length) return board(next);
    const branch = `batch/${base}-${stamp}`;
    await (dry ? say(`(dry run) would push ${built.sha.slice(0, 12)} to ${branch}`) : git.push(branch, built.sha));
    const title = `train: ${aboard.length} into ${base} (${aboard.map((p) => `#${p.number}`).join(" ")})`;
    const pr = await w.createPull({ base, head: branch, title, body: batchBody(base, built.baseSha, built.sha, aboard, next, extra) });
    say(`OPEN #${pr.number} ${title}`);
    done.opened.push(pr.number);
    return { number: pr.number, branch, sha: built.sha, members: aboard };
  };

  // A run that stopped after landing a batch (a crash, the API budget) left its originals open: close them now.
  for (const b of (await gh.mergedPulls(base)).filter((p) => isBatch(p, base))) {
    for (const s of readState(b.body).prs) {
      const p = byNumber.get(s.number);
      if (p && p.sha === s.sha && !gone.has(p.number)) await landed(p, b.number);
    }
  }

  for (const p of queued.filter((p) => !gone.has(p.number))) {
    if (mergeCommitOnly(p)) {
      say(`DROP #${p.number} (merges with a merge commit)`);
      done.dropped.push(p.number);
      await leave(p, null, `Merge train: \`${p.branch}\` merges into \`${base}\` with a merge commit, never squashed into a batch, so it left the line; it lands by hand with a merge commit when it is ready.`);
    } else if (queuedHead(p.sticky) && queuedHead(p.sticky) !== p.sha && p.alone?.sha !== p.sha) {
      // `queue` vouches for the head that was reviewed (or the train's own rebase of it): a later push needs a new review.
      say(`DROP #${p.number} (new head since it was queued)`);
      done.dropped.push(p.number);
      await leave(p, null, newCommitsText(`${queuedHead(p.sticky).slice(0, 12)} → ${p.sha.slice(0, 12)}`));
    } else if (!p.sticky && p.labeledAt && p.pushedAt && Date.parse(p.pushedAt) > Date.parse(p.labeledAt)) {
      // A push in the window between the label and the train's first read: `queue` vouched for an earlier head.
      say(`DROP #${p.number} (head pushed after it was queued)`);
      done.dropped.push(p.number);
      await leave(p, null, newCommitsText(`${p.sha.slice(0, 12)} was pushed after \`queue\` was added`));
    }
  }

  let inFlight = null;
  for (const extra of batches.slice(1)) await retire(extra, "Merge train: one batch at a time per base; this one closes and its pull requests go back to the line.");
  const batch = batches[0];
  if (batch) {
    const state = readState(batch.body);
    const members = state.prs.map((s) => (gone.has(s.number) ? undefined : byNumber.get(s.number)));
    const next = state.next.map((n) => byNumber.get(n)).filter((p) => p && !gone.has(p.number) && !waiting(p));
    const ci = ciState(await gh.checkRuns(batch.sha));
    const changed = state.prs.filter((s, i) => !members[i] || members[i].sha !== s.sha);
    const tip = await gh.branchSha(base);
    const baseCi = ci === "failure" ? ciState(await gh.checkRuns(state.baseSha)) : null;
    const stay = { number: batch.number, members };
    say(`BATCH #${batch.number} [${state.prs.map((s) => `#${s.number}`).join(" ")}] CI ${ci}`);

    if (batch.sha !== state.head) {
      await retire(batch, "Merge train: this batch's branch holds a commit the train did not build, so it closes; its pull requests go back to the line.");
    } else if (changed.length) {
      await retire(batch, `Merge train: ${changed.map((s) => `#${s.number}`).join(" ")} changed or left the line, so this batch closes; the rest go back to the line.`);
    } else if (tip !== state.baseSha) {
      // Red on an old tip says nothing about the batch on the new one, and green on an old tip must not land.
      await retire(batch, `Merge train: \`${base}\` moved, so this batch is rebuilt on its new tip.`);
      inFlight = await board(members, next, { retried: state.retried });
    } else if (ci === "failure" && (baseCi === "failure" || baseCi === "pending")) {
      say(`HOLD #${batch.number}: CI Success on \`${base}\` itself is ${baseCi === "failure" ? "red" : "still running"}; nobody is blamed until it is green.`);
      inFlight = stay;
    } else if (ci === "failure") {
      const { culprit, first, second } = bisect(members);
      if (culprit && !state.retried) {
        // One rerun before blaming a single pull request: a flake should not cost its author a review round.
        await retire(batch, `Merge train: CI Success failed with only #${culprit.number} on \`${base}\`; trying once more before calling it.`);
        inFlight = await board([culprit], [], { retried: true });
      } else {
        await retire(batch, culprit ? `Merge train: CI Success failed twice with only #${culprit.number} on \`${base}\`.` : `Merge train: CI Success failed; trying ${first.map((p) => `#${p.number}`).join(" ")} first.`);
        if (culprit) {
          say(`FAILED #${culprit.number}`);
          done.failed.push(culprit.number);
          await leave(culprit, LABEL.failed, `Merge train: CI Success failed twice in a batch with only this pull request on \`${base}\` (last: #${batch.number}). Fix it, get it reviewed again, and add \`queue\` again.`);
        } else {
          inFlight = await board(first, second);
        }
      }
    } else if (ci === "success") {
      // dev: the rebase merge, which its strict ruleset refuses unless the batch is up to date and green. An epic has
      // no ruleset, so it lands by a fast-forward push of the tested commits: the push fails if the epic moved since.
      const r =
        base === "dev" ? await w.merge(batch.number, batch.sha) : dry ? (say(`(dry run) would fast-forward ${base} to ${batch.sha.slice(0, 12)}`), { ok: true }) : await git.land(base, batch.sha);
      if (!r.ok) {
        say(`::warning::Could not land #${batch.number}: ${r.message}`);
        inFlight = stay;
      } else {
        say(`MERGED #${batch.number}`);
        await w.deleteBranch(batch.branch);
        for (const p of members) await landed(p, batch.number);
        inFlight = await board(next);
      }
    } else if (ci === "none" && now - Date.parse(batch.createdAt) > CI_START_TIMEOUT) {
      await retire(batch, "Merge train: CI never started on this batch, so it is rebuilt.");
      inFlight = await board(members, next, { retried: state.retried });
    } else {
      if (ci === "none") say(`::warning::CI has not started on batch #${batch.number} yet.`);
      inFlight = stay;
    }
  }
  // One pull request alone, with no batch. Each step returns what is in flight now, `null` when the pull request landed
  // or left the line (so the next one may go), or `false` when nothing more boards in this run.

  /** Merges a lone pull request at its head: dev by the rebase merge (refused unless up to date and green), an epic by a fast-forward. */
  const landAlone = async (p) => {
    const r =
      base === "dev" ? await w.merge(p.number, p.sha) : dry ? (say(`(dry run) would fast-forward ${base} to ${p.sha.slice(0, 12)}`), { ok: true }) : await git.landPull(base, p.number, p.sha);
    if (r.ok) {
      say(`MERGED #${p.number} alone`);
      done.merged.push(p.number);
      // Merged already (an epic's pull request shows as merged once the epic holds its head): only the labels and the
      // position comment go.
      await leave(p, null, null);
    }
    return r;
  };

  /**
   * The next pull request, alone: merged at once when its head holds the base's tip and is green, else rebased onto
   * the tip and pushed for CI. `rerun` rebases even when nothing moved (a fresh commit for a second CI run).
   */
  const goAlone = async (p, { retried = false, rerun = false } = {}) => {
    const tip = await gh.branchSha(base);
    if (!rerun && p.ci === "success" && (await gh.behindBy(tip, p.sha)) === 0) {
      const r = await landAlone(p);
      if (r.ok) return null;
      // Refused while up to date and green (GitHub calls some rebases unsafe): the squash of a batch always applies.
      say(`::warning::Could not merge #${p.number} alone: ${r.message}; it goes the batch way.`);
      return (await board([p])) ?? false;
    }
    const built = await git.rebase(base, p, { force: rerun });
    if (built.dropped) {
      say(`DROP #${p.number} (${built.dropped})`);
      if (built.dropped === "moved") return false; // pushed after its CI was read: the next run reads it again
      done.dropped.push(p.number);
      await leave(p, built.dropped === "empty" ? null : LABEL.conflict, conflictText(base, built.dropped));
      return null;
    }
    // The mark goes first: a run that stops before the push leaves the reviewed head with a mark naming a commit it
    // never got, which the next run reads as nothing in flight.
    p.alone = { sha: built.sha, baseSha: built.baseSha, at: new Date(now).toISOString(), retried };
    await setSticky(p, positionText(base, p, 0, 0, queuedHead(p.sticky) ?? p.sha, p.alone));
    say(`ALONE #${p.number}: rebased onto ${built.baseSha.slice(0, 12)} as ${built.sha.slice(0, 12)}${retried ? " (second run)" : ""}`);
    if (built.sha !== p.sha) {
      const pushed = dry ? (say(`(dry run) would push ${built.sha.slice(0, 12)} to ${p.branch} (lease ${p.sha.slice(0, 12)})`), { ok: true }) : await git.pushHead(p.branch, built.sha, p.sha);
      if (!pushed.ok) say(`::warning::Could not push the rebase of #${p.number}: ${pushed.message}`);
    }
    return { number: p.number, members: [p], alone: true };
  };

  /** A lone pull request the train rebased and waits on: its head is the commit its mark names. */
  const flyAlone = async (p) => {
    const mark = p.alone;
    const stay = { number: p.number, members: [p], alone: true };
    const tip = await gh.branchSha(base);
    say(`ALONE #${p.number} at ${p.sha.slice(0, 12)} CI ${p.ci}`);
    // Red on an old tip says nothing about the new one, and green on an old tip must not land.
    if (tip !== mark.baseSha) return goAlone(p, { retried: mark.retried });
    if (p.ci === "failure") {
      const baseCi = ciState(await gh.checkRuns(mark.baseSha));
      if (baseCi === "failure" || baseCi === "pending") {
        say(`HOLD #${p.number}: CI Success on \`${base}\` itself is ${baseCi === "failure" ? "red" : "still running"}; nobody is blamed until it is green.`);
        return stay;
      }
      // One more run before blaming it: a flake should not cost its author a review round.
      if (!mark.retried) return goAlone(p, { retried: true, rerun: true });
      say(`FAILED #${p.number}`);
      done.failed.push(p.number);
      await leave(p, LABEL.failed, `Merge train: CI Success failed twice with only this pull request on \`${base}\` (last: ${p.sha.slice(0, 12)}). Fix it, get it reviewed again, and add \`queue\` again.`);
      return null;
    }
    if (p.ci === "success") {
      const r = await landAlone(p);
      if (r.ok) return null;
      say(`::warning::Could not land #${p.number}: ${r.message}`);
      return stay;
    }
    if (p.ci === "none" && now - Date.parse(mark.at) > CI_START_TIMEOUT) {
      say(`CI never started on #${p.number} at ${p.sha.slice(0, 12)}, so it is rebased again.`);
      return goAlone(p, { retried: mark.retried, rerun: true });
    }
    if (p.ci === "none") say(`::warning::CI has not started on #${p.number} at ${p.sha.slice(0, 12)} yet.`);
    return stay;
  };

  if (!inFlight) {
    const lone = line().find((p) => p.alone?.sha === p.sha);
    if (lone) inFlight = await flyAlone(lone);
  }
  while (inFlight === null || inFlight === undefined) {
    const next = pickBatch(line());
    if (next.length === 1 && canGoAlone(next[0])) inFlight = await goAlone(next[0]);
    else inFlight = (await board(next)) ?? false;
  }
  inFlight ||= null;

  const aboard = new Set(inFlight?.members.map((p) => p.number) ?? []);
  let place = 0;
  for (const p of line()) {
    // Whoever is still in line passed the head checks above: its head is the one `queue` (or the train) vouches for.
    const text =
      inFlight?.alone && inFlight.number === p.number
        ? positionText(base, p, 0, 0, queuedHead(p.sticky) ?? p.sha, p.alone)
        : aboard.has(p.number)
          ? positionText(base, p, 0, inFlight.number, p.sha)
          : positionText(base, p, ++place, 0, p.sha);
    if (!p.sticky && p.pushedAt === null) continue; // no CI on its head yet: its comment would record a head of unknown age
    await setSticky(p, text);
  }
  say(inFlight ? `IN FLIGHT #${inFlight.number}${inFlight.alone ? " (alone)" : ""}` : "Nothing to board.");
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

/** Whether one merge-queue run's jobs show the workflow's own train: a train job running or done, or the app configured. */
export const appTrainIn = (jobs) =>
  jobs.some(
    (j) =>
      (j.name.startsWith("Train into") && (j.status === "in_progress" || (j.status === "completed" && j.conclusion !== "skipped"))) ||
      (j.name === "Bases with a train" && (j.steps ?? []).some((s) => s.name === "Checkout the script" && s.conclusion === "success")),
  );

/** Thrown when the token's REST budget runs low: the run stops, and the next one goes on from what GitHub shows. */
export class BudgetLow extends Error {}

/**
 * GitHub over REST (the shared GraphQL quota stays free). A request that fails to connect (a reset, DNS after a Mac
 * wakes), a 5xx, a 429 or a rate-limited 403 (primary, or secondary with `Retry-After`) is retried with backoff;
 * below `budget` calls left the run stops. An attempt with no answer within `timeout` counts as one that failed to
 * connect; once `signal` aborts (the round's deadline), every request fails at once. A POST retried after a 5xx that
 * GitHub did carry out can leave a second comment, or a 422 "already exists" that fails this run; the next run goes on
 * from GitHub's state. `wait`, `fetchImpl` and `timeout` are injectable for the tests.
 */
export function restLayer(token, repo, { budget = 100, wait = (ms) => new Promise((r) => setTimeout(r, ms)), fetchImpl = fetch, timeout = REQUEST_TIMEOUT, signal } = {}) {
  const backoff = (attempt, after) => wait(Math.min(60, Number(after) || 2 ** attempt * 5) * 1000);
  const api = async (method, path, body) => {
    const named = (e) => (e?.name === "TimeoutError" ? new Error(`${method} ${path}: no answer within ${timeout / 1000} s`) : e);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      // The timeout covers the body too: a reply that stalls half way fails instead of hanging the run.
      const cut = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
      let r;
      try {
        r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
          body: body ? JSON.stringify(body) : undefined,
          signal: cut,
        });
      } catch (e) {
        if (attempt >= 3 || signal?.aborted) throw named(e);
        await backoff(attempt);
        continue;
      }
      const left = Number(r.headers.get("x-ratelimit-remaining") ?? Infinity);
      const limited = r.status === 429 || (r.status === 403 && (left === 0 || r.headers.has("retry-after")));
      if ((r.status >= 500 || limited) && attempt < 3) {
        await backoff(attempt, r.headers.get("retry-after"));
        continue;
      }
      if (left < budget) throw new BudgetLow(`GitHub API budget low (${left} calls left); stopping this run`);
      const text = await r.text().catch((e) => Promise.reject(named(e)));
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { message: text.slice(0, 200) }; // an HTML error page (a 502): keep the status readable
      }
      return { ok: r.ok, status: r.status, data };
    }
  };
  const must = async (method, path, body) => {
    const r = await api(method, path, body);
    if (!r.ok && !(method === "DELETE" && (r.status === 404 || r.status === 422))) throw new Error(`${method} ${path}: HTTP ${r.status} ${r.data?.message ?? ""}`);
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
    base: p.base.ref,
  });
  return {
    pulls: async (base) => (await all(`/pulls?state=open${base ? `&base=${encodeURIComponent(base)}` : ""}`)).map(pull),
    /** The last pull requests merged into `base` (one page): where a run that stopped half way finds its batch. */
    mergedPulls: async (base) =>
      (await must("GET", `/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=20`)).filter((p) => p.merged_at).map(pull),
    /**
     * Whether the workflow runs the train, so a Mac must not run a second one: a train job is running or ran, or a
     * recent run found the queue app configured (its "Checkout the script" step runs only then), queue empty or not.
     */
    appTrainRuns: async () => {
      const { workflow_runs: runs } = await must("GET", "/actions/workflows/merge-queue.yml/runs?per_page=10");
      for (const run of runs) {
        const { jobs } = await must("GET", `/actions/runs/${run.id}/jobs`);
        if (appTrainIn(jobs)) return true;
      }
      return false;
    },
    /** Every `epic/*` branch: the bases a Mac serves besides `dev`. */
    epicBranches: async () => (await must("GET", "/git/matching-refs/heads/epic/")).map((r) => r.ref.replace("refs/heads/", "")),
    events: (n) => all(`/issues/${n}/events`),
    checkRuns: (sha) => all(`/commits/${sha}/check-runs?filter=latest`),
    /** When a commit was pushed: its earliest check suite (GitHub makes them on the push), or null before any. */
    headPushedAt: async (sha) => (await must("GET", `/commits/${sha}/check-suites?per_page=100`)).check_suites.map((s) => s.created_at).sort()[0] ?? null,
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
    /** How many commits of `baseSha` the commit `headSha` lacks: 0 when it already holds them (a rebase merge rewrites nothing). */
    behindBy: async (baseSha, headSha) => (await must("GET", `/compare/${baseSha}...${headSha}?per_page=1`)).behind_by,
  };
}

/**
 * Builds batches in a temporary worktree of the repository in `cwd`, from `remote`'s refs. A git call that runs past
 * `timeout` is killed and throws; once `signal` aborts (the round's deadline), nothing more is built, pushed or landed.
 */
export function gitLayer({ cwd = process.cwd(), remote = "origin", timeout = GIT_TIMEOUT, signal } = {}) {
  let dir = null;
  const git = (args, at = dir ?? cwd) => {
    try {
      return execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
    } catch (e) {
      if (e.code === "ETIMEDOUT") e.message = `git ${args[0]}: no answer within ${timeout / 1000} s`;
      throw e;
    }
  };
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
        if (i === 2 || e.code === "ETIMEDOUT") throw e; // other sessions fetch the same repo: "cannot lock ref" passes on a retry
      }
    }
  };
  // Refs of this run only: another run in the same clone never sees or deletes them.
  const ns = `refs/merge-train/${process.pid}-${Date.now()}`;
  return {
    async build(base, prs) {
      signal?.throwIfAborted();
      fetch([`+refs/heads/${base}:${ns}/base`, ...prs.map((p) => `+refs/pull/${p.number}/head:${ns}/pr-${p.number}`)]);
      const baseSha = git(["rev-parse", `${ns}/base`], cwd);
      if (!dir) {
        dir = mkdtempSync(join(tmpdir(), "merge-train-"));
        git(["worktree", "add", "-q", "--detach", dir, baseSha], cwd);
      }
      git(["reset", "-q", "--hard", baseSha]);
      const applied = [];
      const dropped = [];
      for (const p of prs) {
        const ref = `${ns}/pr-${p.number}`;
        if (git(["rev-parse", ref], cwd) !== p.sha) {
          dropped.push({ number: p.number, reason: "moved" }); // a push after its CI was read: the mark names what was built
          continue;
        }
        try {
          git(["merge", "-q", "--squash", ref]);
        } catch (e) {
          if (e.code === "ETIMEDOUT") throw e; // not a conflict
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
      signal?.throwIfAborted();
      git(["push", "-q", "--force", remote, `${sha}:refs/heads/${branch}`], cwd);
    },
    /** Fast-forwards `base` to `sha` without force: the push is refused if `base` moved since the batch was built. */
    async land(base, sha) {
      signal?.throwIfAborted();
      try {
        git(["push", "-q", remote, `${sha}:refs/heads/${base}`], cwd);
        return { ok: true };
      } catch (e) {
        if (e.code === "ETIMEDOUT") throw e; // it may have landed: the next run reads where the base is
        // git ends with `hint:` lines; the reason is the `! [rejected]` or `error:` line.
        const lines = String(e.stderr ?? e.message).trim().split("\n");
        return { ok: false, message: (lines.find((l) => /^\s*!|^error:|^fatal:/.test(l)) ?? lines.at(-1)).trim() };
      }
    },
    close() {
      if (dir) git(["worktree", "remove", "--force", dir], cwd);
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
      for (const ref of git(["for-each-ref", "--format=%(refname)", `${ns}/`], cwd).split("\n").filter(Boolean)) git(["update-ref", "-d", ref], cwd);
    },
    /**
     * Rebases one pull request's head onto `base`'s tip in the temporary worktree, without pushing: { baseSha, sha }, or
     * { baseSha, dropped } with "moved" (its head is not `p.sha`), "conflict" or "empty" (nothing left against the
     * base). `force` makes new commits even when the head already sits on the tip (a fresh commit for another CI run).
     */
    async rebase(base, p, { force = false } = {}) {
      fetch([`+refs/heads/${base}:${ns}/base`, `+refs/pull/${p.number}/head:${ns}/pr-${p.number}`]);
      const baseSha = git(["rev-parse", `${ns}/base`], cwd);
      if (git(["rev-parse", `${ns}/pr-${p.number}`], cwd) !== p.sha) return { baseSha, dropped: "moved" };
      if (!dir) {
        dir = mkdtempSync(join(tmpdir(), "merge-train-"));
        git(["worktree", "add", "-q", "--detach", dir, baseSha], cwd);
      }
      git(["reset", "-q", "--hard", p.sha]);
      // Settings of the machine's own git must not reach this rebase: updateRefs would move its local branches.
      const plain = ["-c", "rebase.updateRefs=false", "-c", "rebase.autoSquash=false", "-c", "rebase.autoStash=false"];
      try {
        git([...identity(), ...plain, "rebase", "-q", "--no-verify", ...(force ? ["--force-rebase"] : []), baseSha]);
      } catch {
        try {
          git(["rebase", "--abort"]);
        } catch {
          // nothing to abort
        }
        git(["reset", "-q", "--hard", baseSha]);
        return { baseSha, dropped: "conflict" };
      }
      const sha = git(["rev-parse", "HEAD"]);
      if (git(["rev-parse", `${sha}^{tree}`]) === git(["rev-parse", `${baseSha}^{tree}`])) return { baseSha, dropped: "empty" };
      return { baseSha, sha };
    },
    /** Moves a pull request's branch to `sha`, only while it still points at `expected` (an author's push wins). */
    async pushHead(branch, sha, expected) {
      try {
        git(["push", "-q", `--force-with-lease=refs/heads/${branch}:${expected}`, remote, `${sha}:refs/heads/${branch}`], cwd);
        return { ok: true };
      } catch (e) {
        const lines = String(e.stderr ?? e.message).trim().split("\n");
        return { ok: false, message: (lines.find((l) => /^\s*!|^error:|^fatal:/.test(l)) ?? lines.at(-1)).trim() };
      }
    },
    /** An epic's fast-forward to a pull request's head, fetched first (a Mac's clone may not have it). */
    async landPull(base, number, sha) {
      fetch([`+refs/pull/${number}/head:${ns}/pr-${number}`]);
      return this.land(base, sha);
    },
  };
}

/** The bases with a train to run: `dev` and `epic/<name>` branches with a queued pull request or a batch open. */
export const trainBases = (pulls) =>
  [...new Set(pulls.filter((p) => BASE.test(p.base) && (p.labels.includes(LABEL.queue) || isBatch(p, p.base))).map((p) => p.base))].sort();

/** The bases a Mac serves without --base, the queue app configured or not: `dev` and every `epic/*` branch. */
export const localBases = async (gh) => ["dev", ...(await gh.epicBranches()).filter((b) => BASE.test(b)).sort()];

/**
 * Runs `round(signal)` once, or every `every` seconds. A round never ends the loop: what it throws goes to `report`,
 * and a round still running after `deadline` ms is cut (its signal aborts, so its next request or git call fails), goes
 * to `report` too, and the next round starts on time. A round that returns true stops the loop.
 */
export async function rounds(round, { every = 0, deadline = ROUND_DEADLINE, report, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (;;) {
    const ac = new AbortController();
    let timer;
    const cut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`the round ran past its ${deadline / 1000} s deadline, so it is cut and the next round starts`);
        ac.abort(e);
        reject(e);
      }, deadline);
    });
    const run = round(ac.signal);
    run.catch(() => {}); // a cut round that fails later is not an unhandled rejection
    try {
      if (await Promise.race([run, cut])) return;
    } catch (e) {
      report(e);
    } finally {
      clearTimeout(timer);
    }
    if (!every) return;
    await sleep(every * 1000);
  }
}

/** One train per machine: a lock file holding the pid; a lock whose process is gone is taken over. */
function lock(path) {
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      process.on("exit", () => rmSync(path, { force: true }));
      return;
    } catch {
      const pid = Number(readFileSync(path, "utf8"));
      try {
        process.kill(pid, 0);
        throw new Error(`another merge train runs here (pid ${pid}, ${path})`);
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
        rmSync(path, { force: true });
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const opt = (name) => (flag(name) ? args[args.indexOf(name) + 1] : undefined);
  const dry = flag("--dry-run") || process.env.DRY_RUN === "true";
  if (!dry && !flag("--run") && !flag("--list-bases")) {
    console.error("usage: merge-train.mjs --run | --dry-run | --list-bases  [--base <branch>] [--every <seconds>] [--also <n,n>]");
    process.exit(2);
  }
  const also = (opt("--also") ?? "").split(",").filter(Boolean).map(Number);
  if (also.length && !dry) throw new Error("--also works in dry runs only");
  const repo = process.env.GITHUB_REPOSITORY || "MiguelMedeiros/ghostly";
  // On a runner: the queue app's token. On a Mac until the app exists: the local gh login. Never printed: git gets
  // its credentials from the checkout or the Mac's own helper (never a URL), and errors are scrubbed of the token.
  const token = process.env.GH_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 60_000 }).trim();
  const scrub = (s) => String(s).replaceAll(token, "***");
  const gh = restLayer(token, repo);
  if (flag("--list-bases")) return console.log(JSON.stringify(trainBases(await gh.pulls())));
  const local = !process.env.GITHUB_ACTIONS && !dry;
  if (local) lock(join(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 60_000 }).trim(), "merge-train.lock"));
  // The login the train comments as: the app's bot on a runner (set by the workflow), the gh user on a Mac.
  const login = process.env.MERGE_TRAIN_LOGIN || execFileSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8", timeout: 60_000 }).trim();

  const every = Number(opt("--every")) || 0;
  const print = (base, log) => {
    const lines = log.map(scrub);
    console.log(lines.map((l) => (l.startsWith("::") ? l : `[${new Date().toISOString()}] ${l}`)).join("\n"));
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, [`### Merge train: ${base}${dry ? " (dry run)" : ""}`, "", ...lines.map((l) => `    ${l.replace(/^::\w+::/, "")}`), ""].join("\n"));
  };
  const failed = (base, e, log) => {
    log.push(e instanceof BudgetLow ? `::warning::${base}: ${e.message}` : `::error::${base}: ${e.message}`);
    if (!(e instanceof BudgetLow) && !every) process.exitCode = 1;
  };
  // A round never ends the loop: a network error, a low budget or a round cut at its deadline is logged, and the next
  // round tries again.
  const report = (e) => {
    const log = [];
    failed("train", e, log);
    print("train", log);
  };
  await rounds(
    async (signal) => {
      const gh = restLayer(token, repo, { signal });
      if (local && (await gh.appTrainRuns())) {
        console.log("The merge-queue workflow runs the train now (the queue app is configured); this machine stops.");
        return true;
      }
      const bases = opt("--base") ? [opt("--base")] : process.env.GITHUB_ACTIONS ? trainBases(await gh.pulls()) : await localBases(gh);
      if (!opt("--base")) print("train", [`Serving ${bases.join(", ") || "no base"}.`]);
      for (const base of bases) {
        const git = gitLayer({ signal });
        const log = [];
        try {
          await tick({ gh, git, base, login, dry, also, log });
        } catch (e) {
          failed(base, e, log);
        } finally {
          git.close();
        }
        print(base, log);
      }
    },
    { every, report },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
