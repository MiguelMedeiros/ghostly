import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { defineConfig, type Plugin } from "vite";

// OpenPGP.js publishes its lightweight build under a "browser" condition only; it runs on Node too
// (as in packages/browser's tests), so the CLI ships the very code the apps do.
const require = createRequire(import.meta.url);
const openpgp = join(require.resolve("openpgp"), "../../lightweight/openpgp.mjs");

/**
 * The wallet SDKs' web builds find IndexedDB through the browser's `window`, which Node lacks (and defining one would
 * turn other libraries onto their browser paths). Each rewrite below makes one such check accept the `indexedDB` the
 * runtime provides. A release that changes the text fails the build here rather than a wallet at run time.
 */
const ON_NODE: { file: RegExp; find: string; replace: string }[] = [
  // Breez (Spark): its storage refuses to start without `window.indexedDB`.
  { file: /@breeztech\/breez-sdk-spark\/web\/storage\/index\.js$/, find: 'if (typeof window === "undefined" || !window.indexedDB) {', replace: 'if (typeof indexedDB === "undefined") {' },
];

/**
 * WebAssembly a bundled SDK loads with `new URL("<file>", import.meta.url)`, which SSR builds leave as written: the
 * file is copied beside the chunks (every chunk is in `assets/`).
 */
const BESIDE_CHUNKS = [{ entry: "@breeztech/breez-sdk-spark/web", file: "breez_sdk_spark_wasm_bg.wasm" }];

function walletSdksOnNode(): Plugin {
  return {
    name: "ghostly-wallet-sdks-on-node",
    enforce: "pre",
    generateBundle() {
      for (const { entry, file } of BESIDE_CHUNKS) {
        this.emitFile({ type: "asset", fileName: `assets/${file}`, source: readFileSync(new URL(file, import.meta.resolve(entry))) });
      }
    },
    transform(code, id) {
      const rule = ON_NODE.find((r) => r.file.test(id));
      if (!rule) return;
      if (!code.includes(rule.find)) this.error(`${id} changed: review ON_NODE in packages/cli/vite.config.ts`);
      return code.replace(rule.find, rule.replace);
    },
  };
}

/**
 * One file for Node: the CLI, the daemon and the engine they run (the app's own `@ghostly/browser` and
 * `@ghostly/core`, compiled from their TypeScript). Packages from npm stay imports, resolved from
 * node_modules at run time; the workspace packages are bundled in.
 */
export default defineConfig({
  resolve: { alias: [{ find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  plugins: [walletSdksOnNode()],
  build: {
    ssr: "src/bin.ts",
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // The wallet SDKs' WebAssembly files go beside the bundle.
    ssrEmitAssets: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: "ghostly.mjs", format: "es" } },
  },
  // Breez's web build is bundled so its IndexedDB check can be rewritten (ON_NODE).
  ssr: { target: "node", noExternal: [/^@ghostly\//, /^@breeztech\/breez-sdk-spark/] },
  // A `?url` asset (the wallet SDKs' WebAssembly) is a file beside the chunk that imports it, as a `file:` URL: Node
  // has no web root to resolve "/assets/…" against. The runtime's fetch reads such files (src/runtime/fileFetch.ts).
  experimental: {
    renderBuiltUrl(filename, { hostId }) {
      const relative = posix.relative(posix.dirname(hostId), filename);
      return { runtime: `new URL(${JSON.stringify(relative.startsWith(".") ? relative : "./" + relative)}, import.meta.url).href` };
    },
  },
});
