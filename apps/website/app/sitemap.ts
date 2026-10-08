import type { MetadataRoute } from "next";
import { references } from "@/lib/references";
import { appsReleased } from "@/lib/appsGate";
import { storeView } from "@/lib/store";

const BASE = "https://ghostly.tools";

function entry(path: string, priority: number, changeFrequency: "weekly" | "yearly" = "weekly"): MetadataRoute.Sitemap[number] {
  return { url: `${BASE}${path}`, changeFrequency, priority };
}

// Answered for each request: the Apps pages are listed only once the released Ghostly has Apps (lib/appsGate.ts).
export const revalidate = 0;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const store = (await appsReleased()) ? storeView() : undefined;
  const apps = store ? [entry("/apps", 0.8), ...(store.ok ? store.apps.map((app) => entry(`/apps/${app.slug}`, 0.6)) : [])] : [];
  return [
    entry("/", 1),
    entry("/developers", 0.9),
    ...apps,
    entry("/wisps", 0.8),
    entry("/roadmap", 0.8),
    ...references.map((ref) => entry(`/wisps/${ref.slug}`, 0.6)),
    entry("/cli", 0.7),
    entry("/developers/agents", 0.7),
    entry("/privacy", 0.3, "yearly"),
    entry("/terms", 0.3, "yearly"),
  ];
}
