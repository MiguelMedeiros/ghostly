import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

/** A job of the workflow, by its key: its text up to the next job. */
function job(key: string): string {
  const start = workflow.indexOf(`\n  ${key}:\n`);
  if (start < 0) throw new Error(`release.yml has no job "${key}"`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return workflow.slice(start, next < 0 ? undefined : start + 1 + next + 1);
}

/** One step of the guard job or the release job, by name: its text up to the next step, or to the job's end. */
function step(name: string): string {
  for (const steps of [job("guard"), job("release")]) {
    const start = steps.indexOf(`      - name: ${name}\n`);
    if (start < 0) continue;
    const next = steps.indexOf("\n      - name: ", start + 1);
    const end = next < 0 ? steps.search(/\n+( {2}#.*\n)*$/) : next;
    return steps.slice(start, end + 1);
  }
  throw new Error(`release.yml's guard and release jobs have no step "${name}"`);
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
    expect(run("Android note", { ANDROID_IN_RELEASE: "true", ANDROID_RESULT: "success", ANDROID_SIGNED: "true" }).output).toBe("note=\n");
  });

  it("is left out when the build had no upload key: a debug build is never published", () => {
    // A debug build takes the e2e launch extras and can be inspected over USB (docs/ANDROID.md).
    expect(step("Download Android artifact")).toContain("&& needs.build-android.result == 'success' && needs.build-android.outputs.signed == 'true'\n");
    expect(assets(["artifacts/android/ghostly-1.2.0-android-arm64-debug.apk"])).toEqual(["ghostly_1.2.0_amd64.deb"]);
    expect(assets(["artifacts/android/ghostly-1.2.0-android-arm64-throwaway.apk"])).toEqual(["ghostly_1.2.0_amd64.deb"]);
    for (const signed of ["false", ""]) {
      const { output } = run("Android note", { ANDROID_IN_RELEASE: "true", ANDROID_RESULT: "success", ANDROID_SIGNED: signed });
      expect(output).toMatch(/^note=\*\*Android:\*\* no APK in this release \(.*upload key.*\)\.\n$/);
      expect(output).not.toMatch(/debug\.apk|APK is a/);
    }
  });

  it("is left out, and the notes say so, when its build failed", () => {
    expect(assets([])).toEqual(["ghostly_1.2.0_amd64.deb"]);
    expect(run("Android note", { ANDROID_IN_RELEASE: "true", ANDROID_RESULT: "failure", ANDROID_SIGNED: "" }).output).toBe("note=**Android:** no APK in this release (its build did not succeed).\n");
  });

  // The owner's decision (2026-10-10): the native Android app is in no release before ANDROID_FROM.
  describe("before the release that carries the Android app", () => {
    const from = workflow.match(/^ {2}ANDROID_FROM: "(\d+\.\d+\.\d+)"$/m)?.[1] ?? "";
    const carries = (tag: string) => run("Whether this release carries the Android app", { RELEASE_TAG: tag, ANDROID_FROM: from }).output;

    it("is decided by the tag's version, not by a signing secret", () => {
      expect(from).toBe("1.3.0");
      for (const tag of ["v1.1.8", "v1.2.0", "v1.2.1", "v1.2.10"]) expect(carries(tag)).toBe("android=false\n");
      for (const tag of ["v1.3.0", "v1.3.1", "v1.10.0", "v2.0.0"]) expect(carries(tag)).toBe("android=true\n");
      expect(step("Whether this release carries the Android app")).not.toMatch(/secrets\./);
      expect(job("guard")).toContain("      android: ${{ steps.android.outputs.android }}\n");
    });

    it("is not built, not attached and not mentioned in the notes", () => {
      const build = job("build-android");
      expect(build).toContain("    needs: [guard]\n    if: needs.guard.outputs.android == 'true'\n");
      expect(step("Download Android artifact")).toContain("        if: needs.guard.outputs.android == 'true' && ");
      // A skipped build is not "a build that did not succeed": the notes stay silent, whatever the build's result.
      for (const result of ["skipped", "success", "failure"]) {
        for (const signed of ["true", "false", ""]) {
          expect(run("Android note", { ANDROID_IN_RELEASE: "false", ANDROID_RESULT: result, ANDROID_SIGNED: signed }).output).toBe("note=\n");
        }
      }
    });
  });
});
