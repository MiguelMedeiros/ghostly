import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The emulator smoke test (tools/scripts/android-smoke.mjs) on a device that stops answering: a step past its time
 * limit ends the run with a "step timed out" row and what the device showed, instead of waiting for the job's own
 * 45-minute limit. The fixture fakes adb and Playwright's device, and runs the limits a thousand times faster.
 */
const root = resolve(import.meta.dirname, "../../..");
const outs: string[] = [];
afterEach(() => {
  for (const dir of outs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const smoke = (stuck: string) => {
  const out = mkdtempSync(join(tmpdir(), "android-smoke-"));
  outs.push(out);
  const run = spawnSync(process.execPath, ["--import", resolve(import.meta.dirname, "fixtures/android-smoke-device.mjs"), resolve(root, "tools/scripts/android-smoke.mjs")], {
    cwd: root,
    env: { ...process.env, ANDROID_SMOKE_APK: "/fake/ghostly.apk", ANDROID_SMOKE_OUT: out, SMOKE_STUCK: stuck },
    encoding: "utf8",
    timeout: 20_000,
  });
  const results = existsSync(join(out, "results.json")) ? JSON.parse(readFileSync(join(out, "results.json"), "utf8")) : [];
  return { run, out, results: results as { area: string; check: string; ok: boolean | null; detail: string }[] };
};

describe("android-smoke.mjs step time limits", () => {
  it("fails fast with the device's state when Playwright never finds the device", () => {
    const { run, out, results } = smoke("devices");
    expect(run.error, "the run ended by itself").toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("NO  smoke: step timed out: Playwright finds the device: no answer in 120 s");
    const row = results.find((r) => r.check === "step timed out: Playwright finds the device");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("focus mCurrentFocus=Window{1 u0 tools.ghostly.app/tools.ghostly.app.MainActivity}");
    for (const file of ["timeout-screen.png", "timeout-window.txt", "timeout-activity-top.txt", "timeout-ui.xml", "logcat.txt", "results.md"]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    expect(readFileSync(join(out, "logcat-app.txt"), "utf8")).toBe("11-10 14:47:35.000 I/ghostly( 4242): started");
    // The launcher's task comes first in dumpsys, with a long state: the app's own section is kept.
    expect(readFileSync(join(out, "timeout-activity-top.txt"), "utf8")).toContain("TASK tools.ghostly.app id=120\n  ACTIVITY tools.ghostly.app/.MainActivity pid=4242\n    mResumed=true");
  });

  it("names the adb call that hit its limit", () => {
    const { run, results } = smoke("install");
    expect(run.status).toBe(1);
    const row = results.find((r) => r.check.startsWith("step timed out: "));
    expect(row?.check).toBe("step timed out: adb install -r /fake/ghostly.apk");
    expect(row?.detail).toMatch(/^no answer in 300 s; /);
  });
});
