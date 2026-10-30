import type { Translate } from "../locales/translate";
import type { TranslationPair } from "../desktop/translate";
import { languageName } from "./documentLanguage";
import { isDesktopApp } from "./externalLink";
import { formatBytes, type Language } from "./settings";
import { translateEnabled } from "./translateFlag";

/*
 * Settings → Appearance → Translate messages (docs/AUTO-TRANSLATE.md § UI): the switch that is the default for chats
 * that have not chosen, and the languages downloaded on this computer. Translation runs on Desktop only for now, so
 * every other client, and a build without `VITE_TRANSLATE`, shows nothing of it.
 */

/** Whether this client offers translation at all: a `VITE_TRANSLATE` build of the Desktop app (not Android's). */
export function translateOffered(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return translateEnabled() && isDesktopApp() && !/Android/i.test(userAgent);
}

/**
 * What turning translation on asks to download (docs/AUTO-TRANSLATE.md § Model download): the app's language to
 * English and back ("Portuguese to English and back"), the models every other language goes through. Nothing for an
 * app in English: the one it needs is the chat's language to English, and that comes from the chat.
 */
export function firstPairs(language: Language): { from: string; to: string; pairs: string[] } | null {
  return language === "en" ? null : { from: language, to: "en", pairs: [`${language}-en`, `en-${language}`] };
}

/**
 * What reading a chat in `from` takes in an app in `to`: the pinned pair straight between them, or both legs through
 * English when there is none (docs/AUTO-TRANSLATE.md § Languages). Nothing when they are the same.
 */
export function readingPairs(from: string, to: Language, pinned: readonly string[]): string[] {
  if (from === to) return [];
  const straight = `${from}-${to}`;
  return from === "en" || to === "en" || pinned.includes(straight) ? [straight] : [`${from}-en`, `en-${to}`];
}

/** One downloaded pair as Settings lists it: "Portuguese → English", "37 MB". */
export interface PairLine {
  pair: string;
  label: string;
  size: string;
}

const PAIR = /^([a-z]{2,3})-([a-z]{2,3})$/;

const capital = (name: string, language: Language) => name.charAt(0).toLocaleUpperCase(language) + name.slice(1);

/**
 * The downloaded pairs, named in the app's language and sorted by those names: a list line starts with a capital
 * ("Português → inglês"). A pair whose name is not `<from>-<to>` with two different codes is not a pair: left out.
 */
export function downloadedLanguages(pairs: readonly Pick<TranslationPair, "pair" | "bytes">[], t: Translate): PairLine[] {
  const language = t.language ?? "en";
  const lines: PairLine[] = [];
  for (const { pair, bytes } of pairs) {
    const [, from, to] = PAIR.exec(pair) ?? [];
    if (!from || !to || from === to) continue;
    const label = t("settings.translate.pair", { from: capital(languageName(from, language), language), to: languageName(to, language) });
    lines.push({ pair, label, size: formatBytes(bytes, t) });
  }
  const collator = new Intl.Collator(language);
  return lines.sort((a, b) => collator.compare(a.label, b.label));
}
