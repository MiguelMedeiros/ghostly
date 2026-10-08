import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guardProblems, versionedJson, workspaces } from "../bump-version.mjs";

const root = resolve(import.meta.dirname, "../../..");
const json = (base: string, file: string) => JSON.parse(readFileSync(join(base, file), "utf8"));

describe("bump-version", () => {
  it("moves the root and every workspace the root package.json names", () => {
    expect(workspaces(root)).toEqual(expect.arrayContaining(["apps/extension", "apps/web", "packages/cli", "packages/core", "packages/iroh-web"]));
    for (const folder of workspaces(root)) expect(versionedJson(root), folder).toContain(`${folder}/package.json`);
    // Packages with a version of their own stay out.
    for (const file of ["apps/website/package.json", "packages/sdk/examples/adapter/package.json", "native/transports/hyperdht/package.json"]) {
      expect(versionedJson(root)).not.toContain(file);
    }
  });

  it("keeps every workspace at the app's version, and the lockfile agrees", () => {
    const version = json(root, "package.json").version;
    const lock = json(root, "package-lock.json");
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
    for (const folder of workspaces(root)) {
      expect(json(root, `${folder}/package.json`).version, folder).toBe(version);
      expect(lock.packages[folder]?.version, `package-lock.json: ${folder}`).toBe(version);
    }
  });

  describe("on a copy of the repository", () => {
    const copy = mkdtempSync(join(tmpdir(), "ghostly-bump-"));
    afterAll(() => rmSync(copy, { recursive: true, force: true }));

    it("sets one new version in every workspace, the lockfile and the other places", { timeout: 120_000 }, () => {
      const files = [
        ...versionedJson(root),
        "package-lock.json",
        "apps/desktop/Cargo.toml",
        "Cargo.lock",
        "apps/website/lib/release.ts",
        "docs/INSTALLATION.md",
        "CHANGELOG.md",
        "tools/scripts/bump-version.mjs",
        "tools/scripts/changes.mjs",
        "packages/browser/src/shared/features.ts",
      ];
      for (const file of files) {
        mkdirSync(dirname(join(copy, file)), { recursive: true });
        cpSync(join(root, file), join(copy, file));
      }
      // One synthetic entry, so the repository's own docs/changelog/unreleased/ never decides whether this passes.
      mkdirSync(join(copy, "docs/changelog/unreleased"), { recursive: true });
      writeFileSync(join(copy, "docs/changelog/unreleased/bump-test.md"), "---\nsection: Fixed\n---\n- A test entry.\n");
      // And one held for a release after the bump's: it stays in the folder, out of the changelog.
      writeFileSync(join(copy, "docs/changelog/unreleased/bump-held.md"), "---\nsection: Fixed\nrelease: 99.0\n---\n- A held entry.\n");

      const next = "9.9.9";
      execFileSync(process.execPath, [join(copy, "tools/scripts/bump-version.mjs"), next], {
        cwd: copy,
        stdio: "pipe",
        env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" },
      });

      for (const file of versionedJson(copy)) expect(json(copy, file).version, file).toBe(next);
      const lock = json(copy, "package-lock.json");
      expect(lock.version).toBe(next);
      expect(lock.packages[""].version).toBe(next);
      for (const folder of workspaces(copy)) expect(lock.packages[folder]?.version, `package-lock.json: ${folder}`).toBe(next);
      const changelog = readFileSync(join(copy, "CHANGELOG.md"), "utf8");
      expect(changelog).toMatch(new RegExp(`^## ${next.replaceAll(".", "\\.")}$`, "m"));
      expect(changelog).toContain("- A test entry.");
      expect(changelog).not.toContain("- A held entry.");
      expect(existsSync(join(copy, "docs/changelog/unreleased/bump-test.md"))).toBe(false);
      expect(existsSync(join(copy, "docs/changelog/unreleased/bump-held.md"))).toBe(true);
    });
  });

  describe("the apps flag", () => {
    const FEATURES = "packages/browser/src/shared/features.ts";
    const dirs: string[] = [];
    afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
    const withFlag = (value: string) => {
      const dir = mkdtempSync(join(tmpdir(), "ghostly-guard-"));
      dirs.push(dir);
      mkdirSync(join(dir, dirname(FEATURES)), { recursive: true });
      writeFileSync(join(dir, FEATURES), `export const OTHER: boolean = true;\nexport const APPS_ENABLED: boolean = ${value};\n`);
      return dir;
    };

    it("is off in the repository, so a 1.1.x patch can be cut from dev", () => {
      expect(guardProblems(root, "1.1.99")).toEqual([]);
    });

    it("stops a version before 1.2.0 while it is on, and lets 1.2.0 and later go", () => {
      const on = withFlag("true");
      const off = withFlag("false");
      for (const version of ["1.1.7", "1.1.99", "0.9.0"]) {
        expect(guardProblems(on, version), version).toEqual([expect.stringMatching(/APPS_ENABLED is true.*1\.2\.0/)]);
        expect(guardProblems(off, version), version).toEqual([]);
      }
      for (const version of ["1.2.0", "1.2.1", "1.10.0", "2.0.0"]) expect(guardProblems(on, version), version).toEqual([]);
    });

    it("refuses when it cannot read the flag", () => {
      const empty = mkdtempSync(join(tmpdir(), "ghostly-guard-"));
      dirs.push(empty);
      const renamed = withFlag("true");
      writeFileSync(join(renamed, FEATURES), "export const APPS_ON = true;\n");
      expect(guardProblems(empty, "1.1.7")).toEqual([expect.stringMatching(/missing/)]);
      expect(guardProblems(renamed, "1.1.7")).toEqual([expect.stringMatching(/no "export const APPS_ENABLED/)]);
    });

    it("stops the bump before any file changes", () => {
      const copy = withFlag("true");
      for (const file of ["package.json", "tools/scripts/bump-version.mjs", "tools/scripts/changes.mjs"]) {
        mkdirSync(dirname(join(copy, file)), { recursive: true });
        cpSync(join(root, file), join(copy, file));
      }
      const before = readFileSync(join(copy, "package.json"), "utf8");
      let error: { status?: number; stderr?: Buffer } = {};
      try {
        execFileSync(process.execPath, [join(copy, "tools/scripts/bump-version.mjs"), "1.1.7"], { cwd: copy, stdio: "pipe" });
      } catch (e) {
        error = e as typeof error;
      }
      expect(error.status).toBe(1);
      expect(String(error.stderr)).toMatch(/APPS_ENABLED is true/);
      expect(readFileSync(join(copy, "package.json"), "utf8")).toBe(before);
    });
  });
});
