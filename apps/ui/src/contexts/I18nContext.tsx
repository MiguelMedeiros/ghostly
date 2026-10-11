import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSettings } from "./SettingsContext";
import type { Language } from "../lib/settings";
import { applyDocumentLanguage, textDirection } from "../lib/documentLanguage";
import { setDefaultProfileName, setRestoredProfileName } from "../lib/profiles";

import { loadLocale, loadedLocale, translatorFor } from "../locales";
import { englishT, type Translate } from "../locales/translate";

export type { Translate, TranslationKey } from "../locales/translate";

interface I18nContextValue {
  t: Translate;
  language: Language;
  dir: "ltr" | "rtl";
  /** The chosen language's file did not arrive: the app stays in `language`, the one shown before. */
  languageNotLoaded: boolean;
  /** Asks for the chosen language again. */
  retryLanguage: () => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  // A language is shown once its dictionary is here (the entry loads the profile's before the first render); one just
  // chosen waits for its own, with the one shown before kept meanwhile.
  const chosen = settings.language;
  const [shown, setShown] = useState<Language>(() => (loadedLocale(chosen) ? chosen : "en"));
  // A language's file may not arrive (the network dropped, a deploy replaced the files): it is said (Settings, on the
  // Language row) and asked for again there, and by itself when the network is back or the window is shown again.
  const [failed, setFailed] = useState<Language | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryLanguage = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    void loadLocale(chosen).then(() => {
      if (!live) return;
      if (loadedLocale(chosen)) setShown(chosen);
      setFailed(loadedLocale(chosen) ? null : chosen);
    });
    return () => { live = false; };
  }, [chosen, attempt]);
  const languageNotLoaded = failed === chosen && !loadedLocale(chosen);
  useEffect(() => {
    if (!languageNotLoaded) return;
    const shownAgain = () => { if (document.visibilityState !== "hidden") retryLanguage(); };
    window.addEventListener("online", retryLanguage);
    document.addEventListener("visibilitychange", shownAgain);
    return () => {
      window.removeEventListener("online", retryLanguage);
      document.removeEventListener("visibilitychange", shownAgain);
    };
  }, [languageNotLoaded, retryLanguage]);
  const language = loadedLocale(chosen) ? chosen : shown;

  const dir = textDirection(language);

  // A layout effect: the new language and direction are on <html> before the screen repaints in them.
  useLayoutEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  const t = useMemo(() => translatorFor(language), [language]);
  // The first profile's built-in name in this language, for whatever lists profiles (lib/profiles has no translator):
  // set as this renders, so the screens rendered in the new language read it; those keeping a list hear it after.
  setDefaultProfileName(t("profile.defaultName"));
  // And a restored profile's "(restored)", which the registry keeps as a flag.
  setRestoredProfileName((name) => t("profile.restoredName", { name }));
  useEffect(() => { window.dispatchEvent(new Event("profiles-updated")); }, [t]);

  return (
    <I18nContext.Provider value={{ t, language, dir, languageNotLoaded, retryLanguage }}>
      {children}
    </I18nContext.Provider>
  );
}

/** The translator where there may be no provider (layout primitives rendered on their own): null there. */
export function useOptionalI18n(): I18nContextValue | null {
  return useContext(I18nContext);
}

/** `t()` where there may be no provider (a bubble drawn on its own): English there. */
export function useT(): Translate {
  return useContext(I18nContext)?.t ?? englishT;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}
