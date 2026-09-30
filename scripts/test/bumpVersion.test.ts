import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { versionedJson, workspaces } from "../bump-version.mjs";

const root = resolve(import.meta.dirname, "../..");
const json = (base: string, file: string) => JSON.parse(readFileSync(join(base, file), "utf8"));

describe("bump-version", () => {
  it("moves the root and every workspace the root package.json names", () => {
    expect(workspaces(root)).toEqual(expect.arrayContaining(["extension", "web", "packages/cli", "packages/core", "packages/iroh-web"]));
    for (const folder of workspaces(root)) expect(versionedJson(root), folder).toContain(`${folder}/package.json`);
    // Packages with a version of their own stay out.
    for (const file of ["website/package.json", "examples/sdk-adapter/package.json", "native-transports/hyperdht/package.json"]) {
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
        "src-tauri/Cargo.toml",
        "Cargo.lock",
        "website/lib/release.ts",
        "docs/INSTALLATION.md",
        "CHANGELOG.md",
        "scripts/bump-version.mjs",
        "scripts/changes.mjs",
      ];
      for (const file of files) {
        mkdirSync(dirname(join(copy, file)), { recursive: true });
        cpSync(join(root, file), join(copy, file));
      }
      // One synthetic entry, so the repository's own changes/ never decides whether this passes.
      mkdirSync(join(copy, "changes"));
      writeFileSync(join(copy, "changes/bump-test.md"), "---\nsection: Fixed\n---\n- A test entry.\n");

      const next = "9.9.9";
      execFileSync(process.execPath, [join(copy, "scripts/bump-version.mjs"), next], {
        cwd: copy,
        stdio: "pipe",
        env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" },
      });

      for (const file of versionedJson(copy)) expect(json(copy, file).version, file).toBe(next);
      const lock = json(copy, "package-lock.json");
      expect(lock.version).toBe(next);
      expect(lock.packages[""].version).toBe(next);
      for (const folder of workspaces(copy)) expect(lock.packages[folder]?.version, `package-lock.json: ${folder}`).toBe(next);
      expect(readFileSync(join(copy, "CHANGELOG.md"), "utf8")).toMatch(new RegExp(`^## ${next.replaceAll(".", "\\.")}$`, "m"));
      expect(existsSync(join(copy, "changes/bump-test.md"))).toBe(false);
    });
  });
});
