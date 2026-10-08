// Which of CI's jobs a pull request needs, from the files it changes and whether it is a draft. ci.yml's "Changed
// paths" job runs this on every run: pull requests and merge queue entries with their files, pushes with --all.
//
//   gh api --paginate repos/o/r/pulls/N/files --jq '.[].filename' | node tools/scripts/ci-changes.mjs --draft=false
//   node tools/scripts/ci-changes.mjs --draft=false --all     # no file list: every path gate on
//
// writes one `<gate>=true|false` line per gate (`rust=`, `website=`, `website_e2e=`, `app=`, `packages=`, `full=`,
// `affected=`) to $GITHUB_OUTPUT (and prints them), with a notice for each job it skips. A path gate may only leave a
// job out when that job cannot read any of the changed files: tools/scripts/test/ci-changes.test.ts holds the
// website's list to what the site's scripts actually read.
//
// A draft gets the fast tier: lint and types, the unit tests the change can reach (test-affected.mjs), the site's checks
// when the site changed, and the Rust job when Rust changed. Everything else waits for the pull request to leave
// draft, whose run (ready_for_review) plans everything again. Drafts are pushed often, by many sessions at once: the
// full run is about 14 jobs, 2 of them on macOS, and the free plan runs about 20 jobs at a time, 5 on macOS.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The Rust job (Tauri Backend). Only a draft skips it without one of these: `ready_for_review` runs
 * everything again. ci.yml is not among them: a draft that changes the workflow gets the fast tier too.
 */
export const RUST = /^(apps\/desktop\/|native\/transports\/|Cargo\.(toml|lock)$)/;

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
  // packages/browser's atprotoOAuth test: the client metadata the site serves.
  "apps/website/public/oauth/",
  // packages/cli's agentDocs test: every command the agents guide (and its prompt) and the agents page teach.
  "docs/AI-AGENTS.md",
  "apps/website/content/agents.ts",
];

export const covers = (inputs, file) => inputs.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));

/**
 * @param {string[] | null} files  null: the files are not known (a push, a list too long to read): every path gate is on
 * @param {{ draft: boolean }} options
 */
export function plan(files, { draft }) {
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
  // Then the tier: a draft keeps only the fast jobs.
  const rust = !draft || (!all && files.some((f) => RUST.test(f)));
  if (draft) {
    why.push("Draft: the fast tier only (lint and types, the affected unit tests). Leaving draft runs everything");
    if (!rust) why.push("Draft without Rust changes: Tauri Backend skipped");
  }
  return {
    rust,
    website: site,
    website_e2e: site && !draft,
    app: desktop && !draft,
    packages: shards && !draft,
    full: !draft,
    affected: draft,
    why,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const draft = process.argv.includes("--draft=true");
  let files = null;
  if (!process.argv.includes("--all")) {
    files = (await new Response(process.stdin).text()).split("\n").filter(Boolean);
    if (!files.length) throw new Error("no changed files on stdin");
  }
  const { why, ...jobs } = plan(files, { draft });
  for (const line of why) console.log(`::notice::${line}`);
  const lines = Object.entries(jobs).map(([job, run]) => `${job}=${run}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
