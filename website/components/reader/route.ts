import type { Metadata } from "next";
import { findReference, references } from "@/lib/references";
import { findWisp } from "@/lib/wisps";
import { href, LOCALE_META, LOCALES, type Locale } from "@/lib/i18n";

/** Shared by the English and translated reader routes. */
export function readerParams(): Array<{ slug: string }> {
  return references.flatMap((ref) => [ref.slug, ...ref.aliases].map((slug) => ({ slug })));
}

export function readerMetadata(slug: string, locale: Locale): Metadata {
  const ref = findReference(slug);
  if (!ref) return { title: "Not found" };
  const w = findWisp(ref.slug);
  const path = `/developers/wisps/${ref.slug}`;
  return {
    title: w ? `WISP ${w.number} · ${w.name}` : ref.title,
    description: w?.benefit?.[locale] ?? ref.summary ?? `Ghostly reference: ${ref.title}`,
    alternates: {
      canonical: href(locale, path),
      languages: Object.fromEntries(LOCALES.map((l) => [LOCALE_META[l].html, href(l, path)])),
    },
  };
}
