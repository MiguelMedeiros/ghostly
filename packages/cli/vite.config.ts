import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "vite";

// OpenPGP.js publishes its lightweight build under a "browser" condition only; it runs on Node too
// (as in packages/browser's tests), so the CLI ships the very code the apps do.
const openpgp = join(createRequire(import.meta.url).resolve("openpgp"), "../../lightweight/openpgp.mjs");

/**
 * One file for Node: the CLI, the daemon and the engine they run (the app's own `@ghostly/browser` and
 * `@ghostly/core`, compiled from their TypeScript). Packages from npm stay imports, resolved from
 * node_modules at run time; the workspace packages are bundled in.
 */
export default defineConfig({
  resolve: { alias: [{ find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  build: {
    ssr: "src/main.ts",
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: "ghostly.mjs", format: "es" } },
  },
  ssr: { target: "node", noExternal: [/^@ghostly\//] },
});
