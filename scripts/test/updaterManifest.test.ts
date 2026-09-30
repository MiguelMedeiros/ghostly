import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// covers: app.updates.desktop

const script = resolve(import.meta.dirname, "../updater-manifest.mjs");

const BUNDLES = {
  "tauri-macOS-arm64": "Ghostly.app.tar.gz",
  "tauri-macOS-x64": "Ghostly.app.tar.gz",
  "tauri-Linux-x64": "Ghostly_1.2.3_amd64.AppImage",
  "tauri-Windows-x64": "Ghostly_1.2.3_x64-setup.exe",
};

/** A `.sig` as `tauri build` writes it: the minisign text, base64. Tauri CLI 2.12 adds `version:` to the trusted comment. */
function signature(file: string, version: string | null) {
  const trusted = ["timestamp:1790741014", `file:${file}`, ...(version === null ? [] : [`version:${version}`])].join("\t");
  const text = `untrusted comment: signature from tauri secret key\nRUQAAAAA\ntrusted comment: ${trusted}\nAAAAAAAA\n`;
  return Buffer.from(text).toString("base64");
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function run(versions: Partial<Record<keyof typeof BUNDLES, string | null>>, fallback: string | null, tag = "v1.2.3") {
  const base = mkdtempSync(join(tmpdir(), "ghostly-updater-manifest-"));
  dirs.push(base);
  for (const [artifact, file] of Object.entries(BUNDLES)) {
    const dir = join(base, "artifacts", artifact);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), "bundle");
    const version = artifact in versions ? versions[artifact as keyof typeof BUNDLES]! : fallback;
    writeFileSync(join(dir, `${file}.sig`), signature(file, version));
  }
  const out = join(base, "out");
  const result = spawnSync(process.execPath, [script, join(base, "artifacts"), out, tag], { encoding: "utf8" });
  return { ...result, out };
}

describe("the updater manifest", () => {
  it("is written when every signature was made for the tagged version", () => {
    const { status, out, stderr } = run({}, "1.2.3");
    expect(status, stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    expect(manifest.version).toBe("1.2.3");
    expect(Object.keys(manifest.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
  });

  it("is refused when a bundle was built as another version, which every installed app would reject", () => {
    const { status, stderr } = run({ "tauri-Windows-x64": "1.2.2" }, "1.2.3");
    expect(status).toBe(1);
    expect(stderr).toContain("windows-x86_64 was built as 1.2.2");
  });

  it("still takes a signature that records no version (made by hand, or by an older CLI)", () => {
    const { status, stderr } = run({}, null);
    expect(status, stderr).toBe(0);
    expect(stderr).toContain("records no version");
  });
});
