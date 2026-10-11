#!/usr/bin/env node
/**
 * Known vulnerabilities in every dependency we ship or build with:
 *
 *   node tools/scripts/security-scan.mjs [--json]
 *
 * Reads every lockfile in LOCKFILES, asks OSV (https://osv.dev: GitHub
 * advisories, RustSec, npm) about each exact version, and exits 1 if anything
 * is affected that is not accepted in .github/security-allowlist.json. Needs
 * no dependencies and no npm audit endpoint.
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
];

/** Lockfiles the scan leaves out, each with why: nothing of them reaches a person who runs Ghostly. */
export const NOT_SHIPPED = {
  "e2e/infra/atproto/package-lock.json": "The end-to-end suite's AT Protocol network: it runs on the test machine only. Dependabot keeps it current.",
};

function npmPackages(lockfile) {
  const lock = JSON.parse(readFileSync(join(root, lockfile), "utf8"));
  const out = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.includes("node_modules/") || entry.link || !entry.version) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    out.set(`${name}@${entry.version}`, { ecosystem: "npm", name, version: entry.version, dev: !!entry.dev, lockfile });
  }
  return [...out.values()];
}

function cargoPackages(lockfile) {
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

async function osv(url, body) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    if (response.ok) return response.json();
    if (attempt === 3) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

async function main() {
  const asJson = process.argv.includes("--json");
  const packages = LOCKFILES.flatMap(({ ecosystem, file }) => (ecosystem === "npm" ? npmPackages(file) : cargoPackages(file)));

  const hits = [];
  for (let i = 0; i < packages.length; i += 500) {
    const chunk = packages.slice(i, i + 500);
    const { results } = await osv("https://api.osv.dev/v1/querybatch", {
      queries: chunk.map(({ ecosystem, name, version }) => ({ package: { ecosystem, name }, version })),
    });
    results.forEach((result, j) => {
      for (const vuln of result.vulns ?? []) hits.push({ ...chunk[j], id: vuln.id });
    });
  }

  const allowlist = JSON.parse(readFileSync(join(root, ".github/security-allowlist.json"), "utf8")).accepted;
  const today = new Date().toISOString().slice(0, 10);
  const accepted = (hit) => allowlist.some((a) => a.id === hit.id && a.package === hit.name && (!a.until || a.until >= today));

  const findings = [];
  for (const hit of hits) {
    const detail = await osv(`https://api.osv.dev/v1/vulns/${hit.id}`);
    if (detail.withdrawn) continue;
    const fixed = (detail.affected ?? [])
      .flatMap((a) => a.ranges ?? [])
      .flatMap((r) => r.events ?? [])
      .map((e) => e.fixed)
      .filter(Boolean);
    const severity =
      detail.database_specific?.severity ?? (detail.id.startsWith("RUSTSEC") ? (detail.affected?.[0]?.database_specific?.informational ?? "RUSTSEC") : "UNKNOWN");
    findings.push({ ...hit, severity, summary: detail.summary ?? "", fixed, accepted: accepted(hit) });
  }

  const open = findings.filter((f) => !f.accepted);
  if (asJson) {
    console.log(JSON.stringify({ scanned: packages.length, lockfiles: LOCKFILES.map((l) => l.file), findings }, null, 2));
  } else {
    console.log(`Scanned ${packages.length} packages in ${LOCKFILES.length} lockfiles: ${findings.length} advisories, ${open.length} not accepted.`);
    for (const f of findings) {
      const mark = f.accepted ? "accepted" : "OPEN";
      console.log(`  [${mark}] ${f.name} ${f.version} (${f.lockfile}${f.dev ? ", dev" : ""}) ${f.id} ${f.severity}: ${f.summary}${f.fixed.length ? ` → fixed in ${f.fixed.join(", ")}` : ""}`);
    }
  }
  process.exit(open.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
