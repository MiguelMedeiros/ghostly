import { androidApp } from "../lib/touchOnly";

/*
 * Keeping awake in the Android app (lib/keepAwake.ts). Its `keep_awake` holds the "Sending files" service for files
 * alone and ignores the device reasons, so there the device set and the handoff are not read for it, and Devices has
 * no "Keep this computer awake" switch. In an android*.ts file, so a change here runs the Android lane before it merges
 * (tools/scripts/test/androidE2eWorkflow.test.ts).
 */

/** Whether keeping awake holds for the devices too (the switch, a handoff): not in the Android app. */
export function keepAwakeHoldsDevices(): boolean {
  return !androidApp();
}
