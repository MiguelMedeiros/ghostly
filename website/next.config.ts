import type { NextConfig } from "next";

/**
 * Documents on GitHub only, on the released branch: the security policy and the contributing guide (content/shell.ts
 * links the same two), and the two WISP documents that repeat the list /wisps shows (scripts/sync-references.mjs).
 */
const GITHUB = "https://github.com/MiguelMedeiros/ghostly/blob";
const ON_GITHUB = [
  ["security", `${GITHUB}/main/SECURITY.md`],
  ["contributing", `${GITHUB}/main/CONTRIBUTING.md`],
  ["implementation", `${GITHUB}/main/docs/wisps/IMPLEMENTATION.md`],
  ["numbering", `${GITHUB}/main/docs/wisps/NUMBERING.md`],
];

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  // HTTPS only, for a year once a browser has seen the site (Cloudflare serves it over HTTPS and adds no HSTS itself).
  // Scripts from this site only: its own files and the inline ones Next.js writes into each page (the page's data, the
  // two head scripts in app/layout.tsx). No third-party script runs, so none that a proxy slips into the page does
  // either (Cloudflare's Web Analytics beacon was injected into every page; /privacy says there are no analytics).
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "Content-Security-Policy", value: "script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'" },
      ],
    }];
  },
  // Every old address lands in one hop, its #anchor riding along:
  // - The WISPs page is /wisps. It was /developers/wisps, and before that /developers/catalog.
  // - The protocol guide at /docs is gone: the WISPs page is the one place for the protocol.
  // - Security and Contributing were reader pages; they are on GitHub only now.
  // - The site was also in Brazilian Portuguese under /pt-br; it is English only now, and links to the old pages
  //   land on their English ones.
  async redirects() {
    return [
      ...ON_GITHUB.flatMap(([slug, url]) =>
        ["/wisps", "/developers/wisps", "/pt-br/developers/wisps"].map((base) => ({ source: `${base}/${slug}`, destination: url, permanent: true })),
      ),
      // The index on GitHub (docs/wisps/README.md) was a reader page too; on the site the index is /wisps.
      ...["/wisps", "/developers/wisps", "/pt-br/developers/wisps"].map((base) => ({ source: `${base}/readme`, destination: "/wisps", permanent: true })),
      ...["/developers/wisps", "/pt-br/developers/wisps"].flatMap((base) => [
        { source: base, destination: "/wisps", permanent: true },
        { source: `${base}/:slug*`, destination: "/wisps/:slug*", permanent: true },
      ]),
      ...["/developers/catalog", "/pt-br/developers/catalog", "/docs", "/docs/:path*", "/pt-br/docs", "/pt-br/docs/:path*"].map((source) => ({
        source,
        destination: "/wisps",
        permanent: true,
      })),
      { source: "/pt-br", destination: "/", permanent: true },
      { source: "/pt-br/:path*", destination: "/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
