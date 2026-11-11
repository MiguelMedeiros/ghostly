import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCKFILES, allowlistReport, cargoPackages, npmPackages } from "../security-scan.mjs";

/**
 * An entry in .github/security-allowlist.json accepts one advisory on one package. Once no lockfile has an affected
 * version (the package left the tree, or moved past the fix) the entry accepts nothing, and stays until the day a
 * downgrade brings an affected version back: then the scan accepts it without a word. The scan reports every entry
 * that matched no advisory this run and every entry past its `until`, so they are removed when they stop applying.
 */
type Entry = { package: string; id: string; until?: string };
type Finding = { name: string; id: string };

const root = resolve(import.meta.dirname, "../../..");
const entry = (pkg: string, id: string, until?: string): Entry => ({ package: pkg, id, ...(until ? { until } : {}) });
const finding = (name: string, id: string): Finding => ({ name, id });

describe("The dependency scan's allowlist", () => {
  const today = "2026-11-11";

  it("accepts an advisory its entry names, for that package, until the entry's day", () => {
    const report = allowlistReport([entry("glib", "RUSTSEC-2024-0429", "2026-11-11"), entry("paste", "RUSTSEC-2024-0436")], [finding("glib", "RUSTSEC-2024-0429")], today);
    expect(report.accepted(finding("glib", "RUSTSEC-2024-0429"))).toBe(true);
    expect(report.accepted(finding("glib", "GHSA-wrw7-89jp-8q8g"))).toBe(false);
    expect(report.accepted(finding("gio", "RUSTSEC-2024-0429"))).toBe(false);
  });

  it("names an entry that no advisory of the scan matched as unused", () => {
    const report = allowlistReport(
      [entry("glib", "RUSTSEC-2024-0429", "2026-12-31"), entry("unic-common", "RUSTSEC-2025-0080", "2026-12-31"), entry("zod", "GHSA-mrhx-c7xc-m3w5", "2026-11-30")],
      [finding("glib", "RUSTSEC-2024-0429"), finding("zod", "GHSA-other")],
      today,
    );
    expect(report.unused.map((e: Entry) => `${e.package} ${e.id}`)).toEqual(["unic-common RUSTSEC-2025-0080", "zod GHSA-mrhx-c7xc-m3w5"]);
    expect(report.expired).toEqual([]);
  });

  it("names an entry past its day as expired, whether or not it still matches, and no longer accepts it", () => {
    const report = allowlistReport([entry("zip", "RUSTSEC-2026-0367", "2026-10-24"), entry("lru", "RUSTSEC-2026-0253", "2026-11-10")], [finding("lru", "RUSTSEC-2026-0253")], today);
    expect(report.expired.map((e: Entry) => e.id)).toEqual(["RUSTSEC-2026-0367", "RUSTSEC-2026-0253"]);
    expect(report.unused).toEqual([]);
    expect(report.accepted(finding("lru", "RUSTSEC-2026-0253"))).toBe(false);
  });

  it("names only packages some scanned lockfile has", () => {
    const names = new Set(LOCKFILES.flatMap(({ ecosystem, file }: { ecosystem: string; file: string }) => (ecosystem === "npm" ? npmPackages(file) : cargoPackages(file))).map((p: { name: string }) => p.name));
    const { accepted } = JSON.parse(readFileSync(join(root, ".github/security-allowlist.json"), "utf8")) as { accepted: Entry[] };
    expect(accepted.filter((a) => !names.has(a.package)).map((a) => `${a.package} ${a.id}`)).toEqual([]);
  });
});
