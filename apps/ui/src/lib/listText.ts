import { englishT, type Translate } from "../locales/translate";
import { languageTag } from "./documentLanguage";

/** Not in this build's TypeScript library, but in every browser the app runs in. */
type ListPart = { type: "element" | "literal"; value: string };
type ListFormatter = { format(list: readonly string[]): string; formatToParts(list: readonly string[]): ListPart[] };
const ListFormat = (Intl as unknown as { ListFormat?: new (locale: string, options: object) => ListFormatter }).ListFormat;
const formats = new Map<string, ListFormatter | null>();

function listFormat(t: Translate): ListFormatter | null {
  const tag = languageTag(t.language ?? "en");
  if (!formats.has(tag)) {
    let format: ListFormatter | null = null;
    try { if (ListFormat) format = new ListFormat(tag, { style: "narrow", type: "conjunction" }); } catch { /* below */ }
    formats.set(tag, format);
  }
  return formats.get(tag) ?? null;
}

/**
 * A few short items as one line, the way the app's language lists them: "Dark, English", "深色、中文", "داكن وعربية".
 * The narrow conjunction list of the language (Intl.ListFormat), not a comma every language would read as English.
 */
export function listText(items: readonly string[], t: Translate = englishT): string {
  return listFormat(t)?.format(items) ?? items.join(", ");
}

/**
 * The same line in pieces, for items shown each in its own element (a name in its `<bdi>`): `item` false for what the
 * language puts between them.
 */
export function listParts(items: readonly string[], t: Translate = englishT): { item: boolean; text: string }[] {
  const format = listFormat(t);
  if (!format) return items.flatMap((text, i) => i ? [{ item: false, text: ", " }, { item: true, text }] : [{ item: true, text }]);
  return format.formatToParts(items).map(part => ({ item: part.type === "element", text: part.value }));
}
