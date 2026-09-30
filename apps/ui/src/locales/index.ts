import type { Language } from "../lib/settings";
import en from "./en";

/**
 * Every locale the app ships. Each language is a folder of one file per area of the app,
 * apps/ui/src/locales/<language>/<area>.json, so a feature adds its keys to its own area's file (or a new one) and pull
 * requests adding keys at the same time rarely touch the same lines. Keys are sorted in every file
 * (`npm run locales:sort`; the i18n tests fail otherwise). English is imported area by area, for the types
 * (en/index.ts); the other languages are assembled from their folders here.
 */
export type TranslationDict = typeof en;

const files = import.meta.glob<Record<string, unknown>>("./*/*.json", { eager: true, import: "default" });

/** A language's areas as one dictionary, `{ chat: {...}, common: {...} }`, the shape `t()` looks `area.key` up in. */
function assemble(language: string): TranslationDict {
  const dict: Record<string, unknown> = {};
  for (const [path, area] of Object.entries(files)) {
    const [, folder, name] = path.match(/^\.\/([^/]+)\/([^/]+)\.json$/)!;
    if (folder === language) dict[name] = area;
  }
  return dict as TranslationDict;
}

export const locales: Record<Language, TranslationDict> = {
  en,
  pt: assemble("pt"),
  es: assemble("es"),
  fr: assemble("fr"),
  it: assemble("it"),
  zh: assemble("zh"),
  ja: assemble("ja"),
  ar: assemble("ar"),
};
