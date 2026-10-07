// The phone checklist's checks a computer can read (docs/ANDROID-PHONE.md), with a phone on USB: over adb and inside
// the app's WebView (Playwright's `_android`, as tools/scripts/android-smoke.mjs on the emulator). It prints a table to
// paste to the coordinator. What a person has to see or hear (the keyboard, a call's audio, a message arriving while
// locked) stays in the checklist.
//
// It installs nothing, clears nothing and changes no setting: the debug APK is installed and opened by hand first
// (docs/ANDROID-PHONE.md steps 1 to 3). It starts the app when it is not running, and turns the screen off and on again
// for the timer check (--screen-off 0 skips that).
//
//   node tools/scripts/android-phone-check.mjs [--serial <adb serial>] [--screen-off <seconds, 60>] [--out <file.md>]
//
// Exit status: 0 when the table was made (whatever it says), 2 when there is no device or no app to read.
import { _android } from "playwright";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PKG = "tools.ghostly.app";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const screenOffSeconds = Number(flag("screen-off", "60"));
const out = flag("out", null);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The one device to read: --serial, ANDROID_SERIAL, or the only one adb lists. */
function chooseSerial() {
  const named = flag("serial", process.env.ANDROID_SERIAL);
  if (named) return named;
  let listed;
  try {
    listed = execFileSync("adb", ["devices", "-l"], { encoding: "utf8", timeout: 30_000 });
  } catch (error) {
    console.error(`adb: ${error.message}\nInstall the Android platform tools and put adb on the PATH.`);
    process.exit(2);
  }
  const rows = listed.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
  const ready = rows.filter((row) => /\sdevice(\s|$)/.test(row)).map((row) => row.split(/\s+/)[0]);
  for (const row of rows.filter((row) => /\sunauthorized(\s|$)/.test(row))) console.error(`${row.split(/\s+/)[0]}: unauthorized. Allow USB debugging on the phone (the prompt on its screen), then run this again.`);
  if (ready.length === 1) return ready[0];
  console.error(ready.length ? `Several devices (${ready.join(", ")}): name one with --serial.` : "No device: plug the phone in with USB debugging on (adb devices lists it).");
  process.exit(2);
}

const serial = chooseSerial();
const adb = (...rest) => execFileSync("adb", ["-s", serial, ...rest], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
const tryAdb = (...rest) => {
  try {
    return adb(...rest);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}` || String(error.message);
  }
};
const prop = (name) => tryAdb("shell", "getprop", name).trim();

const rows = [];
/** One row: `ok` true, false, or null (read, not judged). */
const row = (check, ok, detail) => {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  rows.push({ check, ok, detail: text });
  console.log(`${ok === true ? "yes" : ok === false ? "NO " : " - "} ${check}: ${text}`);
};
const measure = async (check, run) => {
  try {
    await run();
  } catch (error) {
    row(check, false, String(error?.message ?? error).split("\n")[0].slice(0, 300));
  }
};

// ---------- the device and the app, from adb alone ----------
const api = Number(prop("ro.build.version.sdk"));
const emulator = prop("ro.kernel.qemu") === "1" || prop("ro.boot.qemu") === "1";
row("device", null, `${prop("ro.product.manufacturer")} ${prop("ro.product.model")}, Android ${prop("ro.build.version.release")} (API ${api}), ${prop("ro.product.cpu.abi")}${emulator ? ", an emulator (not a phone)" : ""}`);

const pkgDump = tryAdb("shell", "dumpsys", "package", PKG);
if (!/versionName=/.test(pkgDump)) {
  console.error(`${PKG} is not installed: install the debug APK first (docs/ANDROID-PHONE.md, steps 1 and 2).`);
  process.exit(2);
}
const debuggable = /pkgFlags=\[[^\]]*DEBUGGABLE/.test(pkgDump);
row("app", debuggable, `${PKG} ${pkgDump.match(/versionName=(\S+)/)?.[1]}, ${debuggable ? "debug build" : "not a debug build: its WebView cannot be read from here"}, installed ${pkgDump.match(/firstInstallTime=([^\n]+)/)?.[1]?.trim() ?? "?"}`);

const provider = tryAdb("shell", "dumpsys", "webviewupdate").match(/Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/);
row("WebView (system)", null, provider ? `${provider[1]} ${provider[2]}` : "not reported (dumpsys webviewupdate)");

// Notifications: Android 13 (API 33) and up asks for POST_NOTIFICATIONS; below, they are on unless turned off.
if (api >= 33) {
  const declared = pkgDump.includes("android.permission.POST_NOTIFICATIONS");
  const granted = pkgDump.match(/android\.permission\.POST_NOTIFICATIONS: granted=(true|false)/)?.[1];
  row("notification permission", granted === "true", !declared ? "the app does not ask for POST_NOTIFICATIONS (comes with the Android host, A1)" : granted ? `POST_NOTIFICATIONS granted=${granted}` : "asked for, not answered yet");
} else {
  row("notification permission", null, `Android ${api} < 13: no runtime permission; ${tryAdb("shell", "cmd", "appops", "get", PKG, "POST_NOTIFICATION").trim() || "app ops say nothing"}`);
}

// What decides whether the app runs in the background (Doze and the maker's battery rules; A4).
const bucket = tryAdb("shell", "am", "get-standby-bucket", PKG).trim();
const whitelisted = tryAdb("shell", "dumpsys", "deviceidle", "whitelist").includes(PKG);
const background = tryAdb("shell", "cmd", "appops", "get", PKG, "RUN_ANY_IN_BACKGROUND").trim().replace(/\s+/g, " ");
row("background limits", null, `standby bucket ${bucket || "?"} (10 active, 20 working set, 30 frequent, 40 rare, 45 restricted); battery optimisation ${whitelisted ? "off (allowed)" : "on"}; ${background || "RUN_ANY_IN_BACKGROUND default"}`);

// ---------- inside the WebView ----------
let device;
try {
  if (!tryAdb("shell", "pidof", PKG).trim()) {
    // Opened as from the launcher, with no extra: the person's own profile, as they left it.
    adb("shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`);
  }
  // No Playwright driver APK on a person's phone: the WebView is reached through its DevTools socket alone.
  [device] = (await _android.devices({ omitDriverInstall: true })).filter((d) => d.serial() === serial);
  if (!device) throw new Error(`Playwright sees no device ${serial}`);
  const pid = Number(tryAdb("shell", "pidof", PKG).trim());
  let view;
  for (const end = Date.now() + 60_000; !view && Date.now() < end; await sleep(250)) view = device.webViews().find((v) => v.pkg() === PKG && (!pid || v.pid() === pid));
  if (!view) throw new Error("the app's WebView did not show over adb within 60 s (a debug build, open on the phone?)");
  const page = await view.page();
  page.setDefaultTimeout(30_000);

  const env = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    fine: matchMedia("(any-pointer: fine)").matches,
    coarse: matchMedia("(any-pointer: coarse)").matches,
    pointer: matchMedia("(pointer: coarse)").matches ? "coarse" : matchMedia("(pointer: fine)").matches ? "fine" : "none",
    hover: matchMedia("(any-hover: hover)").matches,
    viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    notification: typeof Notification === "function" ? Notification.permission : "no Notification API",
  }));
  row("WebView (in the app)", null, env.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? env.userAgent);
  // The UI keeps the keyboard down on opening a chat only on a touch-only screen (apps/ui/src/lib/touchOnly.ts).
  row("touch only (no keyboard on opening a chat)", env.coarse && !env.fine, `any-pointer: coarse ${env.coarse}, fine ${env.fine}; pointer ${env.pointer}; any-hover ${env.hover}; viewport ${env.viewport}`);
  row("notifications (page)", null, env.notification);

  await measure("WebCrypto Ed25519", async () => {
    const r = await page.evaluate(async () => {
      const key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      const data = new TextEncoder().encode("ghostly");
      const signature = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, data);
      return await crypto.subtle.verify({ name: "Ed25519" }, key.publicKey, signature, data);
    });
    row("WebCrypto Ed25519", r, r ? "generate, sign, verify" : "verify said false");
  });
  await measure("WebCrypto X25519", async () => {
    const bits = await page.evaluate(async () => {
      const a = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      const b = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      return (await crypto.subtle.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256)).byteLength;
    });
    row("WebCrypto X25519", bits === 32, `derived ${bits} bytes`);
  });

  if (screenOffSeconds > 0) {
    await measure(`JS timers, screen off ${screenOffSeconds} s`, async () => {
      await page.evaluate(() => {
        const w = window;
        w.__phoneTicks = [];
        w.__phoneTimer = setInterval(() => w.__phoneTicks.push(Date.now()), 1_000);
      });
      adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
      await sleep(screenOffSeconds * 1_000);
      adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
      const ticks = await page.evaluate(() => {
        const w = window;
        clearInterval(w.__phoneTimer);
        return w.__phoneTicks;
      });
      const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
      const longest = gaps.length ? Math.max(...gaps) : null;
      row(`JS timers, screen off ${screenOffSeconds} s`, ticks.length >= screenOffSeconds * 0.8, `${ticks.length} ticks of ${screenOffSeconds}; longest gap ${longest === null ? "?" : `${(longest / 1000).toFixed(1)} s`}`);
    });
  }
} catch (error) {
  row("WebView", false, String(error?.message ?? error).split("\n")[0].slice(0, 300));
} finally {
  await device?.close().catch(() => {});
}

// ---------- crashes, from logcat as the phone keeps it (no `logcat -c`: older lines count too) ----------
await measure("crashes in logcat", async () => {
  const lines = `${tryAdb("logcat", "-d", "-b", "crash", "-v", "time")}\n${tryAdb("logcat", "-d", "-v", "time")}`.split("\n");
  const ours = lines.filter((line) => /FATAL EXCEPTION|panicked at|SIGSEGV|SIGABRT|ANR in/.test(line) && (line.includes(PKG) || /RustStdoutStderr/.test(line)));
  const died = lines.filter((line) => line.includes(`Process: ${PKG}`));
  const found = [...new Set([...ours, ...died])];
  row("crashes in logcat", found.length === 0, found.length ? found.slice(0, 4).join(" / ").slice(0, 600) : "none in the buffers");
});

const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
const table = [
  `## Ghostly Android, phone check (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`,
  "",
  "| Check | OK | Detail |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.check} | ${r.ok === true ? "yes" : r.ok === false ? "**no**" : ""} | ${cell(r.detail)} |`),
  "",
].join("\n");
console.log(`\nPaste this to the coordinator, with the checklist's own answers (docs/ANDROID-PHONE.md):\n\n${table}`);
if (out) writeFileSync(out, table);
