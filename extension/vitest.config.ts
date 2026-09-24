import { defineConfig } from "vitest/config";
import { tauriAliases } from "../packages/browser/vite-plugin.ts";

// The service worker, the offscreen document and the host run here against a
// fake `chrome.*` (test/fakeChrome.ts); the peer itself is packages/browser's.
export default defineConfig({
  resolve: { alias: tauriAliases },
  test: {
    include: ["test/**/*.test.ts"],
    // Each test boots the worker from fresh modules; the first boot of a file
    // transforms all of @ghostly/core, which takes a while on a cold cache.
    hookTimeout: 60_000,
  },
});
