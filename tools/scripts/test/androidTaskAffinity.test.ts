import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
// covers: android.app.boot

/**
 * A task's affinity is a name any app can claim: another app's activity that declares the same `taskAffinity` can be
 * started into a task of that name, and Android may then bring that task forward when the person opens Ghostly, with
 * the other app's screen on top under Ghostly's name. An activity's affinity is the package name unless it says
 * otherwise, so the exported MainActivity sets an empty one: no other app's activity shares its task. `singleTask` still
 * keeps one MainActivity, found by its component (a share, a notification's tap, a sign-in's link, the icon).
 */
const MANIFEST = join(import.meta.dirname, "../../../apps/desktop/gen/android/app/src/main/AndroidManifest.xml");
const manifest = () => readFileSync(MANIFEST, "utf8");
const activity = () => /<activity\b[^>]*android:name="\.MainActivity"[^>]*>/.exec(manifest())?.[0] ?? "";
const application = () => /<application\b[^>]*>/.exec(manifest())?.[0] ?? "";

it("MainActivity has an empty task affinity, which no other app's activity can share", () => {
  expect(activity()).toContain('android:taskAffinity=""');
});

it("names no task affinity for the whole app", () => {
  expect(application()).not.toContain("android:taskAffinity");
});

it("keeps MainActivity singleTask", () => {
  expect(activity()).toContain('android:launchMode="singleTask"');
});
