import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultInstaller } from "../lib/release.ts";

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
  assert.equal(defaultInstaller(chrome("Linux; Android 16; Pixel 9"), "Linux armv81"), undefined);
});
