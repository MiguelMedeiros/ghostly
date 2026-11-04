import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { isGroupChat, useChatLanguage } from "../lib/chatLanguage";
import { chatTranslateChoice, translatesChat, watchChatTranslate } from "../lib/chatTranslate";
import { isDesktopApp } from "../lib/externalLink";
import { loadDetector } from "../lib/translateDetector";
import { translateEnabled } from "../lib/translateFlag";
import { chatDetections, watchTranslations } from "../lib/translateReceived";
import type { DetectLanguages } from "../lib/translateWhich";
import type { ComposerTranslation } from "./useDraftTranslation";

/** Only the Desktop app has a translation runtime in the first version (not Android, not the web app). */
const hasRuntime = () => isDesktopApp() && !/Android/i.test(navigator.userAgent);

/** Watches nothing: what a build or client without translation subscribes to. */
const idle = () => () => {};
const NONE: readonly string[] = [];

/** The draft's language detector, loaded once for every composer, the first time one translates. */
let detector: Promise<DetectLanguages | null> | undefined;

function useDraftDetector(wanted: boolean): DetectLanguages | undefined {
  const [detect, setDetect] = useState<DetectLanguages>();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void (detector ??= loadDetector().catch(() => null)).then((loaded) => { if (live && loaded) setDetect(() => loaded); });
    return () => { live = false; };
  }, [wanted]);
  return wanted ? detect : undefined;
}

/**
 * What the composer of `chat` (a session id, or `group:<id>`) gets to translate a draft before it goes, or nothing:
 * a build without translation, a client without the runtime, a chat whose translation is off (its own On or Off, else
 * the Settings switch: lib/chatTranslate.ts), or one with no language yet. The language is the chat's
 * (lib/chatLanguage.ts: set by hand, else what the others' messages say); a group with no single one gives its
 * languages, most used first (docs/AUTO-TRANSLATE.md § UI, Composer). The draft's own language is read by the same
 * detector as received messages once it has loaded (until then, and without it, the draft is taken to be in the app's
 * language). In a build or client without translation nothing is watched or read.
 * Not here yet: `askModel`, the download question for the reverse model ("English to Italian, 37 MB"): a missing
 * model is said in the composer (ghostly-agents#1811).
 */
export function useComposerTranslation(chat: string | undefined): ComposerTranslation | undefined {
  const { settings } = useSettings();
  const id = chat ?? "";
  const able = !!chat && translateEnabled() && hasRuntime();
  const choice = useSyncExternalStore(able ? watchChatTranslate : idle, () => able ? chatTranslateChoice(id) : "settings");
  const detected = useSyncExternalStore(able ? watchTranslations : idle, () => able ? chatDetections(id) : NONE);
  const current = useChatLanguage(id, detected, able && isGroupChat(id), able);
  const on = able && translatesChat(choice, settings.translateMessages);
  const language = on ? current.language : null;
  const key = on && !language ? current.languages.join(",") : "";
  const detect = useDraftDetector(on && !!(language || key));
  return useMemo(() => language || key ? { language, languages: key ? key.split(",") : [], ...(detect && { detect }) } : undefined,
    [language, key, detect]);
}
