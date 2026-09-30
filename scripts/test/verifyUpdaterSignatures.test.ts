import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePublicKey, signatureProblem, verifyRelease } from "../verify-updater-signatures.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/verify-updater-signatures.mjs");
const tauri = join(root, "node_modules/.bin/tauri");
const PLATFORMS = {
  "darwin-aarch64": "Ghostly_1.2.3_darwin-aarch64.app.tar.gz",
  "linux-x86_64": "Ghostly_1.2.3_amd64.AppImage",
  "windows-x86_64": "Ghostly_1.2.3_x64-setup.exe",
};

let dir: string;
let pubkey: string;

/** Signs `file` the way `tauri build` does, with a throwaway key; returns the `.sig` text. */
function sign(file: string, key = join(dir, "test.key")) {
  const env: NodeJS.ProcessEnv = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  const result = spawnSync(tauri, ["signer", "sign", "-f", key, "--app-version", "1.2.3", file], { encoding: "utf8", env });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(`${file}.sig`, "utf8").trim();
}

function generateKey(path: string) {
  const result = spawnSync(tauri, ["signer", "generate", "--ci", "-p", "", "-w", path], { encoding: "utf8", env: { ...process.env, CI: "true" } });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(`${path}.pub`, "utf8").trim();
}

/** A release directory as the release job has it: the bundles and a latest.json with their signatures. */
function release(tamper?: (dir: string) => void) {
  const out = mkdtempSync(join(dir, "release-"));
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const [platform, name] of Object.entries(PLATFORMS)) {
    const file = join(out, name);
    writeFileSync(file, `bundle for ${platform}\n`.repeat(1000));
    platforms[platform] = { signature: sign(file), url: `https://github.com/MiguelMedeiros/ghostly/releases/download/v1.2.3/${name}` };
  }
  writeFileSync(join(out, "latest.json"), JSON.stringify({ version: "1.2.3", platforms }));
  tamper?.(out);
  return out;
}

function cli(releaseDir: string) {
  const config = join(dir, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey } } }));
  return spawnSync(process.execPath, [script, releaseDir, config], { encoding: "utf8" });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-updater-signatures-"));
  pubkey = generateKey(join(dir, "test.key"));
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("verify-updater-signatures", () => {
  it("passes a release whose every bundle is the file that was signed", async () => {
    const out = release();
    const results = await verifyRelease(out, pubkey);
    expect(results.map((r) => [r.platform, r.problem])).toEqual(Object.keys(PLATFORMS).map((p) => [p, null]));
    const run = cli(out);
    expect(run.status, run.stderr).toBe(0);
  }, 60_000);

  it("fails an AppImage changed after it was signed (the 1.0.0 repack), and names it", async () => {
    // What scripts/appimage-drop-wayland-libs.sh did to 1.0.0: new bytes, the old .sig kept.
    const out = release((d) => appendFileSync(join(d, PLATFORMS["linux-x86_64"]), "repacked"));
    const results = await verifyRelease(out, pubkey);
    expect(results.find((r) => r.platform === "linux-x86_64")?.problem).toBe("the file does not match its signature");
    expect(results.filter((r) => r.problem)).toHaveLength(1);
    const run = cli(out);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("✗ linux-x86_64: Ghostly_1.2.3_amd64.AppImage: the file does not match its signature");
  }, 60_000);

  it("passes the repacked AppImage once it is signed again, as release.yml now does", async () => {
    const out = release((d) => {
      const appimage = join(d, PLATFORMS["linux-x86_64"]);
      appendFileSync(appimage, "repacked");
      const manifest = JSON.parse(readFileSync(join(d, "latest.json"), "utf8"));
      manifest.platforms["linux-x86_64"].signature = sign(appimage);
      writeFileSync(join(d, "latest.json"), JSON.stringify(manifest));
    });
    expect((await verifyRelease(out, pubkey)).every((r) => r.problem === null)).toBe(true);
  }, 60_000);

  it("fails a bundle signed with another key, and one missing from the release", async () => {
    const otherKey = join(dir, "other.key");
    generateKey(otherKey);
    const out = release((d) => {
      const exe = join(d, PLATFORMS["windows-x86_64"]);
      const manifest = JSON.parse(readFileSync(join(d, "latest.json"), "utf8"));
      manifest.platforms["windows-x86_64"].signature = sign(exe, otherKey);
      rmSync(join(d, PLATFORMS["darwin-aarch64"]));
      writeFileSync(join(d, "latest.json"), JSON.stringify(manifest));
    });
    const problems = Object.fromEntries((await verifyRelease(out, pubkey)).map((r) => [r.platform, r.problem]));
    expect(problems).toEqual({
      "darwin-aarch64": "the file is not in the release",
      "linux-x86_64": null,
      "windows-x86_64": "signed with another key",
    });
  }, 60_000);

  it("fails a signature whose trusted comment (file, version) was edited", async () => {
    const out = release();
    const file = join(out, PLATFORMS["linux-x86_64"]);
    const text = Buffer.from(readFileSync(`${file}.sig`, "utf8").trim(), "base64").toString("utf8").replace("version:1.2.3", "version:9.9.9");
    const problem = await signatureProblem(file, Buffer.from(text).toString("base64"), parsePublicKey(pubkey));
    expect(problem).toBe("the trusted comment does not match its signature");
  }, 60_000);

  it("reads the real updater key of the app", () => {
    const config = JSON.parse(readFileSync(join(root, "apps/desktop/tauri.conf.json"), "utf8"));
    expect(parsePublicKey(config.plugins.updater.pubkey).keyId).toHaveLength(8);
  });
});

describe("release.yml", () => {
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  const at = (text: string) => {
    const index = workflow.indexOf(text);
    expect(index, `release.yml should contain ${JSON.stringify(text)}`).toBeGreaterThan(-1);
    return index;
  };

  it("signs the AppImage again after the libwayland repack, with the release version", () => {
    const repack = at("scripts/appimage-drop-wayland-libs.sh");
    const resign = at("tauri signer sign");
    expect(resign).toBeGreaterThan(repack);
    expect(workflow.slice(resign, resign + 300)).toContain("--app-version");
    expect(resign).toBeLessThan(at("- name: Upload artifacts"));
  });

  it("verifies every updater signature after writing latest.json and before publishing", () => {
    const verify = at("node scripts/verify-updater-signatures.mjs release-assets");
    expect(verify).toBeGreaterThan(at("node scripts/updater-manifest.mjs"));
    expect(verify).toBeLessThan(at("- name: Generate SHA256 checksums"));
    expect(verify).toBeLessThan(at("- name: Create Release"));
  });
});
