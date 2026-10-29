import { useMemo } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { isGroupChat, useChatLanguage } from "../lib/chatLanguage";
import { translatesChat, useChatTranslate } from "../lib/chatTranslate";
import { isDesktopApp } from "../lib/externalLink";
import { translateEnabled } from "../lib/translateFlag";
import { useChatDetections } from "../lib/translateReceived";
import type { ComposerTranslation } from "./useDraftTranslation";

/** Only the Desktop app has a translation runtime in the first version (not Android, not the web app). */
const hasRuntime = () => isDesktopApp() && !/Android/i.test(navigator.userAgent);

/**
 * What the composer of `chat` (a session id, or `group:<id>`) gets to translate a draft before it goes, or nothing:
 * a build without translation, a client without the runtime, a chat whose translation is off (its own On or Off, else
 * the Settings switch: lib/chatTranslate.ts), or one with no language yet. The language is the chat's
 * (lib/chatLanguage.ts: set by hand, else what the others' messages say); a group with no single one gives its
 * languages, most used first (docs/AUTO-TRANSLATE.md § UI, Composer).
 * TODO slice 5: `askModel`, the download question for the reverse model ("English to Italian, 37 MB"); until then a
 * missing model is said in the composer.
 */
export function useComposerTranslation(chat: string | undefined): ComposerTranslation | undefined {
  const { settings } = useSettings();
  const choice = useChatTranslate(chat ?? "");
  const detected = useChatDetections(chat ?? "");
  const current = useChatLanguage(chat ?? "", detected, !!chat && isGroupChat(chat));
  const on = !!chat && translateEnabled() && hasRuntime() && translatesChat(choice, settings.translateMessages);
  const language = on ? current.language : null;
  const key = on && !language ? current.languages.join(",") : "";
  return useMemo(() => language || key ? { language, languages: key ? key.split(",") : [] } : undefined, [language, key]);
}
