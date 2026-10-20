import type { AppDataExportText } from "@ghostly/browser/engine/apps";
import { servicesPlatform } from "../platform";
import { saveMade } from "../fileDownload";

/**
 * One scope's `ghostlyAppData` file as JSON: one entry a line, each value the compact JSON text it is kept as, written
 * without being parsed again. Indented, a list of small numbers took 5.5 times its size and one nested 60 deep 69
 * times: data in two chats passed the longest string the page can make.
 */
export function appDataFile(file: AppDataExportText): string {
  const entries = file.entries.map(([key, json]) => `${JSON.stringify(key)}:${json}`);
  return `{"ghostlyAppData":1,"app":${JSON.stringify(file.app)},"scope":${JSON.stringify(file.scope)},"entries":{\n${entries.join(",\n")}\n}}`;
}

/**
 * Saves an app's data before an uninstall (WISP 1200 § Updates and rollback: uninstall offers an export): one
 * `ghostlyAppData` file per scope, all in one JSON list. Nothing when the app kept nothing.
 */
export async function saveAppData(ref: string, exports: readonly AppDataExportText[]): Promise<void> {
  if (!exports.length) return;
  const name = `${ref.slice(53)}-data.json`;
  const parts: BlobPart[] = ["["];
  for (const [i, file] of exports.entries()) {
    // A scope at a time, the page's turn between them: ten chats written at once held it for half a second. Each its
    // own Blob, so the file is never one string to encode at once (60 MB took 70 to 100 ms).
    if (i) await new Promise((resolve) => setTimeout(resolve, 0));
    parts.push(new Blob([`${i ? "," : ""}\n${appDataFile(file)}`]));
  }
  parts.push("\n]\n");
  await saveMade(servicesPlatform, new Blob(parts, { type: "application/json" }), name);
}
