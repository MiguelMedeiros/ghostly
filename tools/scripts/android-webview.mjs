#!/usr/bin/env node
/**
 * Gives the Android emulator a WebView the app takes, before the e2e specs (.github/workflows/android-e2e.yml). The
 * API 30 google_apis image ships Android System WebView 83, below the app's minimum (MainActivity.kt `MIN_WEBVIEW`,
 * 111): the app shows its "Update Android System WebView" screen and no spec reaches its page. Google's own WebView
 * comes from Play only, so such a device gets Chromium's SystemWebView.apk (package com.android.webview, which a
 * userdebug Google APIs image takes as a WebView provider) from a Chromium snapshot build, pinned:
 * - the archive by its Cloud Storage object generation (a rebuilt object has another one, and the URL then fails);
 * - the APK by its sha256, checked before it is installed (and on the copy kept from an earlier run).
 * Only the APK is fetched, by HTTP range, not the whole archive. A device whose WebView is new enough is left alone.
 *
 *   node tools/scripts/android-webview.mjs
 *
 * adb's device: ANDROID_SERIAL, as adb reads it. The APK is kept in $ANDROID_WEBVIEW_DIR (test-results/android-webview).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

/** Chromium's x86_64 snapshot (AndroidDesktop_x64, the only x86_64 Android one), its SystemWebView.apk. */
export const PINNED = {
  revision: 1738818,
  url: "https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/AndroidDesktop_x64%2F1738818%2Fchrome-android-desktop.zip?generation=1794209495825287&alt=media",
  entry: "chrome-android-desktop/apks/SystemWebView.apk",
  sha256: "a02f7b70843ab80ce78eecae61018eaa019bbbca8d6d8c12a2db004b6a72cbdf",
  pkg: "com.android.webview",
  // aapt2 dump badging: versionName 159.0.8153.0, minSdkVersion 29 (Android 10), native code x86_64 only, 420 MB.
  version: "159.0.8153.0",
};

const MAIN_ACTIVITY = fileURLToPath(new URL("../../apps/desktop/gen/android/app/src/main/java/tools/ghostly/app/MainActivity.kt", import.meta.url));

/** The oldest WebView major version the app takes, read from MainActivity.kt so the two never differ. */
export function minWebView(source = readFileSync(MAIN_ACTIVITY, "utf8")) {
  const found = source.match(/\bMIN_WEBVIEW\s*=\s*(\d+)/)?.[1];
  if (!found) throw new Error("No MIN_WEBVIEW in MainActivity.kt");
  return Number(found);
}

/** The WebView the device's apps get, from `dumpsys webviewupdate`; null when it does not say. */
export function currentWebView(dump) {
  const found = dump.match(/Current WebView package \(name, version\): \(([^,\s]+), ((\d+)[\d.]*)\)/);
  return found ? { pkg: found[1], version: found[2], major: Number(found[3]) } : null;
}

/** Why the app cannot show its page with the device's WebView, or null when it can. */
export function webViewProblem(dump, min) {
  const webView = currentWebView(dump);
  if (!webView) return "the device has no current WebView (dumpsys webviewupdate)";
  if (webView.major < min) return `the device's WebView ${webView.version} (${webView.pkg}) is older than the app's minimum, ${min}`;
  return null;
}

/** The bytes `start`..`end` (inclusive; `start` null: the last `end` bytes) of `url`. */
async function range(fetchImpl, url, start, end) {
  const response = await fetchImpl(url, { headers: { Range: start === null ? `bytes=-${end}` : `bytes=${start}-${end}` } });
  if (response.status !== 206) throw new Error(`${url}: HTTP ${response.status} for a range request`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * One file of the zip at `url`, read by range (the end record, the central directory, then the file alone), returned
 * only when its sha256 is `sha256`. Neither the archive nor the APK is ZIP64 (both well under 4 GB).
 */
export async function fetchEntry(url, name, sha256, fetchImpl = fetch) {
  const tail = await range(fetchImpl, url, null, 65_557);
  const endAt = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error(`${url}: no zip end record`);
  const directorySize = tail.readUInt32LE(endAt + 12);
  const directoryAt = tail.readUInt32LE(endAt + 16);
  const directory = await range(fetchImpl, url, directoryAt, directoryAt + directorySize - 1);
  let found = null;
  for (let at = 0; at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50; ) {
    const nameLength = directory.readUInt16LE(at + 28);
    const entryName = directory.toString("utf8", at + 46, at + 46 + nameLength);
    if (entryName === name) {
      found = { method: directory.readUInt16LE(at + 10), packed: directory.readUInt32LE(at + 20), offset: directory.readUInt32LE(at + 42) };
      break;
    }
    at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
  }
  if (!found) throw new Error(`${url}: no ${name} in the archive`);
  const header = await range(fetchImpl, url, found.offset, found.offset + 29);
  const dataAt = found.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const packed = await range(fetchImpl, url, dataAt, dataAt + found.packed - 1);
  const data = found.method === 8 ? inflateRawSync(packed) : found.method === 0 ? packed : null;
  if (!data) throw new Error(`${name}: zip method ${found.method}`);
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== sha256) throw new Error(`${name}: sha256 ${got}, not the pinned ${sha256}`);
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A time limit as e2e/android/support/android.ts has: with the emulator gone, adb waits for a device until the job's timeout.
  const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", timeout: 180_000 });
  const min = minWebView();
  const before = webViewProblem(adb("shell", "dumpsys", "webviewupdate"), min);
  if (!before) {
    console.log(`WebView: ${currentWebView(adb("shell", "dumpsys", "webviewupdate")).version}, the app's minimum is ${min}: nothing to install`);
  } else {
    console.log(`WebView: ${before}; installing Chromium's SystemWebView ${PINNED.version} (r${PINNED.revision})`);
    const dir = resolve(process.env.ANDROID_WEBVIEW_DIR ?? "test-results/android-webview");
    const apk = resolve(dir, `SystemWebView-${PINNED.version}-x86_64.apk`);
    const kept = existsSync(apk) && createHash("sha256").update(readFileSync(apk)).digest("hex") === PINNED.sha256;
    if (!kept) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${apk}.part`, await fetchEntry(PINNED.url, PINNED.entry, PINNED.sha256));
      renameSync(`${apk}.part`, apk);
    }
    adb("install", "-r", apk);
    console.log(adb("shell", "cmd", "webviewupdate", "set-webview-implementation", PINNED.pkg).trim());
    const after = webViewProblem(adb("shell", "dumpsys", "webviewupdate"), min);
    if (after) throw new Error(`After installing ${PINNED.pkg} ${PINNED.version}, ${after}`);
    console.log(`WebView: ${currentWebView(adb("shell", "dumpsys", "webviewupdate")).version}`);
  }
}
