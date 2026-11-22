#!/usr/bin/env node
/**
 * Known vulnerabilities in every dependency we ship or build with:
 *
 *   node tools/scripts/security-scan.mjs [--json]
 *
 *   node tools/scripts/security-scan.mjs --warn-unused   (the morning run)
 *
 * Reads every lockfile in LOCKFILES, asks OSV (https://osv.dev: GitHub
 * advisories, RustSec, npm) about each exact version, and exits 1 if anything
 * is affected that is not accepted in .github/security-allowlist.json. Needs
 * no dependencies and no npm audit endpoint.
 *
 * It also exits 1 on an allowlist entry past its `until` (or with no YYYY-MM-DD `until`), and on one that no
 * advisory of this run matched (the package left every lockfile or moved past
 * the fix): left in place, it would accept a later downgrade without a word.
 * With --warn-unused, an unused entry is a warning only, so an advisory OSV
 * withdraws overnight does not turn the morning run red; a pull request that
 * makes an entry unused still fails until it removes it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The lockfiles the scan reads: the root's, and each part that ships from a lockfile of its own.
 * tools/scripts/test/securityScanCoverage.test.ts holds this list to the repository: a new lockfile goes here, or in
 * NOT_SHIPPED with why.
 */
export const LOCKFILES = [
  { ecosystem: "npm", file: "package-lock.json" },
  { ecosystem: "npm", file: "apps/website/package-lock.json" },
  { ecosystem: "crates.io", file: "Cargo.lock" },
  // The Desktop's HyperDHT sidecar: its node_modules go into every Desktop bundle.
  { ecosystem: "npm", file: "native/transports/hyperdht/package-lock.json" },
  // The HyperDHT relay for browsers, as its image installs it.
  { ecosystem: "npm", file: "infra/services/hyperdht-relay/package-lock.json" },
  // Iroh for browsers: packages/iroh-web/pkg, which the web app loads, is built from it.
  { ecosystem: "crates.io", file: "native/transports/iroh-web/Cargo.lock" },
  // The translation runtime: its node_modules go into the archive the Desktop downloads with a first language model.
  { ecosystem: "npm", file: "native/translation/package-lock.json" },
];

/** Lockfiles the scan leaves out, each with why: nothing of them reaches a person who runs Ghostly. */
export const NOT_SHIPPED = {
  "e2e/infra/atproto/package-lock.json": "The end-to-end suite's AT Protocol network: it runs on the test machine only. Dependabot keeps it current.",
};

export function npmPackages(lockfile) {
  const lock = JSON.parse(readFileSync(join(root, lockfile), "utf8"));
  const out = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.includes("node_modules/") || entry.link || !entry.version) continue;
    // An npm alias ("foo": "npm:real@1.2.3") sits at node_modules/foo and names the package it installs.
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    out.set(`${name}@${entry.version}`, { ecosystem: "npm", name, version: entry.version, dev: !!entry.dev, lockfile });
  }
  return [...out.values()];
}

export function cargoPackages(lockfile) {
  const text = readFileSync(join(root, lockfile), "utf8");
  const out = [];
  for (const block of text.split("[[package]]").slice(1)) {
    if (!block.includes('source = "registry+')) continue;
    const name = block.match(/name = "([^"]+)"/)[1];
    const version = block.match(/version = "([^"]+)"/)[1];
    out.push({ ecosystem: "crates.io", name, version, dev: false, lockfile });
  }
  return out;
}

/** A real calendar day written YYYY-MM-DD, the only `until` the scan compares (as text) with today. */
const isDay = (until) => {
  if (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return false;
  const time = Date.parse(`${until}T00:00:00Z`);
  // Date.parse takes 2026-02-30 as March 2.
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(until);
};

/**
 * Which advisories the allowlist accepts, and which of its entries no longer apply: `unused` matched none of this
 * run's findings, `expired` is past its `until` (and accepts nothing any more). An entry with no `until`, or one that
 * is not a YYYY-MM-DD day ("31/12/2026" sorts after every "2026-…" day), counts as expired: it would never expire.
 */
export function allowlistReport(allowlist, findings, today) {
  const live = (a) => isDay(a.until) && a.until >= today;
  const names = (a, f) => a.id === f.id && a.package === f.name;
  return {
    accepted: (finding) => allowlist.some((a) => live(a) && names(a, finding)),
    unused: allowlist.filter((a) => live(a) && !findings.some((f) => names(a, f))),
    expired: allowlist.filter((a) => !live(a)),
  };
}

async function osv(url, body) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    if (response.ok) return response.json();
    if (attempt === 3) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

/** One finding per advisory per package version and lockfile, from OSV's answers (`ask` is how the scan reaches OSV). */
export async function findingsFor(packages, ask = osv) {
  const hits = [];
  for (let i = 0; i < packages.length; i += 500) {
    const chunk = packages.slice(i, i + 500);
    const { results } = await ask("https://api.osv.dev/v1/querybatch", {
      queries: chunk.map(({ ecosystem, name, version }) => ({ package: { ecosystem, name }, version })),
    });
    results.forEach((result, j) => {
      for (const vuln of result.vulns ?? []) hits.push({ ...chunk[j], id: vuln.id });
    });
  }

  // An advisory hits each version and lockfile that carries the package (semver: 7 hits), its detail is the same for all.
  const details = new Map();
  const findings = [];
  for (const hit of hits) {
    if (!details.has(hit.id)) details.set(hit.id, await ask(`https://api.osv.dev/v1/vulns/${hit.id}`));
    const detail = details.get(hit.id);
    if (detail.withdrawn) continue;
    const fixed = (detail.affected ?? [])
      .flatMap((a) => a.ranges ?? [])
      .flatMap((r) => r.events ?? [])
      .map((e) => e.fixed)
      .filter(Boolean);
    const severity =
      detail.database_specific?.severity ?? (detail.id.startsWith("RUSTSEC") ? (detail.affected?.[0]?.database_specific?.informational ?? "RUSTSEC") : "UNKNOWN");
    findings.push({ ...hit, severity, summary: detail.summary ?? "", fixed });
  }
  return findings;
}

/**
 * The log of a run without --json: a count, a line per finding, and the annotations GitHub shows on the run's page.
 * Advisories are counted by id: one advisory on three versions in five lockfiles is one advisory, in seven findings.
 */
export function textReport({ scanned, lockfiles, findings, unused, expired, warnUnused }) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const byId = (list) => Map.groupBy(list, (f) => f.id);
  const open = byId(findings.filter((f) => !f.accepted));
  const lines = [
    `Scanned ${scanned} packages in ${lockfiles} lockfiles: ${plural(byId(findings).size, "advisory", "advisories")} in ${plural(findings.length, "package/lockfile pair", "package/lockfile pairs")}, ${open.size} not accepted; allowlist: ${unused.length} unused, ${expired.length} expired.`,
  ];
  for (const f of findings) {
    const mark = f.accepted ? "accepted" : "OPEN";
    lines.push(`  [${mark}] ${f.name} ${f.version} (${f.lockfile}${f.dev ? ", dev" : ""}) ${f.id} ${f.severity}: ${f.summary}${f.fixed.length ? ` → fixed in ${f.fixed.join(", ")}` : ""}`);
  }
  // Annotations, so what fails the run shows on its page, not only in its log: one per open advisory, then the entries to remove.
  const escape = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  for (const [id, hits] of open) {
    const places = [...Map.groupBy(hits, (f) => `${f.name} ${f.version}`)].map(([version, at]) => `${version} (${at.map((f) => f.lockfile).join(", ")})`);
    const fixed = [...new Set(hits.flatMap((f) => f.fixed))];
    const next = fixed.length ? `update past the fix (${fixed.join(", ")})` : "no version fixes it yet: replace the package";
    lines.push(escape(`::error::Open advisory ${id} (${hits[0].severity}): ${hits[0].summary}. In ${places.join(", ")}; ${next} or accept it in .github/security-allowlist.json.`));
  }
  const level = warnUnused ? "warning" : "error";
  for (const a of unused) lines.push(`::${level} file=.github/security-allowlist.json::Unused allowlist entry: ${a.package} ${a.id} matched no advisory in any lockfile; remove it.`);
  for (const a of expired) {
    const when = isDay(a.until) ? `until ${a.until}` : `"until" ${a.until === undefined ? "missing" : `${JSON.stringify(a.until)}, not a YYYY-MM-DD day`}`;
    lines.push(`::error file=.github/security-allowlist.json::Expired allowlist entry: ${a.package} ${a.id} (${when}); re-check it, then remove it or move its date.`);
  }
  return lines;
}

async function main() {
  const asJson = process.argv.includes("--json");
  const warnUnused = process.argv.includes("--warn-unused");
  const packages = LOCKFILES.flatMap(({ ecosystem, file }) => (ecosystem === "npm" ? npmPackages(file) : cargoPackages(file)));
  const findings = await findingsFor(packages);

  const allowlist = JSON.parse(readFileSync(join(root, ".github/security-allowlist.json"), "utf8")).accepted;
  const { accepted, unused, expired } = allowlistReport(allowlist, findings, new Date().toISOString().slice(0, 10));
  for (const f of findings) f.accepted = accepted(f);

  const open = findings.filter((f) => !f.accepted);
  const failing = open.length + expired.length + (warnUnused ? 0 : unused.length);
  if (asJson) {
    console.log(JSON.stringify({ scanned: packages.length, lockfiles: LOCKFILES.map((l) => l.file), findings, unusedEntries: unused, expiredEntries: expired }, null, 2));
  } else {
    for (const line of textReport({ scanned: packages.length, lockfiles: LOCKFILES.length, findings, unused, expired, warnUnused })) console.log(line);
  }
  process.exit(failing ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
