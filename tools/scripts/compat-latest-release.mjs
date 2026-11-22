#!/usr/bin/env node
/**
 * The newest release the current app is tested against (e2e/compat/), read from the tags so that it does not go stale:
 * a contact who has not updated yet is most often on the release before this one. The commit under test is left out, so
 * the gate of a release tests it against the release before, not against itself. A pre-release or a stray tag is no
 * release.
 *
 *   node tools/scripts/compat-latest-release.mjs   # prints e.g. v1.7.2
 *
 * Asks the remote: a CI checkout has no tags. A remote that does not answer is asked again (remoteReleases).
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

const git = (args, options) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26, ...options });

/**
 * The release tags on origin, newest first, leaving out the commit checked out here. `git ls-remote` has no connect
 * timeout of its own: where github.com does not answer the connect, it fails only when the kernel gives up on it, after
 * some 130 s. It is stopped after `timeout` ms and tried again, 4 times, 2, 4 then 8 seconds apart, then throws.
 */
export async function remoteReleases({ run = git, attempts = 4, timeout = 20_000, backoff = 2000, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = () => {} } = {}) {
  const head = run(["rev-parse", "HEAD"]).trim();
  for (let attempt = 1; ; attempt++) {
    try {
      return releasesNewestFirst(run(["ls-remote", "--tags", "origin", "v*"], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }), head);
    } catch (error) {
      const reason = error?.code === "ETIMEDOUT" ? `no answer in ${timeout / 1000} s` : String(error?.stderr || error?.message || error).trim().split("\n")[0];
      if (attempt >= attempts) throw new Error(`git ls-remote origin: ${reason} (${attempts} attempts)`);
      log(`git ls-remote origin: ${reason}, trying again`);
      await sleep(backoff * 2 ** (attempt - 1));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag] = await remoteReleases({ log: (line) => console.error(line) });
  if (!tag) throw new Error("origin has no release tag");
  console.log(tag);
}
