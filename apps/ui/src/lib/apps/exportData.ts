import type { AppDataExport } from "@ghostly/browser/engine/apps";
import { servicesPlatform } from "../platform";
import { saveMade } from "../fileDownload";

/**
 * Saves an app's data before an uninstall (WISP 1200 § Updates and rollback: uninstall offers an export): one
 * `ghostlyAppData` file per scope, all in one JSON list. Nothing when the app kept nothing.
 */
export async function saveAppData(ref: string, exports: readonly AppDataExport[]): Promise<void> {
  if (!exports.length) return;
  const name = `${ref.slice(53)}-data.json`;
  await saveMade(servicesPlatform, new Blob([JSON.stringify(exports, null, 2)], { type: "application/json" }), name);
}
