import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANDROID_CERT_SHA256, ANDROID_MIN, ANDROID_PAGE, ANDROID_PAGE_URL } from "../lib/release.ts";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

// /android says which Android the app installs on: the build's minSdkVersion, as Android names that API level.
const ANDROID_OF_API = { 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12" };

test("the oldest Android the page names is the one the build installs on", () => {
  const conf = JSON.parse(read("apps/desktop/tauri.android.conf.json"));
  const minSdk = conf.bundle?.android?.minSdkVersion;
  assert.ok(minSdk, "tauri.android.conf.json sets bundle.android.minSdkVersion");
  assert.equal(ANDROID_MIN, ANDROID_OF_API[minSdk]);
  assert.match(read("apps/desktop/gen/android/app/build.gradle.kts"), new RegExp(`minSdk = ${minSdk}\\b`));
});

test("the signing certificate's fingerprint is a whole SHA-256, as apksigner and keytool print it", () => {
  assert.match(ANDROID_CERT_SHA256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(read("docs/ANDROID.md").includes(ANDROID_CERT_SHA256), "docs/ANDROID.md gives the same fingerprint");
});

test("the QR code and llms.txt lead to the same install page", () => {
  assert.equal(ANDROID_PAGE_URL, `https://ghostly.tools${ANDROID_PAGE}`);
  assert.match(read("apps/website/scripts/llms.mjs"), /line\("Android", `\$\{SITE\}\/android`/);
});
