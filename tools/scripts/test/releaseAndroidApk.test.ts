import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

/** One step of the release job, by name: its text up to the next step. */
function step(name: string): string {
  const jobs = workflow.slice(workflow.indexOf("\n  release:\n"));
  const start = jobs.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`release.yml's release job has no step "${name}"`);
  const next = jobs.indexOf("\n      - name: ", start + 1);
  return jobs.slice(start, next < 0 ? undefined : next + 1);
}

/** A step's `run: |` script, as the runner would hand it to bash. */
function script(name: string): string {
  const text = step(name);
  const lines = text.slice(text.indexOf("        run: |\n") + 15).split("\n");
  return lines.map((line) => line.replace(/^ {10}/, "")).join("\n");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs a step's script in a folder of its own, as Actions does (`bash -e`), and gives back its outputs. */
function run(name: string, env: Record<string, string>, files: string[] = []): { dir: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "release-android-"));
  dirs.push(dir);
  for (const file of files) {
    mkdirSync(resolve(dir, file, ".."), { recursive: true });
    writeFileSync(resolve(dir, file), "x");
  }
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  execFileSync("bash", ["-e", "-c", script(name)], { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env, GITHUB_OUTPUT: output }, stdio: "ignore" });
  return { dir, output: readFileSync(output, "utf8") };
}

describe("the Android APK of a release", () => {
  const desktop = "artifacts/tauri-linux/ghostly_1.2.0_amd64.deb";
  const assets = (files: string[]) => readdirSync(join(run("Prepare release assets", {}, [desktop, ...files]).dir, "release-assets")).sort();

  it("is attached when it is signed with the upload key", () => {
    expect(assets(["artifacts/android/ghostly-1.2.0-android-arm64.apk"])).toEqual(["ghostly-1.2.0-android-arm64.apk", "ghostly_1.2.0_amd64.deb"]);
    expect(run("Android note", { ANDROID_RESULT: "success", ANDROID_SIGNED: "true" }).output).toBe("note=\n");
  });

  it("is left out when the build had no upload key: a debug build is never published", () => {
    // A debug build takes the e2e launch extras and can be inspected over USB (docs/ANDROID.md).
    expect(step("Download Android artifact")).toContain("if: needs.build-android.result == 'success' && needs.build-android.outputs.signed == 'true'\n");
    expect(assets(["artifacts/android/ghostly-1.2.0-android-arm64-debug.apk"])).toEqual(["ghostly_1.2.0_amd64.deb"]);
    expect(assets(["artifacts/android/ghostly-1.2.0-android-arm64-throwaway.apk"])).toEqual(["ghostly_1.2.0_amd64.deb"]);
    for (const signed of ["false", ""]) {
      const { output } = run("Android note", { ANDROID_RESULT: "success", ANDROID_SIGNED: signed });
      expect(output).toMatch(/^note=\*\*Android:\*\* no APK in this release \(.*upload key.*\)\.\n$/);
      expect(output).not.toMatch(/debug\.apk|APK is a/);
    }
  });

  it("is left out, and the notes say so, when its build failed", () => {
    expect(assets([])).toEqual(["ghostly_1.2.0_amd64.deb"]);
    expect(run("Android note", { ANDROID_RESULT: "failure", ANDROID_SIGNED: "" }).output).toBe("note=**Android:** no APK in this release (its build did not succeed).\n");
  });
});
