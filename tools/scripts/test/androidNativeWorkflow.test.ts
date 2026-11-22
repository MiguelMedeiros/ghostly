import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RUST_INPUTS } from "../ci-changes.mjs";

/**
 * android-native.yml is the pull request lane that builds the Rust workspace for Android (debug APKs, then the
 * emulator). The build reads the workspace's crates and its root files: Cargo.toml (members, the vendored tauri
 * patch), Cargo.lock and rust-toolchain.toml (rustup finds it above apps/desktop, whatever the workflow installs). A
 * pull request that changes only a root file (#6048 pinned Rust for every build, Android targets included) merged
 * without an Android build.
 */
const root = resolve(import.meta.dirname, "../../..");
const text = readFileSync(resolve(root, ".github/workflows/android-native.yml"), "utf8");
const on = text.match(/^on:\n((?: {2}.*\n|\n)+)/m)?.[1] ?? "";
const paths = [...(on.match(/^ {4}paths:\n((?: {6}- .*\n)+)/m)?.[1] ?? "").matchAll(/^ {6}- "(.+)"$/gm)].map((m) => m[1]);

/** A workflow `paths` glob as a RegExp: `**` any folders, `*` within one name. */
const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*/g, (m) => (m === "*" ? "[^/]*" : ".*"))}$`);
const covered = (file: string) => paths.some((p) => glob(p).test(file));

/** The workspace's members, from the root Cargo.toml. */
const members = [...(readFileSync(resolve(root, "Cargo.toml"), "utf8").match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);

describe("android-native.yml", () => {
  it("reads its pull request paths", () => {
    expect(paths).toContain(".github/workflows/android-native.yml");
    expect(members).toEqual(expect.arrayContaining(["apps/desktop", "native/transports"]));
  });

  it("runs for every crate of the workspace", () => {
    for (const member of members) expect(covered(`${member}/src/lib.rs`), member).toBe(true);
  });

  it("runs for the root files the Rust job reads: the workspace manifest, its lock and the toolchain", () => {
    const rootFiles = RUST_INPUTS.filter((p: string) => !p.includes("/"));
    expect(rootFiles).toEqual(expect.arrayContaining(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]));
    for (const file of rootFiles) expect(covered(file), file).toBe(true);
  });
});
