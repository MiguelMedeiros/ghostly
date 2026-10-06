import { englishT, type Translate } from "../locales/translate";
import { languageTag } from "./documentLanguage";

/** The units a size is said in. */
export type SizeUnit = "b" | "kb" | "mb" | "gb";

const formats = new Map<string, Intl.NumberFormat>();

/**
 * `n` `unit` in the app's language: its decimal mark and its unit's name ("1,5 Mo" in French, "144 ك.ب" in Arabic),
 * in Latin digits as amounts are. A unit in Latin letters inside Arabic text would be read before its number.
 * `digits` is the most decimals shown, `fixed` whether that many are always shown.
 */
export function sizeIn(n: number, unit: SizeUnit, t: Translate = englishT, digits = 0, fixed = false): string {
  const tag = languageTag(t.language ?? "en");
  const key = `${tag} ${digits} ${fixed}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(tag, { numberingSystem: "latn", useGrouping: false, maximumFractionDigits: digits, minimumFractionDigits: fixed ? digits : 0 });
    formats.set(key, format);
  }
  return t(`common.size.${unit}`, { n: format.format(n) });
}
