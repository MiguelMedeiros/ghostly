// Loaded with `node --import` before tools/scripts/android-smoke.mjs in its tests: a fake adb (execFileSync answers as
// an emulator would) and a stuck one, by $SMOKE_STUCK:
// - "devices": Playwright's `_android.devices()` never answers (what CI's emulator did after "activity starts");
// - "install": `adb install` hits its time limit.
// Waits of 10 s and more take a thousandth of their time, so a two-minute limit runs out in 120 ms.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { _android } from "playwright";

const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms >= 10_000 ? ms / 1000 : ms, ...args);

const replies = [
  [/^shell getprop ro\.build\.version\.release$/, "15"],
  [/^shell getprop ro\.build\.version\.sdk$/, "35"],
  [/^shell getprop ro\.product\.cpu\.abi$/, "x86_64"],
  [/^install /, "Success"],
  [/^shell am start -W /, "Status: ok\nTotalTime: 812\nComplete"],
  [/^shell pidof /, "4242"],
  [/^exec-out screencap/, "\x89PNG fake"],
  [/^shell dumpsys window$/, "  mCurrentFocus=Window{1 u0 tools.ghostly.app/tools.ghostly.app.MainActivity}\n  mFocusedApp=ActivityRecord{2 u0 tools.ghostly.app/.MainActivity t9}"],
  [/^shell dumpsys activity top$/, `TASK null id=119\n  ACTIVITY com.google.android.apps.nexuslauncher/.NexusLauncherActivity pid=1099\n${"    launcher state\n".repeat(100)}TASK tools.ghostly.app id=120\n  ACTIVITY tools.ghostly.app/.MainActivity pid=4242\n    mResumed=true`],
  [/^exec-out uiautomator dump/, "<hierarchy rotation=\"0\"/>"],
  [/^logcat -d /, "11-10 14:47:35.000 I/ghostly( 4242): started\n11-10 14:47:35.100 I/system_server(  600): other"],
];

childProcess.execFileSync = (file, args, options) => {
  if (file !== "adb") throw new Error(`not in the fake: ${file}`);
  const line = args.join(" ");
  if (process.env.SMOKE_STUCK === "install" && args[0] === "install") throw Object.assign(new Error("spawnSync adb ETIMEDOUT"), { code: "ETIMEDOUT" });
  const text = replies.find(([pattern]) => pattern.test(line))?.[1] ?? "";
  return options?.encoding && options.encoding !== "buffer" ? text : Buffer.from(text);
};
syncBuiltinESMExports();

// A device call that never answers keeps the process alive, as Playwright's open adb socket does.
if (process.env.SMOKE_STUCK === "devices") _android.devices = () => new Promise(() => setInterval(() => {}, 1 << 30));
