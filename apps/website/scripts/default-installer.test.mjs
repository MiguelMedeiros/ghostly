import { test } from "node:test";
import assert from "node:assert/strict";
import { assetNames, defaultInstaller, downloads } from "../lib/release.ts";

// The download panel marks one installer as the reader's (defaultInstaller, lib/release.ts). A release has Linux files
// for amd64 only (assetNames), so a Linux machine that says it is ARM gets none marked: neither file runs there.
const chrome = (system) => `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36`;
const firefox = (system) => `Mozilla/5.0 (${system}; rv:143.0) Gecko/20100101 Firefox/143.0`;

test("a Linux machine on x86_64 gets the AppImage, or the .deb on a Debian family", () => {
  assert.equal(defaultInstaller(chrome("X11; Linux x86_64"), "Linux x86_64"), "linuxAppImage");
  assert.equal(defaultInstaller(firefox("X11; Ubuntu; Linux x86_64"), "Linux x86_64"), "linuxDeb");
  assert.equal(defaultInstaller("", "Linux x86_64"), "linuxAppImage");
});

test("a Linux machine on ARM gets no installer marked", () => {
  assert.equal(defaultInstaller(chrome("X11; Linux aarch64"), "Linux aarch64"), undefined);
  assert.equal(defaultInstaller(firefox("X11; Linux aarch64"), "Linux aarch64"), undefined);
  assert.equal(defaultInstaller(firefox("X11; Ubuntu; Linux aarch64"), "Linux aarch64"), undefined);
  assert.equal(defaultInstaller(firefox("X11; Linux armv7l"), "Linux armv7l"), undefined);
  assert.equal(defaultInstaller(chrome("X11; CrOS aarch64 15359.58.0"), "Linux aarch64"), undefined);
});

test("either the userAgent or the platform saying ARM is enough", () => {
  assert.equal(defaultInstaller(chrome("X11; Linux x86_64"), "Linux aarch64"), undefined);
  assert.equal(defaultInstaller(chrome("X11; Linux aarch64"), ""), undefined);
  assert.equal(defaultInstaller("", "Linux armv8l"), undefined);
});

test("the other systems keep their installer", () => {
  assert.equal(defaultInstaller(chrome("Macintosh; Intel Mac OS X 10_15_7"), "MacIntel"), "macArm");
  assert.equal(defaultInstaller(chrome("Macintosh; Intel Mac OS X 10_15_7"), "MacIntel", "x86"), "macIntel");
  assert.equal(defaultInstaller(chrome("Macintosh; Intel Mac OS X 10_15_7"), "MacIntel", "arm"), "macArm");
  assert.equal(defaultInstaller(chrome("Windows NT 10.0; Win64; x64"), "Win32"), "windowsExe");
  assert.equal(defaultInstaller(chrome("Windows NT 10.0; ARM64"), "Win32"), "windowsExe");
});

// Every release since 1.6.0 attaches the native Android app, so an Android phone is led to its APK; an iPhone gets none.
test("an Android phone gets the release's APK, an iPhone nothing", () => {
  assert.equal(defaultInstaller(chrome("Linux; Android 16; Pixel 9").replace("Safari", "Mobile Safari"), "Linux armv81", undefined, 5), "androidApk");
  assert.equal(defaultInstaller(firefox("Android 16; Mobile"), "Linux aarch64", undefined, 5), "androidApk");
  assert.equal(defaultInstaller("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Mobile/15E148 Safari/604.1", "iPhone", undefined, 5), undefined);
});

// The APK is arm64-v8a for Android 8.0 and up (docs/ANDROID.md): a phone it can't install on is not led to it.
test("an Android phone the APK can't install on gets nothing marked", () => {
  // A 32-bit ARM kernel (armv7l): no arm64 code runs there.
  assert.equal(defaultInstaller(firefox("Android 9; Mobile"), "Linux armv7l", undefined, 5), undefined);
  assert.equal(defaultInstaller(chrome("Linux; Android 10; K").replace("Safari", "Mobile Safari"), "Linux armv7l", undefined, 5), undefined);
  // Older than Android 8.0, where the browser says so (Chrome's reduced userAgent always says "Android 10").
  assert.equal(defaultInstaller(firefox("Android 7.1.2; Mobile"), "Linux aarch64", undefined, 5), undefined);
  assert.equal(defaultInstaller("Mozilla/5.0 (Linux; U; Android 6.0.1; en-us; SM-G920F) AppleWebKit/537.36 Mobile Safari/537.36", "", undefined, 5), undefined);
  // A 32-bit browser on a 64-bit phone (armv8l), an emulator on its x86_64 host (the site's phone tests), and no
  // platform at all, still get it.
  assert.equal(defaultInstaller(chrome("Linux; Android 10; K").replace("Safari", "Mobile Safari"), "Linux armv8l", undefined, 5), "androidApk");
  assert.equal(defaultInstaller(chrome("Linux; Android 10; K").replace("Safari", "Mobile Safari"), "Linux x86_64", undefined, 5), "androidApk");
  assert.equal(defaultInstaller(firefox("Android 8.0; Mobile"), "", undefined, 5), "androidApk");
});

test("the APK's name and link follow the version, as the Release workflow names it", () => {
  assert.equal(assetNames("1.10.0").androidApk, "ghostly-1.10.0-android-arm64.apk");
  assert.equal(downloads("2.0.1").androidApk, "https://github.com/MiguelMedeiros/ghostly/releases/download/v2.0.1/ghostly-2.0.1-android-arm64.apk");
});
