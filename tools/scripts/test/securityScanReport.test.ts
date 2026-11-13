import { describe, expect, it } from "vitest";
import { allowlistReport, findingsFor, textReport } from "../security-scan.mjs";

/**
 * The scan finds an advisory once per package version and lockfile it hits: one advisory on semver, which three
 * versions in five lockfiles carry, is seven findings. Its log counts advisories by id, so that one reads as 1, and
 * each open advisory gets an ::error:: annotation, so it shows on the run's page and not only deep in its log.
 */
type Package = { ecosystem: string; name: string; version: string; dev: boolean; lockfile: string };
type Entry = { package: string; id: string; until?: string };

const SEMVER = "GHSA-c2qf-rxjj-qqgw";
const pkg = (name: string, version: string, lockfile: string): Package => ({ ecosystem: "npm", name, version, dev: false, lockfile });
const SEMVERS = [
  pkg("semver", "5.7.1", "package-lock.json"),
  pkg("semver", "6.3.0", "package-lock.json"),
  pkg("semver", "7.5.1", "package-lock.json"),
  pkg("semver", "5.7.1", "apps/website/package-lock.json"),
  pkg("semver", "6.3.0", "native/transports/hyperdht/package-lock.json"),
  pkg("semver", "7.5.1", "infra/services/hyperdht-relay/package-lock.json"),
  pkg("semver", "7.5.1", "native/translation/package-lock.json"),
];

/** OSV, faked: `vulnerable` maps a package name to the advisory ids it has; every advisory's detail is fixed. */
function fakeOsv(vulnerable: Record<string, string[]>) {
  return async (url: string, body?: { queries: { package: { name: string } }[] }) => {
    if (body) return { results: body.queries.map((q) => ({ vulns: (vulnerable[q.package.name] ?? []).map((id) => ({ id })) })) };
    const id = url.slice(url.lastIndexOf("/") + 1);
    return { id, summary: `${id} summary`, database_specific: { severity: "HIGH" }, affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "7.5.2" }] }] }] };
  };
}

async function scan(packages: Package[], vulnerable: Record<string, string[]>, allowlist: Entry[] = []) {
  const findings = await findingsFor(packages, fakeOsv(vulnerable));
  const { accepted, unused, expired } = allowlistReport(allowlist, findings, "2026-11-13");
  for (const f of findings) f.accepted = accepted(f);
  return textReport({ scanned: packages.length, lockfiles: 7, findings, unused, expired, warnUnused: false }) as string[];
}

describe("The dependency scan's log", () => {
  it("counts one advisory on seven package versions and lockfiles as one, and says it is open", async () => {
    const lines = await scan(SEMVERS, { semver: [SEMVER] });
    expect(lines[0]).toBe("Scanned 7 packages in 7 lockfiles: 1 advisory in 7 package/lockfile pairs, 1 not accepted; allowlist: 0 unused, 0 expired.");
    expect(lines.filter((l) => l.startsWith("  [OPEN] semver "))).toHaveLength(7);
  });

  it("annotates each open advisory once, with every version and lockfile it hits", async () => {
    const lines = await scan([...SEMVERS, pkg("lodash", "4.17.15", "package-lock.json")], { semver: [SEMVER], lodash: ["GHSA-p6mc-m468-83gw"] });
    expect(lines[0]).toMatch(/: 2 advisories in 8 package\/lockfile pairs, 2 not accepted;/);
    expect(lines.filter((l) => l.startsWith("::"))).toEqual([
      `::error::Open advisory ${SEMVER} (HIGH): ${SEMVER} summary. In semver 5.7.1 (package-lock.json, apps/website/package-lock.json), semver 6.3.0 (package-lock.json, native/transports/hyperdht/package-lock.json), semver 7.5.1 (package-lock.json, infra/services/hyperdht-relay/package-lock.json, native/translation/package-lock.json); update past the fix (7.5.2) or accept it in .github/security-allowlist.json.`,
      "::error::Open advisory GHSA-p6mc-m468-83gw (HIGH): GHSA-p6mc-m468-83gw summary. In lodash 4.17.15 (package-lock.json); update past the fix (7.5.2) or accept it in .github/security-allowlist.json.",
    ]);
  });

  it("does not annotate an accepted advisory, nor count it as open", async () => {
    const lines = await scan(SEMVERS, { semver: [SEMVER] }, [{ package: "semver", id: SEMVER, until: "2099-12-31" }]);
    expect(lines[0]).toBe("Scanned 7 packages in 7 lockfiles: 1 advisory in 7 package/lockfile pairs, 0 not accepted; allowlist: 0 unused, 0 expired.");
    expect(lines.filter((l) => l.startsWith("::"))).toEqual([]);
  });
});
