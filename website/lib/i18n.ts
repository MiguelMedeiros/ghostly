/**
 * English lives at the site's existing URLs; every other language under its
 * own prefix. Copy sits next to the page it belongs to, one object per locale,
 * and `satisfies Localized<T>` makes a missing translation a type error.
 */
export const LOCALES = ["en", "pt-br"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export type Localized<T> = Record<Locale, T>;

export const LOCALE_META: Record<Locale, { label: string; short: string; html: string; og: string }> = {
  en: { label: "English", short: "EN", html: "en", og: "en_US" },
  "pt-br": { label: "Português (Brasil)", short: "PT", html: "pt-BR", og: "pt_BR" },
};

/** Pages that exist in every locale; the rest are English only. */
const TRANSLATED = [/^\/$/, /^\/developers(\/.*)?$/, /^\/roadmap$/];

export function isTranslated(path: string): boolean {
  const clean = path.split(/[?#]/)[0] || "/";
  return TRANSLATED.some((re) => re.test(clean));
}

/** A site path in a locale. Paths without a translation stay in English. */
export function href(locale: Locale, path: string): string {
  if (locale === DEFAULT_LOCALE || !isTranslated(path)) return path;
  const [base, rest = ""] = path.split(/(?=[?#])/);
  return `/${locale}${base === "/" ? "" : base}${rest}`;
}

/** The locale a URL path belongs to, and the path without its prefix. */
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) {
      return { locale, path: pathname.slice(locale.length + 1) || "/" };
    }
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}

/** hreflang alternates for a translated page. */
export function alternates(path: string, locale: Locale) {
  return {
    canonical: href(locale, path),
    languages: Object.fromEntries(
      LOCALES.map((l) => [LOCALE_META[l].html, href(l, path)]),
    ) as Record<string, string>,
  };
}
