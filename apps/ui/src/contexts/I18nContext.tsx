import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useSettings } from "./SettingsContext";
import type { Language } from "../lib/settings";
import { applyDocumentLanguage, textDirection } from "../lib/documentLanguage";
import { setDefaultProfileName, setRestoredProfileName } from "../lib/profiles";

import { locales as translations } from "../locales";
import { englishT, translateWith, type Translate } from "../locales/translate";

export type { Translate, TranslationKey } from "../locales/translate";

interface I18nContextValue {
  t: Translate;
  language: Language;
  dir: "ltr" | "rtl";
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const language = settings.language;

  const dir = textDirection(language);

  // A layout effect: the new language and direction are on <html> before the screen repaints in them.
  useLayoutEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  const t = useMemo(() => translateWith(translations[language] || translations.en, translations[language] ? language : "en"), [language]);
  // The first profile's built-in name in this language, for whatever lists profiles (lib/profiles has no translator):
  // set as this renders, so the screens rendered in the new language read it; those keeping a list hear it after.
  setDefaultProfileName(t("profile.defaultName"));
  // And a restored profile's "(restored)", which the registry keeps as a flag.
  setRestoredProfileName((name) => t("profile.restoredName", { name }));
  useEffect(() => { window.dispatchEvent(new Event("profiles-updated")); }, [t]);

  return (
    <I18nContext.Provider value={{ t, language, dir }}>
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
