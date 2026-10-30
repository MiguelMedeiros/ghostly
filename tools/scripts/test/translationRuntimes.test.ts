import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_PLATFORMS, archiveName, pinnedRuntimes, publishedRuntimes, runtimeProblems, runtimeVersion } from "../translation-runtimes.mjs";

/**
 * A release that carries translation (TRANSLATE_FROM in release.yml) stops before any Desktop build when a platform
 * build-tauri builds has no RUNTIMES entry, or an entry is not the archive translation-runtime-v<RUNTIME_VERSION>
 * published: that computer could never download the runtime.
 */
const root = resolve(import.meta.dirname, "../../..");
const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const version = runtimeVersion(readFileSync(resolve(root, "apps/desktop/src/translate.rs"), "utf8"));
const pinned = pinnedRuntimes(readFileSync(resolve(root, "apps/desktop/src/translate_models.rs"), "utf8"));

/** A job of the workflow, by its key: its text up to the next job. */
function job(key: string): string {
  const start = workflow.indexOf(`\n  ${key}:\n`);
  if (start < 0) throw new Error(`release.yml has no job "${key}"`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return workflow.slice(start, next < 0 ? undefined : start + 1 + next + 1);
}

/** One step of the guard job, by name: its text up to the next step. */
function step(name: string): string {
  const guard = job("guard");
  const start = guard.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`release.yml's guard job has no step "${name}"`);
  const next = guard.indexOf("\n      - name: ", start + 1);
  return guard.slice(start, next < 0 ? undefined : next + 1);
}

const STEP = "Check the translation runtime the app pins";
const sha = (char: string) => char.repeat(64);
const table = (entries: string) => `const RUNTIMES: &[(&str, u64, &str)] = &[${entries}];\nconst RUNTIME_URL: &str = "";`;
const entry = (platform: string, size: string, hash: string) => `\n    (\n        "${platform}",\n        ${size},\n        "${hash}",\n    ),`;
const all = table(DESKTOP_PLATFORMS.map((platform, i) => entry(platform, `1_000_00${i}`, sha(String(i)))).join(""));
const runtimesTxt = (lines: [string, number, string][]) => lines.map((line) => line.join(" ")).join("\n") + "\n";
const asPublished = () => ({
  published: publishedRuntimes(runtimesTxt(DESKTOP_PLATFORMS.map((platform, i) => [platform, 1_000_000 + i, sha(String(i))]))),
  sha256: new Map(DESKTOP_PLATFORMS.map((platform, i) => [archiveName("0.1.0", platform), sha(String(i))])),
});

describe("the pins", () => {
  it("read RUNTIMES as Rust writes it, the digit separators of the sizes included", () => {
    expect(pinnedRuntimes(all).get("darwin-x64")).toEqual({ size: 1_000_002, sha256: sha("2") });
    expect([...pinnedRuntimes(table("")).keys()]).toEqual([]);
    expect(() => pinnedRuntimes("const OTHER: &[u8] = &[];")).toThrow(/no RUNTIMES/);
  });

  it("an empty table, or one missing a platform, fails each platform it misses", () => {
    expect(runtimeProblems({ version: "0.1.0", pinned: pinnedRuntimes(table("")) })).toEqual(
      DESKTOP_PLATFORMS.map((platform) => `RUNTIMES has no entry for ${platform}: copy runtimes.txt of translation-runtime-v0.1.0 into it`),
    );
    const noWindows = pinnedRuntimes(all);
    noWindows.delete("win32-x64");
    expect(runtimeProblems({ version: "0.1.0", pinned: noWindows, ...asPublished() })).toEqual(["RUNTIMES has no entry for win32-x64: copy runtimes.txt of translation-runtime-v0.1.0 into it"]);
  });

  it("are the published archives: the size and SHA-256 of runtimes.txt, and the SHA-256 of each .sha256 file", () => {
    expect(runtimeProblems({ version: "0.1.0", pinned: pinnedRuntimes(all), ...asPublished() })).toEqual([]);

    const other = asPublished();
    other.published.set("linux-x64", { size: 1_000_000, sha256: sha("f") });
    other.sha256.set(archiveName("0.1.0", "linux-x64"), sha("f"));
    expect(runtimeProblems({ version: "0.1.0", pinned: pinnedRuntimes(all), ...other })).toEqual([
      `RUNTIMES pins linux-x64 as 1000000 bytes, sha256 ${sha("0")}; translation-runtime-v0.1.0's runtimes.txt has 1000000 bytes, sha256 ${sha("f")}`,
      `RUNTIMES pins linux-x64 as sha256 ${sha("0")}; ${archiveName("0.1.0", "linux-x64")}.sha256 has ${sha("f")}`,
    ]);

    const bigger = asPublished();
    bigger.published.set("darwin-arm64", { size: 7, sha256: sha("1") });
    expect(runtimeProblems({ version: "0.1.0", pinned: pinnedRuntimes(all), ...bigger })).toHaveLength(1);

    const missing = asPublished();
    missing.published.delete("darwin-x64");
    missing.sha256.delete(archiveName("0.1.0", "win32-x64"));
    expect(runtimeProblems({ version: "0.1.0", pinned: pinnedRuntimes(all), ...missing })).toEqual([
      "translation-runtime-v0.1.0 published no archive for darwin-x64, which RUNTIMES pins",
      `translation-runtime-v0.1.0 has no ${archiveName("0.1.0", "win32-x64")}.sha256`,
    ]);
  });

  it("are for the runtime version of the release the app downloads from: a bump not pinned yet fails", () => {
    expect(runtimeProblems({ version: "0.2.0", pinned: pinnedRuntimes(all), ...asPublished() })).toHaveLength(DESKTOP_PLATFORMS.length);
  });

  it("are the platforms build-tauri builds the Desktop app for, and the app pins every one", () => {
    const node: Record<string, string> = {
      "x86_64-unknown-linux-gnu": "linux-x64",
      "aarch64-apple-darwin": "darwin-arm64",
      "x86_64-apple-darwin": "darwin-x64",
      "x86_64-pc-windows-msvc": "win32-x64",
    };
    const targets = [...job("build-tauri").matchAll(/^ {12}target: (\S+)$/gm)].map(([, target]) => node[target] ?? target);
    expect(targets.sort()).toEqual([...DESKTOP_PLATFORMS].sort());
    expect(runtimeProblems({ version, pinned })).toEqual([]);
  });
});

describe("the release", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the step's script as Actions does, with a `gh` that serves `files` as the runtime's release, or has none. */
  function check(files: Record<string, string> | null): { ok: boolean; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "release-runtimes-"));
    dirs.push(dir);
    symlinkSync(join(root, "tools"), join(dir, "tools"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "release"));
    for (const [name, text] of Object.entries(files ?? {})) writeFileSync(join(dir, "release", name), text);
    // gh release download <tag> --dir <folder> ...: copies the release's files when the tag is the pinned one.
    const gh = `#!/bin/bash\n[[ "$1 $2 $3 $4" == "release download translation-runtime-v${version} --dir" ]] || exit 1\n${files ? `cp "${join(dir, "release")}"/* "$5"/` : "exit 1"}\n`;
    writeFileSync(join(dir, "bin", "gh"), gh);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const text = step(STEP);
    const script = text.slice(text.indexOf("        run: |\n") + 15).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
    try {
      const out = execFileSync("bash", ["-e", "-c", script], { cwd: dir, env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` }, encoding: "utf8", stdio: "pipe" });
      return { ok: true, out };
    } catch (error) {
      const { stdout, stderr } = error as { stdout: string; stderr: string };
      return { ok: false, out: stdout + stderr };
    }
  }

  /** The runtime's release as the `Translation runtime` workflow publishes it, for the app's own pins. */
  const release = (edit: (lines: [string, number, string][]) => void = () => {}) => {
    const lines: [string, number, string][] = [...pinned].map(([platform, { size, sha256 }]) => [platform, size, sha256]);
    edit(lines);
    return {
      "runtimes.txt": runtimesTxt(lines),
      ...Object.fromEntries(lines.map(([platform, , sha256]) => [`${archiveName(version, platform)}.sha256`, `${sha256}  ${archiveName(version, platform)}\n`])),
    };
  };

  it("runs in the guard job, before any Desktop build, and only for a tag that carries translation", () => {
    expect(step(STEP)).toContain("        if: steps.translate.outputs.translate == 'true'\n");
    expect(job("guard").indexOf(`- name: ${STEP}`)).toBeGreaterThan(job("guard").indexOf("        id: translate\n"));
    expect(job("build-tauri")).toContain("    needs: [guard]\n");
  });

  it("goes on when the app pins the archives its runtime's release published", () => {
    const { ok, out } = check(release());
    expect(out).toContain(`The Desktop app pins translation runtime ${version}`);
    expect(ok).toBe(true);
  });

  it("stops when a pin is not the published archive, or the release has none of it", () => {
    const changed = check(release((lines) => (lines[0][2] = sha("e"))));
    expect(changed.ok).toBe(false);
    expect(changed.out).toContain(`::error::RUNTIMES pins ${[...pinned.keys()][0]} as`);

    const short = check(release((lines) => lines.pop()));
    expect(short.ok).toBe(false);
    expect(short.out).toContain("published no archive for");
  });

  it("stops when the runtime's release does not exist", () => {
    const { ok, out } = check(null);
    expect(ok).toBe(false);
    expect(out).toContain(`::error::The app pins translation runtime ${version}, and translation-runtime-v${version} has no runtimes.txt`);
  });
});
