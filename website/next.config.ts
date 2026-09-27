import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  // The site was also in Brazilian Portuguese under /pt-br; it is English only now,
  // and links to the old pages land on their English ones.
  async redirects() {
    return [
      { source: "/pt-br", destination: "/", permanent: true },
      { source: "/pt-br/:path*", destination: "/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
