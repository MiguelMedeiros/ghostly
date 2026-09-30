import type { MetadataRoute } from "next";

// The only robots.txt: a public/robots.txt beside it makes `next dev` answer 500 and hides this one in a build.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      // Crawlers that fetch far more than they send.
      { userAgent: ["AhrefsBot", "SemrushBot"], allow: "/", crawlDelay: 10 },
    ],
    sitemap: "https://ghostly.tools/sitemap.xml",
  };
}
