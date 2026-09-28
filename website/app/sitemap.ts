import type { MetadataRoute } from "next";
import { references } from "@/lib/references";

const BASE = "https://ghostly.tools";

function entry(path: string, priority: number, changeFrequency: "weekly" | "yearly" = "weekly"): MetadataRoute.Sitemap[number] {
  return { url: `${BASE}${path}`, changeFrequency, priority };
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    entry("/", 1),
    entry("/developers", 0.9),
    entry("/developers/wisps", 0.8),
    entry("/roadmap", 0.8),
    ...references.map((ref) => entry(`/developers/wisps/${ref.slug}`, 0.6)),
    entry("/docs", 0.7),
    entry("/cli", 0.7),
    entry("/privacy", 0.3, "yearly"),
  ];
}
