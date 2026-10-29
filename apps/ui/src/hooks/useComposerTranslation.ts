import { useMemo } from "react";
import { isDesktopApp } from "../lib/externalLink";
import { translateEnabled } from "../lib/translateFlag";
import type { ComposerTranslation } from "./useDraftTranslation";

/** Only the Desktop app has a translation runtime in the first version (not Android, not the web app). */
const hasRuntime = () => isDesktopApp() && !/Android/i.test(navigator.userAgent);

/**
 * Whether `chat` translates: its own On or Off, or Settings' switch when it never chose.
 * TODO slice 9: `lib/chatTranslate.ts`'s choice for the chat (with slice 6's `translateMessages` for As in Settings).
 */
function chatTranslates(_chat: string): boolean {
  return false;
}

/**
 * The language `chat` is written to in, and a group's languages most used first when it has no single one.
 * TODO slice 10: `lib/chatLanguage.ts` (set by hand, else remembered from what the others write).
 */
function outgoingLanguage(_chat: string): { language: string | null; languages: string[] } {
  return { language: null, languages: [] };
}

/**
 * What the composer of `chat` (a session id, or `group:<id>`) gets to translate a draft before it goes, or nothing:
 * a build without translation, a client without the runtime, a chat whose translation is off, or one with no
 * language yet (docs/AUTO-TRANSLATE.md § UI, Composer).
 * TODO slice 5: `askModel`, the download question for the reverse model ("English to Italian, 37 MB"); until then a
 * missing model is said in the composer.
 */
export function useComposerTranslation(chat: string | undefined): ComposerTranslation | undefined {
  const on = !!chat && translateEnabled() && hasRuntime() && chatTranslates(chat);
  const { language, languages } = on ? outgoingLanguage(chat) : { language: null, languages: [] };
  const key = languages.join(",");
  return useMemo(() => on && (language || key) ? { language, languages: key ? key.split(",") : [] } : undefined, [on, language, key]);
}
