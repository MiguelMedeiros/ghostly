#!/usr/bin/env node
/**
 * The newest release the current app is tested against (e2e/compat/), read from the tags so that it does not go stale:
 * a contact who has not updated yet is most often on the release before this one. The commit under test is left out, so
 * the gate of a release tests it against the release before, not against itself. A pre-release or a stray tag is no
 * release.
 *
 *   node tools/scripts/compat-latest-release.mjs   # prints e.g. v1.7.2
 *
 * Asks the remote: a CI checkout has no tags.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RELEASE = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+)(\^\{\})?$/;

/** The vX.Y.Z tags in `git ls-remote --tags` output whose commit is not `head`, newest first. */
export function releasesNewestFirst(lsRemote, head) {
  // An annotated tag has two lines; its `^{}` one, the commit it points at, is the one to compare.
  const releases = new Map();
  for (const line of lsRemote.split("\n")) {
    const [commit, ref] = line.trim().split(/\s+/);
    const match = ref && RELEASE.exec(ref);
    if (!match) continue;
    const tag = `v${match[1]}.${match[2]}.${match[3]}`;
    if (match[4] || !releases.has(tag)) releases.set(tag, { tag, commit, version: match.slice(1, 4).map(Number) });
  }
  const candidates = [...releases.values()].filter((release) => release.commit !== head);
  candidates.sort((a, b) => b.version.map((n, i) => n - a.version[i]).find((d) => d !== 0) ?? 0);
  return candidates.map((release) => release.tag);
}

/** The newest vX.Y.Z in `git ls-remote --tags` output whose commit is not `head`, or null. */
export function newestRelease(lsRemote, head) {
  return releasesNewestFirst(lsRemote, head)[0] ?? null;
}

/** The release tags on origin, newest first, leaving out the commit checked out here. */
export function remoteReleases() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  return releasesNewestFirst(git("ls-remote", "--tags", "origin", "v*"), git("rev-parse", "HEAD").trim());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag] = remoteReleases();
  if (!tag) throw new Error("origin has no release tag");
  console.log(tag);
}
