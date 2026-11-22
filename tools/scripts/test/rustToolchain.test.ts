import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI, the release and a contributor's `cargo` build with the Rust that rust-toolchain.toml names. A channel like
 * `stable` would follow each new release, whose new clippy lints turn dev red and change what ships with nothing
 * changed in the repository; a target a workflow builds for that the file leaves out is missing from the toolchain
 * rustup installs from it.
 */
const root = resolve(import.meta.dirname, "../../..");
const toml = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
const list = (key: string) => [...(toml.match(new RegExp(String.raw`^${key}\s*=\s*\[([^\]]*)\]`, "m"))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const dir = join(root, ".github/workflows");
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => readFileSync(join(dir, f), "utf8").replace(/^\s*#.*$/gm, ""));

describe("rust-toolchain.toml", () => {
  it("pins one release, not a channel that moves", () => {
    expect(toml).toMatch(/^\[toolchain\]$/m);
    expect(toml.match(/^channel\s*=\s*"([^"]*)"/m)?.[1]).toMatch(/^1\.\d+\.\d+$/);
  });

  it("has the components CI runs", () => {
    expect(list("components")).toEqual(expect.arrayContaining(["rustfmt", "clippy"]));
  });

  it("has every target a workflow cross-compiles to", () => {
    const triple = String.raw`[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_-]+`;
    const named = workflows.flatMap((text) => [
      ...[...text.matchAll(/^\s*targets:\s*([^\s$][^\n]*)$/gm)].flatMap((m) => m[1].split(",").map((t) => t.trim())),
      ...[...text.matchAll(new RegExp(String.raw`--target\s+(${triple})`, "g"))].map((m) => m[1]),
    ]);
    expect(named).toEqual(expect.arrayContaining(["x86_64-apple-darwin", "aarch64-linux-android", "x86_64-linux-android"]));
    expect(list("targets")).toEqual(expect.arrayContaining([...new Set(named)]));
  });

  it("is the toolchain a workflow names, when one names it", () => {
    const channel = toml.match(/^channel\s*=\s*"([^"]*)"/m)?.[1];
    for (const text of workflows) for (const m of text.matchAll(/^\s*toolchain:\s*"?([\w.-]+)"?\s*$/gm)) expect(m[1]).toBe(channel);
  });
});
