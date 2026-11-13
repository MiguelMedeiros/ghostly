import { defineConfig } from "vite";

const EXTERNAL = /^(@noble\/|@scure\/|b4a$|vitest$)/;

/**
 * One bundle per entry point. The contracts, fakes, suites and registry are the app's own source
 * (packages/browser, packages/core), bundled here so a tarball stands on its own; the crypto libraries
 * stay dependencies, and vitest (the suites) a peer. Only for the app's source: the npm code bundled with
 * it (keet-identity-key, which core imports for Keet proofs) is CommonJS, and its `require` of a package
 * left external throws in an ES module, so what it requires is bundled with it.
 */
export default defineConfig({
  build: {
    lib: { entry: { index: "src/index.ts", fakes: "src/fakes.ts", testing: "src/testing.ts", core: "src/core.ts", app: "src/app.ts" }, formats: ["es"] },
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    minify: false,
    sourcemap: true,
    rollupOptions: { external: (id, importer) => EXTERNAL.test(id) && !importer?.includes("/node_modules/") },
  },
});
