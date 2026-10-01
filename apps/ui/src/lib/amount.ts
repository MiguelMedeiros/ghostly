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

/** The decimal point `language` writes: "," in Portuguese, Spanish, French and Italian, "." elsewhere. */
export function decimalPoint(language: Language = "en"): "." | "," {
  return numberFormat(language).formatToParts(0.5).find((p) => p.type === "decimal")?.value === "," ? "," : ".";
}

/**
 * What an amount field keeps of what was typed: digits, points, commas and spaces, as typed. The field shows the
 * person's own writing ("1.000,5" in Portuguese); `readAmount` says what it means.
 */
export function amountInput(text: string): string {
  return text.replace(/[^0-9.,\s\u00a0\u202f]/g, "");
}

/** What an amount typed means, as "1000.5" (a point, no grouping; "" for nothing typed), or why it cannot be read. */
export type AmountRead = { ok: true; value: string } | { ok: false; why: "unclear" | "whole" };

/**
 * An amount as a person writes it in `language`: the language's decimal point ("1,5" in Portuguese, "1.5" in
 * English), and the other mark or a space only to group thousands ("1.000" is a thousand in Portuguese, "1,000" in
 * English). A grouping mark anywhere else ("1.5" in Portuguese, "1,5" in English) could mean either, and is refused
 * rather than guessed: the review must never show another amount than the one meant. A field of whole units
 * (`decimals` 0, sats) refuses a decimal point.
 */
export function readAmount(text: string, language: Language = "en", decimals = 0): AmountRead {
  const typed = text.trim();
  if (!typed) return { ok: true, value: "" };
  const point = decimalPoint(language);
  const parts = typed.split(point);
  if (parts.length > 2) return { ok: false, why: "unclear" };
  const [whole, fraction] = parts;
  if (fraction !== undefined && !/^\d*$/.test(fraction)) return { ok: false, why: "unclear" };
  let digits = whole;
  if (!/^\d*$/.test(whole)) {
    const groups = whole.split(/[.,\s\u00a0\u202f]/);
    if (!/^[1-9]\d{0,2}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return { ok: false, why: "unclear" };
    digits = groups.join("");
  }
  if (fraction !== undefined && !decimals) return { ok: false, why: "whole" };
  if (!digits && !fraction) return { ok: true, value: "" };
  return { ok: true, value: fraction ? `${digits || "0"}.${fraction}` : digits };
}

/** An amount ("1000.5", as `readAmount` gives it) as its field writes it in `language`: "1000,5" in Portuguese. */
export function amountText(value: string, language: Language = "en"): string {
  return decimalPoint(language) === "," ? value.replace(".", ",") : value;
}
