import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCKFILES, NOT_SHIPPED } from "../security-scan.mjs";

/**
 * The Security workflow is green when no lockfile the scan reads holds a known advisory, and the security autorelease
 * ships on that. A lockfile the scan does not read is a part of the product nobody is told about: the Desktop's
 * HyperDHT sidecar, the relay for browsers and Iroh for browsers each ship from a lockfile of their own, and the scan
 * read the root's two and the site's only. This holds its list to the tree: every lockfile is scanned, or named as
 * not shipped with the reason.
 */
const root = resolve(import.meta.dirname, "../../..");

const ECOSYSTEM: Record<string, string> = { "package-lock.json": "npm", "Cargo.lock": "crates.io" };
/** Folders made by an install or a build: no checkout has them. */
const MADE = new Set(["node_modules", "target", "dist", "build", "out"]);

/** Every lockfile of the tree, as `<ecosystem> <path>`. */
function lockfiles(dir = root, folder = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return MADE.has(entry.name) || entry.name.startsWith(".") ? [] : lockfiles(join(dir, entry.name), `${folder}${entry.name}/`);
    return ECOSYSTEM[entry.name] ? [`${ECOSYSTEM[entry.name]} ${folder}${entry.name}`] : [];
  });
}

describe("The dependency scan's lockfiles", () => {
  const scanned: string[] = LOCKFILES.map((l: { ecosystem: string; file: string }) => `${l.ecosystem} ${l.file}`);
  const left: string[] = Object.keys(NOT_SHIPPED);

  it("reads every lockfile of the repository, or names it as not shipped", () => {
    expect(lockfiles().filter((l) => !scanned.includes(l) && !left.includes(l.split(" ")[1]))).toEqual([]);
  });

  it("reads what ships outside the root: the HyperDHT sidecar, the HyperDHT relay and Iroh for browsers", () => {
    expect(scanned).toContain("npm native/transports/hyperdht/package-lock.json");
    expect(scanned).toContain("npm infra/services/hyperdht-relay/package-lock.json");
    expect(scanned).toContain("crates.io native/transports/iroh-web/Cargo.lock");
  });

  it("leaves out only test infrastructure, each with why", () => {
    expect(left).toEqual(["e2e/infra/atproto/package-lock.json"]);
    for (const why of Object.values(NOT_SHIPPED)) expect(why).toMatch(/\S/);
    expect(left.filter((file) => scanned.some((s) => s.endsWith(` ${file}`)))).toEqual([]);
  });

  it("lists only lockfiles the repository has", () => {
    expect([...LOCKFILES.map((l: { file: string }) => l.file), ...left].filter((file) => !existsSync(join(root, file)))).toEqual([]);
  });
});
