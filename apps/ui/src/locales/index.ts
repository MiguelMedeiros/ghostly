import type { Language } from "../lib/settings";
import en from "./en";
import { translateWith, type Translate } from "./translate";

/**
 * Every locale the app ships. Each language is a folder of one file per area of the app,
 * apps/ui/src/locales/<language>/<area>.json, so a feature adds its keys to its own area's file (or a new one) and pull
 * requests adding keys at the same time rarely touch the same lines. Keys are sorted in every file
 * (`npm run locales:sort`; the i18n tests fail otherwise). English is imported area by area, for the types
 * (en/index.ts), and is always in the app. Each other language is its folder's index.ts, a chunk of its own loaded when
 * a profile reads in it (`loadLocale`): the first screen carries one language, not eight.
 */
export type TranslationDict = typeof en;

const folders = import.meta.glob<Record<string, unknown>>(["./*/index.ts", "!./en/index.ts"], { import: "default" });
const loaded: Partial<Record<Language, TranslationDict>> = { en };

/** A language's areas, `{ "./chat.json": {...} }`, as one dictionary, `{ chat: {...} }`, the shape `t()` looks `area.key` up in. */
function assemble(files: Record<string, unknown>): TranslationDict {
  const dict: Record<string, unknown> = {};
  for (const [path, area] of Object.entries(files)) dict[path.replace(/^\.\/|\.json$/g, "")] = area;
  return dict as TranslationDict;
}

/** The dictionary of `language` once it is loaded (English always is). */
export function loadedLocale(language: Language): TranslationDict | undefined {
  return loaded[language];
}

/** Loads `language`'s dictionary, once. One that could not be fetched leaves English meanwhile, and is asked for again next time. */
export async function loadLocale(language: Language): Promise<void> {
  const load = folders[`./${language}/index.ts`];
  if (loaded[language] || !load) return;
  try {
    loaded[language] = assemble(await load());
  } catch (error) {
    console.warn(`Language ${language} did not load:`, error);
  }
}

/** The translator for `language`, or English while its dictionary is not loaded. */
export function translatorFor(language: Language): Translate {
  const dict = loaded[language];
  return dict ? translateWith(dict, language) : translateWith(en, "en");
}
