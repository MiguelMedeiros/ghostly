import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  // The site was also in Brazilian Portuguese under /pt-br; it is English only now,
  // and links to the old pages land on their English ones.
  // The WISP catalog moved from /developers/catalog to /developers/wisps, the index of the WISPs'
  // own pages. The old address, and its /pt-br one in a single hop, keep working.
  async redirects() {
    return [
      { source: "/developers/catalog", destination: "/developers/wisps", permanent: true },
      { source: "/pt-br/developers/catalog", destination: "/developers/wisps", permanent: true },
      { source: "/pt-br", destination: "/", permanent: true },
      { source: "/pt-br/:path*", destination: "/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
