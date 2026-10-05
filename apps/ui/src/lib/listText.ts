import { englishT, type Translate } from "../locales/translate";
import { languageTag } from "./documentLanguage";

/** Not in this build's TypeScript library, but in every browser the app runs in. */
type ListFormatter = { format(list: readonly string[]): string };
const ListFormat = (Intl as unknown as { ListFormat?: new (locale: string, options: object) => ListFormatter }).ListFormat;
const formats = new Map<string, ListFormatter | null>();

/**
 * A few short items as one line, the way the app's language lists them: "Dark, English", "深色、中文", "داكن وعربية".
 * The narrow conjunction list of the language (Intl.ListFormat), not a comma every language would read as English.
 */
export function listText(items: readonly string[], t: Translate = englishT): string {
  const tag = languageTag(t.language ?? "en");
  if (!formats.has(tag)) {
    let format: ListFormatter | null = null;
    try { if (ListFormat) format = new ListFormat(tag, { style: "narrow", type: "conjunction" }); } catch { /* below */ }
    formats.set(tag, format);
  }
  return formats.get(tag)?.format(items) ?? items.join(", ");
}
