import { loadLocale, translatorFor } from "../../ui/src/locales";
import type { Translate } from "../../ui/src/locales/translate";
import type { Language } from "../../ui/src/lib/settings";
import { getPrefix } from "../../ui/src/lib/storage";
import { languageTag, textDirection } from "../../ui/src/lib/documentLanguage";
import { hostErrorText } from "../../ui/src/lib/serviceWindows";
import type { ShownError } from "./messages";

/*
 * What a viewer tab shows when the contact's machine answered in place of their app, said as Desktop's service windows
 * say it (`answerServiceWindow`): in the profile's language and from this side. Loaded by the peer (offscreen.ts) only
 * when that happens, so its start carries no dictionary. A request that got no answer at all is said by the page that
 * opened the tab (`ViewerPage`).
 */

/** The contact's machine answered in place of their app (docs/PROTOCOL.md "Host errors"), in its own English. */
export const hostErrorShown = (headers: readonly (readonly [string, string])[], app: string): Promise<ShownError> =>
  shown((t) => hostErrorText(headers, app, t) ?? t("services.window.failed"));

/**
 * In the profile's language, as its pages keep it (settings.ts `settingsKey`, under the storage profile the peer set).
 * Read only: a profile with no settings yet is its first page's to set up, so English meanwhile.
 */
async function shown(say: (t: Translate) => string): Promise<ShownError> {
  const { language, t } = await profileWords();
  return { text: say(t), lang: languageTag(language), dir: textDirection(language) };
}

/** The profile's language, and its words loaded (see `shown`). */
export async function profileWords(): Promise<{ language: Language; t: Translate }> {
  let language: Language = "en";
  try {
    language = (JSON.parse(localStorage.getItem(`${getPrefix()}app_settings`) ?? "{}") as { language?: Language }).language ?? "en";
  } catch { /* unreadable: English */ }
  await loadLocale(language);
  return { language, t: translatorFor(language) };
}
