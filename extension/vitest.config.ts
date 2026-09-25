import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { tauriAliases } from "../packages/browser/vite-plugin.ts";
import { maxWorkers } from "../vitest.shared.ts";

// As in packages/browser/vitest.config.ts: OpenPGP.js publishes its lightweight build under a "browser" condition
// only. No test here runs it, but `vitest related` follows the peer's dynamic imports down to it.
const openpgp = join(createRequire(import.meta.url).resolve("openpgp"), "../../lightweight/openpgp.mjs");

// The service worker, the offscreen document and the host run here against a
// fake `chrome.*` (test/fakeChrome.ts); the peer itself is packages/browser's.
export default defineConfig({
  resolve: { alias: [...Object.entries(tauriAliases ?? {}).map(([find, replacement]) => ({ find, replacement })), { find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  test: {
    include: ["test/**/*.test.ts"],
    // Each test boots the worker from fresh modules; the first boot of a file
    // transforms all of @ghostly/core, which takes a while on a cold cache.
    hookTimeout: 60_000,
    maxWorkers,
  },
});
