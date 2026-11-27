import { englishT, type Translate } from "../locales/translate";
import { languageTag } from "./documentLanguage";

/** The units a size is said in. */
export type SizeUnit = "b" | "kb" | "mb" | "gb" | "tb";

const formats = new Map<string, Intl.NumberFormat>();

/**
 * The unit a size is said in, picked on the value as it is shown: `value` is in the first unit, each next one is 1024
 * of it, and `digits[i]` is how many decimals unit `i` shows (one entry per unit). 1023.97 KB at one decimal is
 * "1.0 MB", never "1024.0 KB"; the last unit takes everything above it.
 */
export function unitFor(value: number, digits: readonly number[]): { value: number; unit: number } {
  let unit = 0;
  while (unit < digits.length - 1 && Math.round(value * 10 ** digits[unit]) / 10 ** digits[unit] >= 1024) { value /= 1024; unit++; }
  return { value, unit };
}

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
