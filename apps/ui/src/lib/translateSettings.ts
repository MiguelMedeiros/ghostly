import type { Translate } from "../locales/translate";
import type { DownloadedPair } from "../desktop/translateStatus";
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

/** `code`'s name in `language` ("português" for `pt` in Portuguese), or the code where the runtime has no name for it. */
export function languageName(code: string, language: Language): string {
  try {
    return new Intl.DisplayNames([language], { type: "language", fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
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
export function downloadedLanguages(pairs: readonly DownloadedPair[], t: Translate): PairLine[] {
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
