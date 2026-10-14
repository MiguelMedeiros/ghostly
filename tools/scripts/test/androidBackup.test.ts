import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
// covers: android.app.boot

/**
 * Android's own backup (to the cloud, and phone to phone at setup) copies an app's files unless the app says no. The
 * Android app keeps received files, the device state and the profile's database in its data dir, so a new phone set
 * up from an old one would start running the same profile. Ghostly's own encrypted backup and the device handoff are
 * the way to move a profile: nothing of the app's goes into Android's.
 */
const MAIN = join(import.meta.dirname, "../../../apps/desktop/gen/android/app/src/main");
const source = (path: string) => readFileSync(join(MAIN, path), "utf8");
const application = () => /<application\b[^>]*>/.exec(source("AndroidManifest.xml"))?.[0] ?? "";
/** Every domain an Android backup rule can name (developer.android.com, "Back up user data with Auto Backup"). */
const DOMAINS = ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"];
const excluded = (rules: string) => DOMAINS.filter((domain) => new RegExp(`<exclude domain="${domain}" path="\\." />`).test(rules));

it("turns Android's backup off", () => {
  expect(application()).toContain('android:allowBackup="false"');
});

it("leaves every domain out of the cloud backup and the device transfer (Android 12 and up)", () => {
  expect(application()).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
  const rules = source("res/xml/data_extraction_rules.xml");
  for (const section of ["cloud-backup", "device-transfer"]) {
    const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(rules)?.[1] ?? "";
    expect(excluded(body), section).toEqual(DOMAINS);
    expect(body, section).not.toContain("<include");
  }
});

it("leaves every domain out of the backup on Android 11 and older", () => {
  expect(application()).toContain('android:fullBackupContent="@xml/backup_rules"');
  const rules = source("res/xml/backup_rules.xml");
  expect(excluded(rules)).toEqual(DOMAINS);
  expect(rules).not.toContain("<include");
});
