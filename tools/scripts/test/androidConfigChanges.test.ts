import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
// covers: android.app.boot

/**
 * A configuration change the activity does not list in `android:configChanges` relaunches it: Android makes a new
 * `MainActivity`, whose new WebView loads the page again while the first WebView's page still runs in the same
 * process and holds the profile's Web Lock (`becomeThePeer`, packages/browser/src/inPageHost.ts). The new page then
 * shows "Ghostly is already running with this profile" until a force stop. The page lays itself out again on any
 * change, so the activity takes every one of them itself.
 */
const MANIFEST = join(import.meta.dirname, "../../../apps/desktop/gen/android/app/src/main/AndroidManifest.xml");
const GRADLE = join(import.meta.dirname, "../../../apps/desktop/gen/android/app/build.gradle.kts");
/**
 * Every configuration change an activity can take (the SDK's `attrs_manifest.xml`, `configChanges`, API 37), but
 * `resourcesUnused`, which only Android 16 and up read. What the phone's settings change: `fontScale` (font size),
 * `density` (display size), `fontWeightAdjustment` (bold text, API 31), `layoutDirection` (a right-to-left language),
 * `assetsPaths` (Material You's colours, API 36) and `grammaticalGender` (API 34). An Android older than a value
 * ignores its bit.
 */
const CHANGES = [
  "mcc",
  "mnc",
  "locale",
  "touchscreen",
  "keyboard",
  "keyboardHidden",
  "navigation",
  "orientation",
  "screenLayout",
  "uiMode",
  "screenSize",
  "smallestScreenSize",
  "density",
  "layoutDirection",
  "colorMode",
  "grammaticalGender",
  "fontScale",
  "fontWeightAdjustment",
  "assetsPaths",
];
/** The newest value's API level (`assetsPaths`): an older compile SDK fails the build on it. */
const NEWEST_VALUE_API = 36;

const activity = () => /<activity\b[^>]*android:name="\.MainActivity"[^>]*>/.exec(readFileSync(MANIFEST, "utf8"))?.[0] ?? "";
const handled = () => (/android:configChanges="([^"]*)"/.exec(activity())?.[1] ?? "").split("|");

it("MainActivity takes every configuration change itself, so none relaunches it over the running page", () => {
  expect(CHANGES.filter((change) => !handled().includes(change))).toEqual([]);
});

it("names only configuration changes the SDK knows", () => {
  expect(handled().filter((change) => !CHANGES.includes(change))).toEqual([]);
});

it("compiles against an SDK that knows the newest of them", () => {
  const compileSdk = Number(/compileSdk = (\d+)/.exec(readFileSync(GRADLE, "utf8"))?.[1]);
  expect(compileSdk).toBeGreaterThanOrEqual(NEWEST_VALUE_API);
});
