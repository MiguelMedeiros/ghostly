#!/usr/bin/env node
/**
 * Whether the web image's `latest` tag may move to a release's image (web-latest.yml). Self-hosters pull
 * `ghcr.io/miguelmedeiros/ghostly-web:latest` (infra/docker-compose.yml), so it only ever names a release that
 * is published, is GitHub's Latest, and has no published release above it: a draft that is never published,
 * or an old tag built again, leaves it where it is.
 *
 *   node tools/scripts/web-latest.mjs <tag> <GitHub's latest release tag> < published release tags, one per line
 *
 * Prints `move=true` or `move=false` (appended to GITHUB_OUTPUT when set) and why, on stderr.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** A release tag's version as numbers, or null for anything else (a pre-release, a stray tag). */
export function version(tag) {
  const match = RELEASE.exec(tag.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Why `latest` must not move to `tag`, or null when it may. `published` are the published, non-pre-release tags. */
export function refusal(tag, latest, published) {
  const own = version(tag);
  if (!own) return `${tag} is not a release tag (vX.Y.Z)`;
  if (!published.some((other) => other.trim() === tag)) return `${tag} has no published release`;
  if (latest.trim() !== tag) return `GitHub's latest release is ${latest || "none"}, not ${tag}`;
  for (const other of published) {
    const theirs = version(other);
    if (!theirs) continue;
    const order = theirs.map((n, i) => n - own[i]).find((d) => d !== 0) ?? 0;
    if (order > 0) return `${other.trim()} is published and newer than ${tag}`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag = "", latest = ""] = process.argv.slice(2);
  const published = readFileSync(0, "utf8").split("\n").filter((line) => line.trim());
  const why = refusal(tag, latest, published);
  console.error(why ? `latest stays where it is: ${why}` : `latest moves to ${tag}`);
  const line = `move=${why ? "false" : "true"}\n`;
  process.stdout.write(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
}
