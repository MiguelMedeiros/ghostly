import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCKFILES as SCANNED } from "../security-scan.mjs";
import { bump, runGate } from "./autoreleaseGate.ts";

const registry = (name: string, version: string) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: "sha512-x" });
const npmLock = (packages: Record<string, unknown>) => ({ name: "ghostly", lockfileVersion: 3, packages: { "": { name: "ghostly" }, "apps/web": { name: "@ghostly/web" }, "node_modules/@ghostly/web": { resolved: "apps/web", link: true }, ...packages } });
const npmBump = (main: Record<string, unknown>, branch: Record<string, unknown>, lock = "package-lock.json", lines = 4) =>
  bump({
    files: [{ filename: lock, additions: lines, deletions: lines }],
    main: { [lock]: npmLock(main) },
    branch: { [lock]: npmLock(branch) },
  });
const crate = (name: string, version: string, source?: string) => `[[package]]\nname = "${name}"\nversion = "${version}"\n${source ? `source = "${source}"\n` : ""}`;
const cratesIo = "registry+https://github.com/rust-lang/crates.io-index";
const cargoBump = (main: string[], branch: string[], lock = "Cargo.lock") =>
  bump({
    files: [{ filename: lock, additions: 2, deletions: 2 }],
    main: { [lock]: `version = 4\n\n${main.join("\n")}` },
    branch: { [lock]: `version = 4\n\n${branch.join("\n")}` },
  });

// The other lock files the repository ships from: the Desktop's HyperDHT sidecar, the HyperDHT relay for browsers and
// Iroh for browsers.
const SIDECAR = "native/transports/hyperdht/package-lock.json";
const RELAY = "infra/services/hyperdht-relay/package-lock.json";
const IROH_WEB = "native/transports/iroh-web/Cargo.lock";
/** A branch that adds a dependency to `lock`, whichever kind of lock file it is. */
const addsDependency = (lock: string) =>
  lock.endsWith("Cargo.lock")
    ? cargoBump([crate("serde", "1.0.200", cratesIo)], [crate("serde", "1.0.200", cratesIo), crate("left-pad", "1.3.0", cratesIo)], lock)
    : npmBump({ "node_modules/lodash": registry("lodash", "4.17.20") }, { "node_modules/lodash": registry("lodash", "4.17.20"), "node_modules/left-pad": registry("left-pad", "1.3.0") }, lock);
const root = resolve(import.meta.dirname, "../../..");

describe("the security autorelease gate's lock file check", () => {
  it("lets versions of the same packages from the same place change", () => {
    const npm = runGate(npmBump({ "node_modules/lodash": registry("lodash", "4.17.20"), "node_modules/a/node_modules/@scope/b": registry("@scope/b", "1.0.0") }, { "node_modules/lodash": registry("lodash", "4.17.21"), "node_modules/@scope/b": registry("@scope/b", "1.0.1") }), "deps");
    expect(npm.code, npm.stderr).toBe(0);
    const cargo = runGate(cargoBump([crate("serde", "1.0.200", cratesIo), crate("ghostly", "1.1.6")], [crate("serde", "1.0.201", cratesIo), crate("ghostly", "1.1.7")]), "deps");
    expect(cargo.code, cargo.stderr).toBe(0);
  });

  it("refuses a new dependency", () => {
    const run = runGate(npmBump({ "node_modules/lodash": registry("lodash", "4.17.20") }, { "node_modules/lodash": registry("lodash", "4.17.20"), "node_modules/left-pad": registry("left-pad", "1.3.0") }), "deps");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("adds dependencies: left-pad");
  });

  it("refuses another package installed under an existing name (an npm alias)", () => {
    const run = runGate(npmBump({ "node_modules/lodash": registry("lodash", "4.17.20") }, { "node_modules/lodash": { name: "not-lodash", ...registry("not-lodash", "1.0.0") } }), "deps");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("changes where dependencies come from: lodash");
  });

  it("refuses an existing npm dependency that now comes from somewhere else", () => {
    for (const resolved of ["https://example.invalid/lodash-4.17.21.tgz", "https://registry.npmjs.org/not-lodash/-/not-lodash-1.0.0.tgz", "git+ssh://git@github.com/someone/lodash.git#abc"]) {
      const run = runGate(npmBump({ "node_modules/lodash": registry("lodash", "4.17.20") }, { "node_modules/lodash": { version: "4.17.21", resolved } }), "deps");
      expect(run.code, resolved).toBe(1);
      expect(run.stderr).toContain("changes where dependencies come from: lodash");
    }
  });

  it("refuses a workspace link turned into a download", () => {
    const run = runGate(npmBump({}, { "node_modules/@ghostly/web": registry("@ghostly/web", "9.9.9") }), "deps");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("changes where dependencies come from: @ghostly/web");
  });

  it("refuses a crate whose source moves away from crates.io", () => {
    for (const source of ["git+https://example.invalid/serde?rev=1#1", "registry+https://example.invalid/index", undefined]) {
      const run = runGate(cargoBump([crate("serde", "1.0.200", cratesIo)], [crate("serde", "1.0.200", source)]), "deps");
      expect(run.code, String(source)).toBe(1);
      expect(run.stderr).toContain("Cargo.lock changes where dependencies come from: serde");
    }
  });

  it("lets versions change in the sidecar's, the relay's and Iroh for browsers' lock files, in both modes", () => {
    for (const mode of ["all", "deps"] as const) {
      for (const lock of [SIDECAR, RELAY]) {
        const run = runGate(npmBump({ "node_modules/hyperdht": registry("hyperdht", "6.20.0") }, { "node_modules/hyperdht": registry("hyperdht", "6.20.1") }, lock), mode);
        expect(run.code, `${lock}, ${mode}: ${run.stderr}`).toBe(0);
      }
      const run = runGate(cargoBump([crate("iroh", "0.90.0", cratesIo), crate("ghostly-iroh-web", "1.1.6")], [crate("iroh", "0.90.1", cratesIo), crate("ghostly-iroh-web", "1.1.7")], IROH_WEB), mode);
      expect(run.code, `${IROH_WEB}, ${mode}: ${run.stderr}`).toBe(0);
    }
  });

  it("refuses a new dependency in any of them, with code allowed to change too", () => {
    for (const lock of [SIDECAR, RELAY, IROH_WEB]) {
      const run = runGate(addsDependency(lock), "all");
      expect(run.code, lock).toBe(1);
      expect(run.stderr).toContain(`${lock} adds dependencies: left-pad`);
    }
  });

  it("refuses a dependency of theirs that now comes from somewhere else", () => {
    for (const lock of [SIDECAR, RELAY]) {
      for (const moved of [{ version: "6.20.1", resolved: "https://example.invalid/hyperdht-6.20.1.tgz" }, { version: "6.20.1", resolved: "git+ssh://git@github.com/someone/hyperdht.git#abc" }, { name: "not-hyperdht", ...registry("not-hyperdht", "1.0.0") }]) {
        const run = runGate(npmBump({ "node_modules/hyperdht": registry("hyperdht", "6.20.0") }, { "node_modules/hyperdht": moved }, lock), "all");
        expect(run.code, `${lock}: ${moved.resolved}`).toBe(1);
        expect(run.stderr).toContain(`${lock} changes where dependencies come from: hyperdht`);
      }
    }
    for (const source of ["git+https://example.invalid/iroh?rev=1#1", "registry+https://example.invalid/index", undefined]) {
      const run = runGate(cargoBump([crate("iroh", "0.90.0", cratesIo)], [crate("iroh", "0.90.0", source)], IROH_WEB), "all");
      expect(run.code, String(source)).toBe(1);
      expect(run.stderr).toContain(`${IROH_WEB} changes where dependencies come from: iroh`);
    }
  });

  it("does not count their lines as code", () => {
    const run = runGate(npmBump({ "node_modules/hyperdht": registry("hyperdht", "6.20.0") }, { "node_modules/hyperdht": registry("hyperdht", "6.20.1") }, SIDECAR, 400), "all");
    expect(run.code, run.stderr).toBe(0);
  });

  // A lock file the gate does not know is read as code: a dependency added to it passes. Test infrastructure aside,
  // every lock file in the repository, and every one the vulnerability scan reads, has to be one the gate knows.
  it("knows every lock file the repository ships from and the scan reads", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "*package-lock.json", "*Cargo.lock"], { cwd: root, encoding: "utf8" }).split("\n").filter((file) => file && !file.startsWith("e2e/"));
    // The scan's own list: a lock file it names as not shipped (NOT_SHIPPED) is not one it reads.
    const scanned: string[] = SCANNED.map((lock: { file: string }) => lock.file);
    expect(tracked).toEqual(expect.arrayContaining(["package-lock.json", "Cargo.lock", SIDECAR, RELAY, IROH_WEB]));
    expect(scanned).toEqual(expect.arrayContaining(["package-lock.json", "Cargo.lock"]));
    for (const lock of new Set([...tracked, ...scanned])) {
      const run = runGate(addsDependency(lock), "all");
      expect(run.code, lock).toBe(1);
      expect(run.stderr).toContain(`${lock} adds dependencies: left-pad`);
    }
  });
});
