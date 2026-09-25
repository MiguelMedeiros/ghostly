// Which of CI's path-gated jobs a pull request needs, from the files it changes. ci.yml's "Changed paths" job
// runs this on every pull request; pushes (dev, main) skip it and run everything.
//
//   gh api --paginate repos/o/r/pulls/N/files --jq '.[].filename' | node scripts/ci-changes.mjs --draft=false
//
// writes `rust=`, `website=` and `app=` to $GITHUB_OUTPUT (and prints them), with a notice for each job it
// skips. A gate may only leave a job out when that job cannot read any of the changed files:
// scripts/test/ci-changes.test.ts holds the website's list to what the site's scripts actually read.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The Rust jobs (Tauri Backend, CLI). Only a draft skips them without one of these: `ready_for_review` runs
 * everything again.
 */
export const RUST = /^(src-tauri\/|cli\/|native-transports\/|Cargo\.(toml|lock)$|\.github\/workflows\/ci\.yml$)/;

/**
 * Everything the Website jobs (checks and browser checks) read: a directory ends in `/`. The site builds from
 * website/ and the files below (a subset of what website/Dockerfile.dockerignore lets in); the deck check also reads
 * the app's deck.
 */
export const WEBSITE_INPUTS = [
  "website/",
  // Published under /reference by website/scripts/sync-references.mjs, and scanned by check-dashes.mjs.
  "docs/wisps/",
  "docs/PROTOCOL.md",
  "docs/SDK.md",
  "docs/USDT-INTEGRATION.md",
  "docs/DHT-DELIVERY.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  // Quoted on /developers: sync-references.mjs's excerpt().
  "packages/core/src/invite.ts",
  "packages/core/src/pairedTransports.ts",
  // The home's wallet deck: sync-app-deck.mjs's FILES, which `sync-app-deck.mjs --check` compares.
  "src/components/deck/",
  "src/components/WalletCardDeck.tsx",
  "src/components/WalletCards.tsx",
  "src/components/walletCardTypes.ts",
  "src/components/wallet-deck.css",
  "src/components/wallet-cards.css",
  // The jobs themselves.
  ".github/workflows/ci.yml",
];

/**
 * The two Desktop jobs on a Mac build and run the app, which reads neither the site nor the docs: they skip a
 * pull request that changes nothing else.
 */
export const NOT_APP = /^(website|docs)\//;

export const covers = (inputs, file) => inputs.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));

/** @param {string[]} files @param {{ draft: boolean }} options */
export function plan(files, { draft }) {
  const why = [];
  const rust = !draft || files.some((f) => RUST.test(f));
  if (!rust) why.push("Draft without Rust changes: Tauri Backend and CLI skipped");
  const website = files.some((f) => covers(WEBSITE_INPUTS, f));
  if (!website) why.push("Nothing the website reads changed: Website skipped");
  const app = files.some((f) => !NOT_APP.test(f));
  if (!app) why.push("Only website/ and docs/ changed: the Desktop jobs on macOS skipped");
  return { rust, website, app, why };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const draft = process.argv.includes("--draft=true");
  const files = (await new Response(process.stdin).text()).split("\n").filter(Boolean);
  if (!files.length) throw new Error("no changed files on stdin");
  const { why, ...jobs } = plan(files, { draft });
  for (const line of why) console.log(`::notice::${line}`);
  const lines = Object.entries(jobs).map(([job, run]) => `${job}=${run}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
