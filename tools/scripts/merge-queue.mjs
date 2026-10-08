#!/usr/bin/env node
// The merge queue for `dev`. The dev ruleset merges a pull request only when CI Success is green on a branch that is up
// to date with dev, and auto-merge (`gh pr merge --squash --auto`) merges it by itself once that holds. What it cannot
// do is bring a branch up to date: when one pull request merges, every other armed one falls BEHIND and waits. This
// script, run by .github/workflows/merge-queue.yml, updates them one at a time:
//
// - It reads the open pull requests into dev that are ready (not drafts) and have auto-merge armed.
// - If one of them is up to date and its CI is still running (or it is green and about to merge), the queue's head is
//   busy: updating another now would only make it fall behind again when the head merges, so it does nothing.
// - Otherwise it updates the oldest BEHIND one (`batch/` branches first, then by number), unless its CI Success is red
//   on its current commit: that one waits for a push from its owner.
// - A pull request that conflicts with dev (DIRTY) is skipped, with one comment per commit telling its owner to rebase.
//
// The update must be made with a GitHub App's token, never the workflow's GITHUB_TOKEN: GitHub starts no workflow for
// a commit the GITHUB_TOKEN made, so the updated branch would never get its CI Success and would wait forever.
//
//   GH_TOKEN=<token> GITHUB_REPOSITORY=owner/repo node tools/scripts/merge-queue.mjs [--dry-run]
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, BASE (default dev), DRY_RUN=true (same as --dry-run: decide and log, change
// nothing), GITHUB_STEP_SUMMARY (set by Actions). tools/scripts/test/merge-queue.test.ts drives the decision.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The required check the ruleset asks for. A draft's gate is "CI Success (draft)", which does not count. */
export const GATE = "CI Success";

/** The hidden mark of the conflict comment: one comment per head commit, never one per run. */
export const conflictMark = (sha) => `<!-- merge-queue:conflict ${sha} -->`;

export const conflictComment = (sha, base) =>
  [
    conflictMark(sha),
    `This pull request conflicts with \`${base}\`, so the merge queue skips it. Rebase it onto \`origin/${base}\` and push; auto-merge stays armed and the queue picks it up again.`,
  ].join("\n");

/** Whether a pull request's comments already hold the conflict comment for this head commit. */
export const conflictNoted = (comments, sha) => comments.some((c) => (c.body ?? "").includes(conflictMark(sha)));

/**
 * The state of CI on one commit, from its check runs: "success", "failure", "pending" (CI Success has not finished,
 * or has no run yet while other checks still run) or "none" (no CI Success and nothing running: CI never started).
 * A rerun adds a run with the same name, so the newest one counts.
 */
export function ciState(runs) {
  const newest = (a, b) => (Date.parse(b.started_at ?? 0) || 0) - (Date.parse(a.started_at ?? 0) || 0) || (b.id ?? 0) - (a.id ?? 0);
  const gate = runs.filter((r) => r.name === GATE).sort(newest)[0];
  const running = runs.some((r) => r.status !== "completed");
  if (!gate) return running ? "pending" : "none";
  if (gate.status !== "completed") return "pending";
  if (gate.conclusion === "success") return "success";
  // A run cancelled by a newer one (a push, a rerun) says nothing about the commit until the newer one ends.
  if (gate.conclusion === "cancelled" || gate.conclusion === "skipped") return running ? "pending" : "none";
  return "failure";
}

/** Up to date with the base: `clean`, `unstable` and `has_hooks` can merge; `blocked` waits on (or failed) CI Success. */
const UP_TO_DATE = new Set(["clean", "unstable", "has_hooks", "blocked"]);

/**
 * What to do this run. `prs`: the armed, ready pull requests, each
 * `{ number, branch, sha, state (mergeable_state), ci (ciState of its head) }`.
 * Returns `{ update: pr | null, conflicts: pr[], log: string[] }`.
 */
export function decide(prs) {
  const log = [];
  const conflicts = prs.filter((p) => p.state === "dirty");
  if (conflicts.length) log.push(`CONFLICT ${conflicts.map((p) => `#${p.number}`).join(" ")} (skipped until rebased)`);

  const unknown = prs.filter((p) => !p.state || p.state === "unknown");
  // `blocked` with CI Success green is the moment before GitHub calls it `clean`: about to merge, so busy too.
  const busy = prs.filter((p) => UP_TO_DATE.has(p.state) && (p.state !== "blocked" || p.ci === "pending" || p.ci === "success"));
  for (const p of prs.filter((p) => p.state === "blocked" && p.ci === "failure")) log.push(`RED #${p.number} (up to date, CI Success failed)`);
  for (const p of prs.filter((p) => p.state === "blocked" && p.ci === "none")) log.push(`STALLED #${p.number} (up to date, CI never started)`);

  const order = (a, b) => Number(b.branch.startsWith("batch/")) - Number(a.branch.startsWith("batch/")) || a.number - b.number;
  const behind = prs.filter((p) => p.state === "behind").sort(order);
  const red = behind.filter((p) => p.ci === "failure");
  if (red.length) log.push(`WAITING ${red.map((p) => `#${p.number}`).join(" ")} (behind, CI Success red on its commit: needs a push)`);
  const ready = behind.filter((p) => p.ci !== "failure");

  if (!ready.length) {
    log.push(behind.length ? "Nothing to update." : "No armed pull request is behind.");
    return { update: null, conflicts, log };
  }
  if (busy.length) {
    const what = (p) => `#${p.number} ${p.state === "blocked" && p.ci === "pending" ? "running CI" : "merging"}`;
    log.push(`BUSY: ${busy.map(what).join(", ")} (up to date); ${ready.length} behind wait.`);
    return { update: null, conflicts, log };
  }
  if (unknown.length) {
    log.push(`UNKNOWN: GitHub has not computed the state of #${unknown.map((p) => p.number).join(", #")} yet; trying again next run.`);
    return { update: null, conflicts, log };
  }
  const [update] = ready;
  log.push(`UPDATE #${update.number} (oldest armed pull request behind ${ready.length > 1 ? `of ${ready.length}` : "dev"})`);
  return { update, conflicts, log };
}

// ---------------------------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(token, repo) {
  return async function api(method, path, body) {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, data: text ? JSON.parse(text) : null };
  };
}

async function get(api, path) {
  const r = await api("GET", path);
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status} ${r.data?.message ?? ""}`);
  return r.data;
}

async function getAll(api, path) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const items = await get(api, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const list = Array.isArray(items) ? items : items.check_runs;
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/** One pull request's mergeable_state. GitHub computes it lazily, so the first read after dev moves may say "unknown". */
async function pullState(api, number) {
  let pr;
  for (let i = 0; i < 3; i++) {
    pr = await get(api, `/pulls/${number}`);
    if (pr.mergeable_state && pr.mergeable_state !== "unknown") break;
    await sleep(3000);
  }
  return pr;
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY: repo, BASE: base = "dev", GITHUB_STEP_SUMMARY } = process.env;
  const dry = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
  if (!GH_TOKEN || !repo) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
  const api = client(GH_TOKEN, repo);
  const out = [];
  const say = (line) => {
    console.log(line);
    out.push(line);
  };

  const open = await getAll(api, `/pulls?state=open&base=${encodeURIComponent(base)}&sort=created&direction=asc`);
  const armed = open.filter((p) => !p.draft && p.auto_merge && p.head.repo?.full_name === repo);
  say(`${open.length} open pull request(s) into ${base}, ${armed.length} ready with auto-merge armed.`);

  const prs = [];
  for (const p of armed) {
    const pr = await pullState(api, p.number);
    const runs = await getAll(api, `/commits/${pr.head.sha}/check-runs?filter=latest`);
    prs.push({ number: pr.number, branch: pr.head.ref, sha: pr.head.sha, state: pr.mergeable_state, ci: ciState(runs) });
  }
  for (const p of prs) say(`  #${p.number} ${p.state}, CI ${p.ci} (${p.branch})`);

  const { update, conflicts, log } = decide(prs);
  for (const line of log) say(line);

  for (const p of conflicts) {
    const comments = await getAll(api, `/issues/${p.number}/comments`);
    if (conflictNoted(comments, p.sha)) continue;
    if (dry) {
      say(`(dry run) would comment on #${p.number}: conflicts with ${base}`);
      continue;
    }
    const r = await api("POST", `/issues/${p.number}/comments`, { body: conflictComment(p.sha, base) });
    say(r.ok ? `Commented on #${p.number}: conflicts with ${base}.` : `::warning::Could not comment on #${p.number}: HTTP ${r.status}`);
  }

  if (update && dry) say(`(dry run) would update #${update.number}`);
  if (update && !dry) {
    const r = await api("PUT", `/pulls/${update.number}/update-branch`, { expected_head_sha: update.sha });
    if (r.status === 422 || r.status === 409) {
      // It moved meanwhile, or is up to date already, or GitHub refuses (a conflict it found on merging): next run.
      say(`::warning::Did not update #${update.number}: HTTP ${r.status} ${r.data?.message ?? ""}`);
    } else if (!r.ok) {
      throw new Error(`update-branch #${update.number}: HTTP ${r.status} ${r.data?.message ?? ""}`);
    } else {
      say(`Updated #${update.number} with ${base}.`);
      // Wait until CI shows up on the new commit: the next run (they run one at a time) then sees a busy head, never
      // an idle one that would let it update a second pull request. CI not starting is the GITHUB_TOKEN trap.
      let started = false;
      for (let i = 0; i < 12 && !started; i++) {
        await sleep(10_000);
        const pr = await get(api, `/pulls/${update.number}`);
        if (pr.head.sha === update.sha) continue;
        const runs = await getAll(api, `/commits/${pr.head.sha}/check-runs?filter=latest`);
        started = runs.length > 0;
      }
      say(started ? `CI started on #${update.number}.` : `::warning::No check started on #${update.number} within 2 minutes of the update.`);
    }
  }

  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, ["### Merge queue", "", ...out.map((l) => `    ${l.replace(/^::\w+::/, "")}`), ""].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
