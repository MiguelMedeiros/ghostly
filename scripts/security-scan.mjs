#!/usr/bin/env node
/**
 * Known vulnerabilities in every dependency we ship or build with:
 *
 *   node scripts/security-scan.mjs [--json]
 *
 * Reads package-lock.json, website/package-lock.json and Cargo.lock, asks
 * OSV (https://osv.dev: GitHub advisories, RustSec, npm) about each exact
 * version, and exits 1 if anything is affected that is not accepted in
 * .github/security-allowlist.json. Needs no dependencies and no npm audit
 * endpoint.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

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

const packages = [
  ...npmPackages("package-lock.json"),
  ...npmPackages("website/package-lock.json"),
  ...cargoPackages("Cargo.lock"),
];

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
const accepted = (hit) =>
  allowlist.some((a) => a.id === hit.id && a.package === hit.name && (!a.until || a.until >= today));

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
  console.log(JSON.stringify({ scanned: packages.length, findings }, null, 2));
} else {
  console.log(`Scanned ${packages.length} packages: ${findings.length} advisories, ${open.length} not accepted.`);
  for (const f of findings) {
    const mark = f.accepted ? "accepted" : "OPEN";
    console.log(`  [${mark}] ${f.name} ${f.version} (${f.lockfile}${f.dev ? ", dev" : ""}) ${f.id} ${f.severity}: ${f.summary}${f.fixed.length ? ` → fixed in ${f.fixed.join(", ")}` : ""}`);
  }
}
process.exit(open.length ? 1 : 0);
