import type { MetadataRoute } from "next";
import { references } from "@/lib/references";
import { href, LOCALE_META, LOCALES } from "@/lib/i18n";

const BASE = "https://ghostly.tools";

function entry(path: string, priority: number, changeFrequency: "weekly" | "yearly" = "weekly"): MetadataRoute.Sitemap[number] {
  return {
    url: `${BASE}${href("en", path)}`,
    changeFrequency,
    priority,
    alternates: {
      languages: Object.fromEntries(LOCALES.map((l) => [LOCALE_META[l].html, `${BASE}${href(l, path)}`])),
    },
  };
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    entry("/", 1),
    entry("/developers", 0.9),
    entry("/developers/catalog", 0.8),
    entry("/roadmap", 0.8),
    ...references.map((ref) => entry(`/developers/wisps/${ref.slug}`, 0.6)),
    { url: `${BASE}/docs`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/cli`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/privacy`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
