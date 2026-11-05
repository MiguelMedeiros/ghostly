// Which of CI's jobs a pull request needs, from the files it changes and whether it is a draft. ci.yml's "Changed
// paths" job runs this on every run: pull requests and merge queue entries with their files, pushes with --all.
//
//   gh api --paginate repos/o/r/pulls/N/files --jq '.[].filename' | node tools/scripts/ci-changes.mjs --draft=false
//   node tools/scripts/ci-changes.mjs --draft=false --all     # no file list: every path gate on
//   node tools/scripts/ci-changes.mjs --draft=false --tree=T  # a push to dev: see testedAs; else as --all
//
// writes one `<gate>=true|false` line per gate (`lint=`, `rust=`, `website=`, `website_e2e=`, `app=`, `packages=`,
// `full=`, `affected=`, `tested=`) to $GITHUB_OUTPUT (and prints them), with a notice for each job it skips. A path
// gate may only leave a job out when that job cannot read any of the changed files: tools/scripts/test/ci-changes.test.ts
// holds the website's list to what the site's scripts, tests and browser checks actually read.
//
// A draft gets the fast tier: lint and types, the unit tests the change can reach (test-affected.mjs), the site's checks
// when the site changed, and the Rust job when Rust changed. Everything else waits for the pull request to leave
// draft, whose run (ready_for_review) plans everything again. Drafts are pushed often, by many sessions at once: the
// full run is about 14 jobs, 2 of them on macOS, and the free plan runs about 20 jobs at a time, 5 on macOS.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Everything the Rust job (Tauri Backend) reads: a directory ends in `/`. The crates, and the files their tests name by
 * include_str! or CARGO_MANIFEST_DIR (tools/scripts/test/ci-changes.test.ts holds this list to those paths). The job
 * builds no frontend, so the crates read no other app code.
 */
export const RUST_INPUTS = [
  "apps/desktop/",
  "native/transports/",
  "Cargo.toml",
  "Cargo.lock",
  // app_sandbox.rs: the mini-app frame's copies of the web app's frame and core's bridge.
  "apps/web/public/app-frame.html",
  "packages/core/src/miniApp.ts",
  // turn_record.rs: the vectors the TypeScript suite checks too.
  "packages/core/test/vectors/turn-record.json",
  // translate.rs: the runtime's package, protocol and built archive.
  "native/translation/",
  // viewer.rs: a test keeps its connection policy the same as `service open`'s.
  "packages/cli/src/services.ts",
];

/**
 * The Rust job's own definition. Only a ready pull request runs it for these: a draft that changes the workflow gets
 * the fast tier.
 */
export const RUST_JOB = [".github/workflows/ci.yml", "tools/scripts/ci-changes.mjs"];

/**
 * Everything the Website jobs (checks and browser checks) read: a directory ends in `/`. The site builds from
 * apps/website/ and the files below (a subset of what apps/website/Dockerfile.dockerignore lets in); the deck check also reads
 * the app's deck.
 */
export const WEBSITE_INPUTS = [
  "apps/website/",
  // Published under /reference by apps/website/scripts/sync-references.mjs, and scanned by check-dashes.mjs.
  "docs/wisps/",
  "docs/PROTOCOL.md",
  "docs/SDK.md",
  "docs/USDT-INTEGRATION.md",
  "docs/DHT-DELIVERY.md",
  ".github/CONTRIBUTING.md",
  ".github/SECURITY.md",
  // Carried in /llms-full.txt by apps/website/scripts/llms.mjs (KEY_DOCS).
  "docs/CLI.md",
  "docs/AI-AGENTS.md",
  "packages/cli/SKILL.md",
  "packages/cli/README.md",
  // llms.test.mjs checks the install line against the CLI's package name.
  "packages/cli/package.json",
  // llms.test.mjs checks that llms.txt's Android line follows the Release workflow's ANDROID_FROM.
  ".github/workflows/release.yml",
  // Quoted on /developers: sync-references.mjs's excerpt().
  "packages/core/src/invite.ts",
  "packages/core/src/pairedTransports.ts",
  // The home's wallet and identity decks: sync-app-deck.mjs's FILES, which `sync-app-deck.mjs --check` compares.
  "apps/ui/src/components/deck/",
  "apps/ui/src/components/identities/providerMarks.tsx",
  "apps/ui/src/components/WalletCardDeck.tsx",
  "apps/ui/src/components/WalletCards.tsx",
  "apps/ui/src/components/walletCardTypes.ts",
  "apps/ui/src/components/wallet-deck.css",
  "apps/ui/src/components/wallet-cards.css",
  // The brand test (brand.test.mjs) compares the app's lockup and themes, and the README's logos, with the brand page's.
  "apps/ui/src/components/AppBrand.tsx",
  "docs/assets/readme/",
  "apps/ui/src/index.css",
  // The store pages' readers: sync-store-core.mjs's FILES, which `sync-store-core.mjs --check` compares.
  "packages/core/src/appStore.ts",
  "packages/core/src/appBundle.ts",
  "packages/core/src/appStatements.ts",
  "packages/core/src/canonicalJson.ts",
  "packages/core/src/bytes.ts",
  "packages/core/src/image.ts",
  "packages/core/src/text.ts",
  // privacy-hosts.test.mjs checks the privacy page's resolver list against the app's DoH resolvers, and the agents
  // FAQ's relay hosts against the default Pkarr and Iroh relays.
  "packages/browser/src/proofs/domain.ts",
  "packages/core/src/relay.ts",
  "packages/browser/src/platform/irohWeb.ts",
  // privacy-settings.test.mjs checks the privacy page's Settings paths against the app's section names.
  "apps/ui/src/lib/settingsSections.ts",
  "apps/ui/src/locales/en/settings.json",
  "apps/ui/src/locales/en/network.json",
  // The launch checklist (e2e/launch-checklist.spec.ts) checks the repository's social preview's size.
  "docs/assets/social-preview.png",
  // shots-version.test.mjs checks lib/release.ts's version against the app's.
  "package.json",
  // agents-webrtc.test.mjs checks the site's text against it.
  "packages/cli/src/runtime/engine.ts",
  "packages/browser/src/engine/node.ts",
  // The jobs themselves.
  ".github/workflows/ci.yml",
];

/**
 * The two Desktop jobs on a Mac build and run the app, which reads neither the site nor the docs: they skip a
 * pull request that changes nothing else.
 */
export const NOT_APP = /^(apps\/website|docs)\//;

/**
 * The packages' unit tests (the packages shards) read, of the docs and the site, only what is below: they skip a
 * pull request whose every change is elsewhere in docs/ or apps/website/. tools/scripts/test/ci-changes.test.ts holds this
 * list to the paths the packages' tests and sources name.
 */
export const PACKAGES_READ_FROM_SITE = [
  // packages/core's websiteInvite test: the join page's own copy of the invite rules.
  "apps/website/lib/invite.ts",
  // packages/browser's atprotoOAuth test: the client metadata the site serves, and the home's Bluesky proof card.
  "apps/website/public/oauth/",
  "apps/website/content/home.ts",
  // packages/cli's agentDocs test: every command the agents guide (and its prompt) and the agents page teach, and the
  // guides and pages that point to the voice agent.
  "docs/AI-AGENTS.md",
  "apps/website/content/agents.ts",
  "apps/website/content/agentsThreat.ts",
  "docs/CLI.md",
  "apps/website/content/cli.ts",
  "apps/website/scripts/llms.mjs",
  // packages/browser's websiteStore and websiteStoreOnce tests: the store pages' store and reader, its copy of core's, the build's reader and the test store.
  "apps/website/lib/store.ts",
  "apps/website/lib/storeRead.ts",
  "apps/website/lib/appsGate.ts",
  "apps/website/lib/latestRelease.ts",
  "apps/website/lib/release.ts",
  "apps/website/lib/store-core/",
  "apps/website/scripts/sync-store.mjs",
  "apps/website/e2e/fixtures/store/",
];

export const covers = (inputs, file) => inputs.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));

/** How many pages of CI's green pull request runs (100 each, newest first) a push to dev searches: about a day's. */
export const TESTED_PAGES = 3;

/**
 * The green CI run that already tested the tree a push to dev holds, or null. The merge train lands a batch on dev only
 * while dev's tip is still the batch's base, and a lone pull request only at a head that holds dev's tip, so dev's new
 * commit holds the tree of a head whose CI Success passed one landing earlier. A batch of N lands as N pushes, one per
 * pull request: only the last holds the tree of the batch's head. The others hold the tree of a commit below it, which
 * no run tested whole, and a landing may stop there (one of the rest changed or left the line, GitHub refused it, the
 * train's run ended): those pushes run all of CI, unless dev has already moved past them (supersededBy). A run counts when:
 * - its head has that tree, and its "CI Success" (not the draft's) passed in its latest attempt;
 * - it ran dev's own ci.yml: its head is a branch of this repository, and every pull request ever opened from that
 *   branch (closed ones too: the batch has closed by the time dev's last push runs, and its run's `pull_requests` is
 *   empty then) is into dev, and always was. A pull request into an epic (or a fork's) runs the ci.yml of its own base,
 *   which a writer can make a stub; `base.ref` is the base now, and ci.yml has no `edited` trigger, so a pull request
 *   moved to dev keeps the green run it made on the old base's ci.yml;
 * - every commit of the push that its head lacks was committed after the run started. A pull request's run tests the
 *   head merged with its base as it was then: had dev held a commit the head lacks, that run tested another tree.
 * @param {{ sha: string, tree: string, repo: string, api: (path: string) => Promise<any> }} push  `repo` is owner/name;
 *   `api` reads that repository's REST API
 * @returns {Promise<string | null>} the run's address
 */
export async function testedAs({ sha, tree, repo, api }) {
  const owner = repo.split("/")[0];
  for (let page = 1; page <= TESTED_PAGES; page++) {
    const { workflow_runs: runs } = await api(`actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=100&page=${page}`);
    for (const run of runs.filter((r) => r.head_commit?.tree_id === tree)) {
      if (run.path !== ".github/workflows/ci.yml" || run.head_repository?.full_name !== repo) continue;
      const pulls = await api(`pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}`);
      if (!pulls.length || pulls.some((p) => p.base.ref !== "dev" || p.base.repo?.full_name !== repo)) continue;
      if (await retargeted(api, pulls)) continue;
      const { jobs } = await api(`actions/runs/${run.id}/jobs?per_page=100`);
      if (!jobs.some((j) => j.name === "CI Success" && j.conclusion === "success")) continue;
      const { ahead_by: ahead, commits } = await api(`compare/${run.head_sha}...${sha}`);
      const started = Date.parse(run.created_at);
      if (commits.length < ahead || commits.some((c) => !(Date.parse(c.commit.committer.date) >= started))) continue;
      return run.html_url;
    }
    if (runs.length < 100) break;
  }
  return null;
}

/** How long a push to dev that is still dev's head waits before it asks once more: the train lands a batch's pushes 3 to 6 s apart. */
export const SETTLE_MS = 15_000;

/**
 * The CI run of a newer push to dev that holds this one, or null. A batch's first landing starts its run before the next
 * push arrives, so the `push-dev` concurrency group cannot cancel it, and its tree (dev and the first pull request) is
 * one no run tested: it would run all of CI for a state dev left seconds later. The run of a newer head waits in the
 * same group (GitHub keeps the newest waiting one) and tests a tree that holds this commit, so this push need not. It
 * counts only when dev's head is newer, this commit is below it (`compare` says the head is ahead, not diverged: a force
 * push counts as no), and CI has a push run for that head. A landing that stopped here leaves dev's head on this commit:
 * it runs everything. Asked again once after `settle`, for a push whose plan starts before the next one lands.
 * @param {{ sha: string, api: (path: string) => Promise<any>, settle?: () => Promise<void> }} push
 * @returns {Promise<string | null>} the newer run's address
 */
export async function supersededBy({ sha, api, settle = () => new Promise((r) => setTimeout(r, SETTLE_MS)) }) {
  const ask = async () => {
    const head = (await api("branches/dev")).commit?.sha;
    if (!head || head === sha) return null;
    if ((await api(`compare/${sha}...${head}`)).status !== "ahead") return null;
    const { workflow_runs: runs } = await api(`actions/workflows/ci.yml/runs?event=push&branch=dev&head_sha=${head}&per_page=10`);
    return runs.find((r) => r.head_sha === head && r.path === ".github/workflows/ci.yml")?.html_url ?? null;
  };
  const first = await ask();
  if (first) return first;
  await settle();
  return ask();
}

/**
 * The run that leaving draft started behind this one, or null. A run whose event saw a draft (its payload) while the
 * pull request is ready now left draft after that event: "open as draft, `gh pr ready` seconds later", or a draft run
 * still going when its owner marks it ready. Leaving draft's run does not cancel the one in progress (ci.yml's
 * concurrency): it waits behind it in the pull request's group and plans everything. So this run plans the fast tier,
 * and its green "CI Success (draft)" lets the pull request board the merge train while the full run is still to come
 * (the train cancels that one). It counts only when CI has a run on this head for this pull request that is newer
 * than this one and not finished, and none older: a run created before this one (leaving draft's, when GitHub created
 * the push's run later) was cancelled by this one, which then plans everything as before. Asked again once after
 * `settle`, for a run whose plan starts before leaving draft's run exists.
 * @param {{ sha: string, run: number, pull: number, repo: string, api: (path: string) => Promise<any>, settle?: () => Promise<void> }} pr
 *   `run` is this run's id, `pull` the pull request's number
 * @returns {Promise<string | null>} the newer run's address
 */
export async function draftBehind({ sha, run, pull, repo, api, settle = () => new Promise((r) => setTimeout(r, SETTLE_MS)) }) {
  const ask = async () => {
    const { workflow_runs: runs } = await api(`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${sha}&per_page=100`);
    const others = runs.filter(
      (r) =>
        r.id !== run &&
        r.head_sha === sha &&
        r.path === ".github/workflows/ci.yml" &&
        r.head_repository?.full_name === repo &&
        r.pull_requests?.some((p) => p.number === pull),
    );
    if (others.some((r) => r.id < run)) return { done: true, url: null };
    const behind = others.find((r) => r.id > run && r.status !== "completed");
    return { done: Boolean(behind), url: behind?.html_url ?? null };
  };
  const first = await ask();
  if (first.done) return first.url;
  await settle();
  return (await ask()).url;
}

// A writer's base change, and GitHub's own when the old base branch was deleted (it tried: failed counts too).
const BASE_CHANGES = new Set(["base_ref_changed", "automatic_base_change_succeeded", "automatic_base_change_failed"]);

/**
 * Whether any of these pull requests ever had its base changed (by a writer, or by GitHub when the old base was
 * deleted). Only the issue events list these, not the timeline. A full page is a doubt: it counts as yes.
 * @param {(path: string) => Promise<any>} api
 * @param {{ number: number }[]} pulls
 */
async function retargeted(api, pulls) {
  for (const { number } of pulls) {
    const events = await api(`issues/${number}/events?per_page=100`);
    if (events.length >= 100 || events.some((e) => BASE_CHANGES.has(e.event))) return true;
  }
  return false;
}

/**
 * @param {string[] | null} files  null: the files are not known (a push, a list too long to read): every path gate is on
 * @param {{ draft: boolean, tested?: boolean, superseded?: boolean }} options  tested: a push to dev whose tree a green
 *   run already tested; superseded: one a newer push's run covers (supersededBy), planned as tested
 */
export function plan(files, { draft, tested = false, superseded = false }) {
  // Only Tauri Backend runs: only a push to dev saves the Cargo cache that pull requests restore. It looks the cache up
  // first and builds only when this Cargo.lock and toolchain have none yet.
  if (tested || superseded) {
    tested = true;
    const why = [
      superseded
        ? "dev already moved past this commit, and the newer head's run tests a tree that holds it: only Tauri Backend runs, and only to save a Cargo cache this Cargo.lock lacks"
        : "This tree already passed CI Success: only Tauri Backend runs, and only to save a Cargo cache this Cargo.lock lacks",
    ];
    return { lint: false, rust: true, website: false, website_e2e: false, app: false, packages: false, full: false, affected: false, tested, why };
  }
  const why = [];
  const all = files === null;
  const any = (test) => all || files.some(test);
  // The path gates, as for a pull request that is ready.
  const site = any((f) => covers(WEBSITE_INPUTS, f));
  if (!site) why.push("Nothing the website reads changed: Website skipped");
  const desktop = any((f) => !NOT_APP.test(f));
  if (!desktop) why.push("Only apps/website/ and docs/ changed: the Desktop jobs on macOS skipped");
  const shards = any((f) => !NOT_APP.test(f) || covers(PACKAGES_READ_FROM_SITE, f));
  if (!shards) why.push("Nothing the packages' tests read changed: the packages shards skipped");
  // No file list runs Tauri Backend unless it is a draft.
  const rust = all ? !draft : files.some((f) => covers(RUST_INPUTS, f) || (!draft && covers(RUST_JOB, f)));
  if (!all && !rust) why.push("Nothing the Rust job reads changed: Tauri Backend skipped");
  // Then the tier: a draft keeps only the fast jobs.
  if (draft) why.push("Draft: the fast tier only (lint and types, the affected unit tests). Leaving draft runs everything");
  return {
    lint: true,
    rust,
    website: site,
    website_e2e: site && !draft,
    app: desktop && !draft,
    packages: shards && !draft,
    full: !draft,
    affected: draft,
    tested,
    why,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const draft = process.argv.includes("--draft=true");
  const tree = process.argv.find((a) => a.startsWith("--tree="))?.slice("--tree=".length);
  const base = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${process.env.GITHUB_REPOSITORY}/`;
  const api = async (path) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  // A pull request that left draft after this run's event: exits 0 when leaving draft's run waits behind this one (see
  // draftBehind), else 1. Any doubt is a 1: the run plans everything, as before.
  if (process.argv.includes("--draft-behind")) {
    const { PR_HEAD_SHA: sha, GITHUB_RUN_ID: run, PR_NUMBER: pull, GITHUB_REPOSITORY: repo } = process.env;
    const behind = await draftBehind({ sha, run: Number(run), pull: Number(pull), repo, api }).catch((e) => {
      console.log(`::notice::Could not read whether leaving draft's run waits behind this one (${e.message}): everything runs`);
      return null;
    });
    if (behind) console.log(`::notice::This pull request left draft after this run's event, and ${behind} waits behind this run and runs everything: this one runs the fast tier`);
    else console.log("This pull request left draft after this run's event, and no run of leaving draft waits behind this one: everything runs");
    process.exit(behind ? 0 : 1);
  }
  let files = null;
  let tested = false;
  let superseded = false;
  if (tree) {
    // Any doubt (the API failed, no run found) runs everything, as before.
    const run = await testedAs({ sha: process.env.GITHUB_SHA, tree, repo: process.env.GITHUB_REPOSITORY, api }).catch((e) => {
      console.log(`::notice::Could not look for a green run of this tree (${e.message}): everything runs`);
      return null;
    });
    if (run) console.log(`::notice::Tested as ${run}`);
    tested = Boolean(run);
    if (!tested) {
      const newer = await supersededBy({ sha: process.env.GITHUB_SHA, api }).catch((e) => {
        console.log(`::notice::Could not read whether dev moved past this commit (${e.message}): everything runs`);
        return undefined;
      });
      if (newer) console.log(`::notice::No green pull request run has this tree, but dev moved past it: ${newer} tests a tree that holds it`);
      else if (newer === null) console.log("No green pull request run has this tree, and dev has not moved past it: everything runs");
      superseded = Boolean(newer);
    }
  } else if (!process.argv.includes("--all")) {
    files = (await new Response(process.stdin).text()).split("\n").filter(Boolean);
    if (!files.length) throw new Error("no changed files on stdin");
  }
  const { why, ...jobs } = plan(files, { draft, tested, superseded });
  for (const line of why) console.log(`::notice::${line}`);
  const lines = Object.entries(jobs).map(([job, run]) => `${job}=${run}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
