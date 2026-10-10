import { describe, expect, it } from "vitest";
import { bump, runGate } from "./autoreleaseGate.ts";

const registry = (name: string, version: string) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: "sha512-x" });
const npmLock = (packages: Record<string, unknown>) => ({ name: "ghostly", lockfileVersion: 3, packages: { "": { name: "ghostly" }, "apps/web": { name: "@ghostly/web" }, "node_modules/@ghostly/web": { resolved: "apps/web", link: true }, ...packages } });
const npmBump = (main: Record<string, unknown>, branch: Record<string, unknown>) =>
  bump({
    files: [{ filename: "package-lock.json", additions: 4, deletions: 4 }],
    main: { "package-lock.json": npmLock(main) },
    branch: { "package-lock.json": npmLock(branch) },
  });
const crate = (name: string, version: string, source?: string) => `[[package]]\nname = "${name}"\nversion = "${version}"\n${source ? `source = "${source}"\n` : ""}`;
const cratesIo = "registry+https://github.com/rust-lang/crates.io-index";
const cargoBump = (main: string[], branch: string[]) =>
  bump({
    files: [{ filename: "Cargo.lock", additions: 2, deletions: 2 }],
    main: { "Cargo.lock": `version = 4\n\n${main.join("\n")}` },
    branch: { "Cargo.lock": `version = 4\n\n${branch.join("\n")}` },
  });

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
});
