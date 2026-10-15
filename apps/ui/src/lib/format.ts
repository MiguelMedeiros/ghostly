import { englishT, type Translate } from "../locales/translate";
import { sizeIn } from "./sizeText";

/**
 * A file's size as core's `formatFileSize` says it (B, then KB, MB, GB with one decimal), in the app's language (`t`):
 * its decimal mark and unit names, "4,2 MB" in Portuguese, "4,2 Mo" in French.
 */
export function formatFileSize(bytes: number, t: Translate = englishT): string {
  if (bytes < 1024) return sizeIn(bytes, "b", t);
  const units = ["kb", "mb", "gb"] as const;
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return sizeIn(value, units[unit], t, 1, true);
}
