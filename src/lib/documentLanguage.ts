import type { Language } from "./settings";

/** Each interface language as a BCP 47 tag: what `<html lang>` tells screen readers, hyphenation and spell-check. */
const TAGS: Record<Language, string> = {
  en: "en",
  pt: "pt-BR",
  es: "es",
  fr: "fr",
  it: "it",
  zh: "zh-CN",
  ja: "ja",
  ar: "ar",
};

const RIGHT_TO_LEFT: ReadonlySet<Language> = new Set(["ar"]);

/** The BCP 47 tag for `language`; one the app does not know (a hand-edited setting) reads as English, as `t()` does. */
export const languageTag = (language: Language): string => TAGS[language] ?? TAGS.en;

export const textDirection = (language: Language): "ltr" | "rtl" => (RIGHT_TO_LEFT.has(language) ? "rtl" : "ltr");

/** Sets `<html lang>` and `<html dir>` for `language`. The entry points call it before the first render, the I18nProvider on every change. */
export function applyDocumentLanguage(language: Language, root: HTMLElement = document.documentElement): void {
  root.lang = languageTag(language);
  root.dir = textDirection(language);
}
