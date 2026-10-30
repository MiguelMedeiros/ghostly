#!/usr/bin/env node
/**
 * The web image of a release, checked: `ghcr.io/miguelmedeiros/ghostly-web:<tag>` counts only when GitHub holds a
 * build provenance for its digest signed by release.yml run from that very tag (release.yml's build-web attests it).
 * Any workflow of the repository can push to the package, from any branch, so the tag alone says nothing; the
 * provenance can only come from a tag a person pushed (the `v*` tag ruleset).
 *
 *   node tools/scripts/web-image.mjs <tag> [owner/repo]
 *
 * Needs `gh` logged in. Prints `<tag>@sha256:<digest>`, the value for GHOSTLY_WEB_TAG (infra/docker-compose.yml),
 * so what runs is the digest that was checked, not whatever the tag names by then; also `ref=<image>@sha256:<digest>`
 * to GITHUB_OUTPUT when set. Anything else (no provenance, another workflow, ref or repository) exits 1.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO = "MiguelMedeiros/ghostly";
const RELEASE = /^v\d+\.\d+\.\d+$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** The package's name for a repository: GitHub's registry wants it lowercase. */
export function image(repo = REPO) {
  return `ghcr.io/${repo.split("/")[0].toLowerCase()}/ghostly-web`;
}

/** `gh` arguments that verify `<image>:<tag>` was built by release.yml from `refs/tags/<tag>` of `repo`. */
export function verifyArgs(tag, repo = REPO) {
  if (!RELEASE.test(tag)) throw new Error(`${tag} is not a release tag (vX.Y.Z)`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`${repo} is not owner/repo`);
  return [
    "attestation", "verify", `oci://${image(repo)}:${tag}`,
    "--repo", repo,
    "--cert-identity", `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/${tag}`,
    "--source-ref", `refs/tags/${tag}`,
    "--deny-self-hosted-runners",
    "--format", "json",
  ];
}

/** The one sha256 digest `gh attestation verify --format json` vouched for; throws on none or more than one. */
export function verifiedDigest(json) {
  let results;
  try {
    results = JSON.parse(json);
  } catch {
    throw new Error("gh attestation verify did not answer JSON");
  }
  const digests = new Set(
    (Array.isArray(results) ? results : [])
      .flatMap((result) => result?.verificationResult?.statement?.subject ?? [])
      .map((subject) => subject?.digest?.sha256),
  );
  const [digest] = digests;
  if (digests.size !== 1 || typeof digest !== "string" || !DIGEST.test(digest)) {
    throw new Error("no single verified sha256 digest");
  }
  return digest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag = "", repo = REPO] = process.argv.slice(2);
  try {
    const args = verifyArgs(tag, repo);
    const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const digest = verifiedDigest(out);
    console.error(`${image(repo)}:${tag} is release.yml's build of ${tag}: sha256:${digest}`);
    process.stdout.write(`${tag}@sha256:${digest}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ref=${image(repo)}@sha256:${digest}\n`);
  } catch (error) {
    console.error(`${image(repo)}:${tag} is not used: ${error.message}`);
    process.exit(1);
  }
}
