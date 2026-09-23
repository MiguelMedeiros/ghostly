import { MetadataRoute } from "next";
import { references, referencePath } from "@/lib/references";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://ghostly.tools";

  return [
    ...references.map((ref) => ({
      url: `${baseUrl}${referencePath(ref.file)}`,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...["developers", "developers/catalog", "roadmap"].map((path) => ({
      url: `${baseUrl}/${path}`,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${baseUrl}/docs`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/cli`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
