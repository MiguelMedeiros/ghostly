import { describe, expect, it } from "vitest";
import { Adb } from "../../../e2e/android/support/adb";

/*
 * The Android harness's `adb reverse` failed in ~13 ms with "adb: device offline" at a spec's start in 4 of 12 Android
 * e2e runs on 2026-11-23 (lock.spec.ts:97, launch.spec.ts:52): the emulator's adb drops for a moment between two specs,
 * every command fails at once meanwhile, and the spec's retry, a few seconds later, passed each time.
 */

/** adb as execFileSync runs it: the error it throws for a device that is offline, then the device back. */
function adbOfflineFor(failures: number) {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    if (args.includes("wait-for-device")) return "";
    if (failures > 0) {
      failures--;
      throw Object.assign(new Error(`Command failed: adb ${args.join(" ")}\nadb: device offline\n`), { status: 1, stdout: "", stderr: "adb: device offline\n" });
    }
    return "ok\n";
  };
  return { exec, calls };
}

describe("adb on the Android e2e device", () => {
  it("waits for a device that went offline for a moment and runs the command again", () => {
    const adb = adbOfflineFor(1);
    expect(new Adb("emulator-5554", adb.exec).run("reverse", "tcp:41773", "tcp:41773")).toBe("ok\n");
    expect(adb.calls).toEqual([
      ["-s", "emulator-5554", "reverse", "tcp:41773", "tcp:41773"],
      ["-s", "emulator-5554", "wait-for-device"],
      ["-s", "emulator-5554", "reverse", "tcp:41773", "tcp:41773"],
    ]);
  });

  it("fails as before when the device is still offline after it came back once", () => {
    const adb = adbOfflineFor(2);
    expect(() => new Adb("emulator-5554", adb.exec).run("shell", "pidof", "tools.ghostly.app")).toThrow(/device offline/);
    expect(adb.calls.filter((args) => args.includes("pidof"))).toHaveLength(2);
  });

  it("does not run again a command that failed for another reason", () => {
    const calls: string[][] = [];
    const exec = (args: string[]) => {
      calls.push(args);
      throw Object.assign(new Error("Command failed: adb shell pm grant\nException occurred"), { status: 255, stdout: "", stderr: "Exception occurred" });
    };
    expect(new Adb("emulator-5554", exec).tryRun("shell", "pm", "grant", "x").ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
