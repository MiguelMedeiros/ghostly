import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useSettings } from "./SettingsContext";
import type { Language } from "../lib/settings";
import { applyDocumentLanguage, textDirection } from "../lib/documentLanguage";

import { locales as translations, type TranslationDict } from "../locales";

type NestedKeyOf<T, K extends string = ""> = T extends object
  ? {
      [P in keyof T & string]: NestedKeyOf<
        T[P],
        K extends "" ? P : `${K}.${P}`
      >;
    }[keyof T & string]
  : K;

type TranslationKey = NestedKeyOf<TranslationDict>;

/** `t()` as a value: for content worked out outside a component (identities/idCard.ts). */
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface I18nContextValue {
  t: Translate;
  language: Language;
  dir: "ltr" | "rtl";
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getNestedValue(obj: unknown, path: string): string {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return path;
    }
  }
  return typeof current === "string" ? current : path;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const language = settings.language;

  const dir = textDirection(language);

  // A layout effect: the new language and direction are on <html> before the screen repaints in them.
  useLayoutEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  const t = useMemo(() => {
    const currentTranslations = translations[language] || translations.en;
    return (
      key: TranslationKey,
      params?: Record<string, string | number>
    ): string => {
      let value = getNestedValue(currentTranslations, key);
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          value = value.replace(new RegExp(`{{${k}}}`, "g"), String(v));
        });
      }
      return value;
    };
  }, [language]);

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

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}
