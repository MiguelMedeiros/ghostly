import type { NextConfig } from "next";
import numbering from "./lib/wisp-numbering.json";

/**
 * Documents on GitHub only, on the released branch: the security policy and the contributing guide (content/shell.ts
 * links the same two), and the two WISP documents that repeat the list /wisps shows (scripts/sync-references.mjs).
 */
const GITHUB = "https://github.com/MiguelMedeiros/ghostly/blob";
const ON_GITHUB = [
  ["security", `${GITHUB}/main/.github/SECURITY.md`],
  ["contributing", `${GITHUB}/main/.github/CONTRIBUTING.md`],
  ["implementation", `${GITHUB}/main/docs/wisps/IMPLEMENTATION.md`],
  ["numbering", `${GITHUB}/main/docs/wisps/NUMBERING.md`],
];

/**
 * WISPs that got their number once their feature shipped (numbering.json: `oldFile` is the stem they had while their
 * number was "xx"). Their old pages still render, with a notice, but a link to one lands on the new page in one hop.
 */
const RENUMBERED = (numbering as { oldFile: string; file: string }[])
  .filter((entry) => entry.oldFile !== entry.file && /^\d+x+-/.test(entry.oldFile))
  .map((entry) => [entry.oldFile.replace(/\.md$/, "").toLowerCase(), entry.file.replace(/\.md$/, "").toLowerCase()]);

/** React's development build needs eval() for its debugging; production never uses it, so only `next dev` allows it. */
const SCRIPT_SRC = process.env.NODE_ENV === "production" ? "script-src 'self' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const nextConfig: NextConfig = {
  output: "standalone",
  // No `X-Powered-By: Next.js` on any answer: no reader needs it. Next's x-nextjs-* headers, its RSC Vary and the /_next/
  // paths in every page still show the framework.
  poweredByHeader: false,
  turbopack: {
    root: __dirname,
  },
  // HTTPS only, for a year once a browser has seen the site over HTTPS (Cloudflare adds no HSTS itself, and a browser
  // ignores it over http://: redirects() sends such a visit to HTTPS first).
  // Scripts from this site only: its own files and the inline ones Next.js writes into each page (the page's data, the
  // two head scripts in app/layout.tsx). No third-party script runs, so none that a proxy slips into the page does
  // either (Cloudflare's Web Analytics beacon was injected into every page; /privacy says there are no analytics).
  // No page of another site (or of this one: the site frames nothing of its own) shows a page of the site inside a
  // frame, the invite dialog included: frame-ancestors, and X-Frame-Options for a browser that reads only that. A file
  // is read as the type the site says it is, and a link out of the site says only which site it came from.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "Content-Security-Policy", value: `${SCRIPT_SRC}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    }];
  },
  // A visit over plain http:// lands on the same address over https://, before anything else: Cloudflare reaches the
  // site through the tunnel whatever the visitor used, and says which it was in CF-Visitor. Not X-Forwarded-Proto:
  // Next.js sets that one to "http" itself on a request without it and routes a missing page again, which would send
  // a 404 of a plain http://localhost to https.
  //
  // Every old address lands in one hop, its #anchor riding along:
  // - The WISPs page is /wisps. It was /developers/wisps, and before that /developers/catalog.
  // - The protocol guide at /docs is gone: the WISPs page is the one place for the protocol.
  // - Security and Contributing were reader pages; they are on GitHub only now.
  // - The site was also in Brazilian Portuguese under /pt-br; it is English only now, and links to the old pages
  //   land on their English ones.
  // - A WISP whose number was "xx" (3xx-ssh) moved to its number (307-ssh) once its feature shipped.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [
          { type: "header", key: "cf-visitor", value: '.*"scheme":"http".*' },
          { type: "host", value: "(?<host>.+)" },
        ],
        destination: "https://:host/:path*",
        permanent: true,
      },
      ...ON_GITHUB.flatMap(([slug, url]) =>
        ["/wisps", "/developers/wisps", "/pt-br/developers/wisps"].map((base) => ({ source: `${base}/${slug}`, destination: url, permanent: true })),
      ),
      ...RENUMBERED.flatMap(([from, to]) =>
        ["/wisps", "/developers/wisps", "/pt-br/developers/wisps"].map((base) => ({ source: `${base}/${from}`, destination: `/wisps/${to}`, permanent: true })),
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
