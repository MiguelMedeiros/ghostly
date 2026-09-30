import { formatPaymentAmount } from "@ghostly/core";
import { languageTag } from "./documentLanguage";
import type { Language } from "./settings";

const formats = new Map<Language, Intl.NumberFormat>();

/**
 * The formatter for `language`, one per language for all. Latin digits in every language, as the voice speed pill
 * writes them: WebKit, WebKitGTK and Chromium ship different ICUs and would otherwise disagree on Arabic's digits.
 */
function numberFormat(language: Language): Intl.NumberFormat {
  let format = formats.get(language);
  if (!format) {
    format = new Intl.NumberFormat(languageTag(language), { numberingSystem: "latn" });
    formats.set(language, format);
  }
  return format;
}

/**
 * An amount ("10,000" in English, "10.000" in Portuguese, "10 000" in French) in the app's language, English when
 * none is given. Never the device's own language: a Portuguese interface on an English system still writes "10.000".
 */
export function formatAmount(amount: number, language: Language = "en"): string {
  return numberFormat(language).format(amount);
}

/**
 * A token amount in base units (`decimals` of them to one token), exact however long: "1,234.5" in English,
 * "1.234,5" in Portuguese. The whole part goes through Intl as a bigint, the fraction digits are kept as written.
 */
export function formatTokenAmount(value: number | string, decimals: number | undefined, language: Language = "en"): string {
  const [whole, fraction] = formatPaymentAmount(value, decimals).split(".");
  const format = numberFormat(language);
  const wholeText = format.format(BigInt(whole));
  if (!fraction) return wholeText;
  const point = format.formatToParts(0.5).find((p) => p.type === "decimal")?.value ?? ".";
  return `${wholeText}${point}${fraction}`;
}
