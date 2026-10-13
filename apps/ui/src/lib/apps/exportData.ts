import type { AppDataExport } from "@ghostly/browser/engine/apps";
import { servicesPlatform } from "../platform";
import { saveMade } from "../fileDownload";

/**
 * One scope's `ghostlyAppData` file as JSON: one entry a line, each value as compact as JSON writes it. Indented, a
 * list of small numbers took 5.5 times its size and one nested 60 deep 69 times: data in two chats passed the longest
 * string the page can make.
 */
export function appDataFile(file: AppDataExport): string {
  const entries = Object.keys(file.entries).map((key) => `${JSON.stringify(key)}:${JSON.stringify(file.entries[key])}`);
  return `{"ghostlyAppData":1,"app":${JSON.stringify(file.app)},"scope":${JSON.stringify(file.scope)},"entries":{\n${entries.join(",\n")}\n}}`;
}

/**
 * Saves an app's data before an uninstall (WISP 1200 § Updates and rollback: uninstall offers an export): one
 * `ghostlyAppData` file per scope, all in one JSON list. Nothing when the app kept nothing.
 */
export async function saveAppData(ref: string, exports: readonly AppDataExport[]): Promise<void> {
  if (!exports.length) return;
  const name = `${ref.slice(53)}-data.json`;
  const parts = ["["];
  for (const [i, file] of exports.entries()) {
    // A scope at a time, the page's turn between them: ten chats written at once held it for half a second.
    if (i) await new Promise((resolve) => setTimeout(resolve, 0));
    parts.push(`${i ? "," : ""}\n${appDataFile(file)}`);
  }
  parts.push("\n]\n");
  await saveMade(servicesPlatform, new Blob(parts, { type: "application/json" }), name);
}
