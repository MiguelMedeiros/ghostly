import ar from "../../../ui/src/locales/ar/pwa.json";
import en from "../../../ui/src/locales/en/pwa.json";
import es from "../../../ui/src/locales/es/pwa.json";
import fr from "../../../ui/src/locales/fr/pwa.json";
import it from "../../../ui/src/locales/it/pwa.json";
import ja from "../../../ui/src/locales/ja/pwa.json";
import pt from "../../../ui/src/locales/pt/pwa.json";
import zh from "../../../ui/src/locales/zh/pwa.json";
import type { DEVICE_NOTICE_DEFAULTS } from "./policy";

/*
 * The words of a device that is not the active one (WISP 06 § Push and the phone) when no page of the profile wrote its
 * own yet: a phone enrolled a moment ago, whose standby screen never ran with push on. They come from the app's own
 * translations (`pwa.json`), in the browser's language, so the first quiet notice is not in English on a phone that is
 * not. A page that runs writes the app's language over them (`writeWakeText`).
 */

type Words = Record<keyof typeof DEVICE_NOTICE_DEFAULTS, string>;
const LOCALES = { ar, en, es, fr, it, ja, pt, zh } as const;

/** The six notices in a translation file, with the worker's `{device}` where the app has `{{device}}`. */
function wordsOf(dict: (typeof LOCALES)[keyof typeof LOCALES]): Words {
  const fill = (text: string) => text.split("{{device}}").join("{device}");
  return {
    standby: fill(dict.wakeStandby), standbyCall: fill(dict.wakeStandbyCall), standbyUnnamed: fill(dict.wakeStandbyUnnamed),
    standbyCallUnnamed: fill(dict.wakeStandbyCallUnnamed), takeover: fill(dict.wakeTakeover), moveHere: fill(dict.wakeMoveHere),
  };
}

/** The notices in the first of `languages` the app speaks ("pt-BR" is Portuguese), or in English. */
export function deviceNoticeWords(languages: readonly string[]): Words {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0] as keyof typeof LOCALES;
    if (base in LOCALES) return wordsOf(LOCALES[base]);
  }
  return wordsOf(en);
}
