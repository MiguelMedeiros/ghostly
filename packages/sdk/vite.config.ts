import { defineConfig } from "vite";

/**
 * One bundle per entry point. The contracts, fakes, suites and registry are the app's own source
 * (packages/browser, packages/core), bundled here so a tarball stands on its own; the crypto libraries
 * stay dependencies, and vitest (the suites) a peer.
 */
export default defineConfig({
  build: {
    lib: { entry: { index: "src/index.ts", fakes: "src/fakes.ts", testing: "src/testing.ts", core: "src/core.ts" }, formats: ["es"] },
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    minify: false,
    sourcemap: true,
    rollupOptions: { external: [/^@noble\//, /^@scure\//, "b4a", "vitest"] },
  },
});
